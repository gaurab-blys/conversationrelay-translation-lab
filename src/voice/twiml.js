const config = require('../config');
const { buildVoiceAttribute } = require('./ttsVoices');

/**
 * Escape text for use inside XML attribute values.
 *
 * @param {unknown} s
 * @returns {string}
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Opposite ConversationRelay role in a 2-party session.
 *
 * @param {'a'|'b'} role
 * @returns {'a'|'b'}
 */
const oppositeRole = (role) => (role === 'b' ? 'a' : 'b');

/**
 * Accent used for the TTS this role hears.
 *
 * @param {'a'|'b'} role
 * @returns {string}
 */
const accentForRole = (role) =>
  role === 'b' ? config.TTS_ACCENT_B || config.TTS_EN_ACCENT : config.TTS_ACCENT_A || config.TTS_EN_ACCENT;

/**
 * Optional explicit voice ID from env for a language.
 *
 * @param {string} language
 * @returns {string}
 */
const voiceOverrideForLanguage = (language) => {
  const lang = String(language || '').toLowerCase();
  if (lang.startsWith('en') && config.TTS_VOICE_EN) return config.TTS_VOICE_EN;
  if (lang.startsWith('hi') && config.TTS_VOICE_HI) return config.TTS_VOICE_HI;
  return '';
};

/**
 * Optional explicit voice ID for what this role hears (wins over language overrides).
 *
 * @param {'a'|'b'} role
 * @returns {string}
 */
const voiceOverrideForRole = (role) =>
  role === 'b' ? config.TTS_VOICE_B || '' : config.TTS_VOICE_A || '';

/**
 * ConversationRelay `voice` value for a language as heard by a given role.
 *
 * @param {string} language
 * @param {'a'|'b'} [role]
 * @returns {string}
 */
const voiceForLanguage = (language, role = 'a') =>
  buildVoiceAttribute({
    language,
    provider: config.TTS_PROVIDER,
    accent: accentForRole(role),
    voiceId: voiceOverrideForRole(role) || voiceOverrideForLanguage(language) || undefined,
    model: config.TTS_ELEVENLABS_MODEL,
    speed: config.TTS_ELEVENLABS_SPEED,
    stability: config.TTS_ELEVENLABS_STABILITY,
    similarity: config.TTS_ELEVENLABS_SIMILARITY,
  });

/**
 * Nested `<Language>` so each side of the pair uses that role's accent.
 *
 * @param {string} sourceLanguage
 * @param {string} targetLanguage
 * @param {'a'|'b'} role
 * @param {string} ttsProvider
 * @returns {string}
 */
const buildLanguageElements = (sourceLanguage, targetLanguage, role, ttsProvider) => {
  const entries = [
    { code: targetLanguage, forRole: role },
    { code: sourceLanguage, forRole: oppositeRole(role) },
  ];
  const seen = new Set();
  return entries
    .filter(({ code }) => {
      const key = String(code || '').toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(
      ({ code, forRole }) =>
        `<Language code="${esc(code)}" ttsProvider="${esc(ttsProvider)}" voice="${esc(
          voiceForLanguage(code, forRole)
        )}" />`
    )
    .join('');
};

/**
 * Builds TwiML that connects a call leg to Twilio ConversationRelay.
 *
 * The Twilio Node SDK does not yet have a native helper for <ConversationRelay>,
 * so we construct the XML directly.
 *
 * @param {object} params
 * @param {string} params.connectActionUrl
 * @param {string} params.conversationRelayWsUrl
 * @param {string} params.welcomeGreeting
 * @param {string} params.sourceLanguage - STT language for this caller leg.
 * @param {string} params.targetLanguage - TTS language for what this leg hears.
 * @param {'a'|'b'} [params.role]
 * @param {Record<string, string>} params.customParameters
 * @returns {string} TwiML XML string.
 */
const buildConversationRelayConnectTwiml = ({
  connectActionUrl,
  conversationRelayWsUrl,
  welcomeGreeting,
  sourceLanguage,
  targetLanguage,
  role = 'a',
  customParameters,
}) => {
  const ttsProvider = config.TTS_PROVIDER || 'ElevenLabs';
  const ttsVoice = voiceForLanguage(targetLanguage, role);
  const languageElements = buildLanguageElements(
    sourceLanguage,
    targetLanguage,
    role,
    ttsProvider
  );

  const extraAttrs = [];
  extraAttrs.push(` ttsProvider="${esc(ttsProvider)}"`);
  extraAttrs.push(` voice="${esc(ttsVoice)}"`);
  if (String(ttsProvider).toLowerCase() === 'elevenlabs') {
    extraAttrs.push(` elevenlabsTextNormalization="${esc(config.ELEVENLABS_TEXT_NORMALIZATION)}"`);
  }

  const paramEntries = Object.entries(customParameters || {})
    .map(([name, value]) => `<Parameter name="${esc(name)}" value="${esc(value)}" />`)
    .join('');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `<Connect action="${esc(connectActionUrl)}">`,
    `<ConversationRelay url="${esc(conversationRelayWsUrl)}"`,
    ` welcomeGreeting="${esc(welcomeGreeting)}"`,
    ` transcriptionLanguage="${esc(sourceLanguage)}"`,
    ` ttsLanguage="${esc(targetLanguage)}"`,
    extraAttrs.join(''),
    ` interruptible="true"`,
    ` interruptByDtmf="true"`,
    ` dtmfDetection="true">`,
    languageElements,
    paramEntries,
    '</ConversationRelay>',
    '</Connect>',
    '</Response>',
  ].join('');
};

/**
 * Convenience wrapper for building TwiML for a single side of a 2-party translation session.
 *
 * @param {object} params
 * @param {string} params.pairId - Shared across both legs.
 * @param {'a'|'b'} params.role - Which caller side this TwiML is for.
 * @param {string} params.sourceLanguage
 * @param {string} params.targetLanguage
 * @param {string} params.connectActionUrl
 * @param {string} params.conversationRelayWsUrl
 * @returns {string}
 */
const buildLegTwiML = ({
  pairId,
  role,
  sourceLanguage,
  targetLanguage,
  connectActionUrl,
  conversationRelayWsUrl,
}) => {
  return buildConversationRelayConnectTwiml({
    connectActionUrl,
    conversationRelayWsUrl,
    welcomeGreeting: 'Connecting you to a translator…',
    sourceLanguage,
    targetLanguage,
    role,
    customParameters: {
      pairId,
      role,
      sourceLanguage,
      targetLanguage,
    },
  });
};

module.exports = {
  buildConversationRelayConnectTwiml,
  buildLegTwiML,
  voiceForLanguage,
};
