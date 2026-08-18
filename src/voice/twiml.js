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
 * @param {Record<string, string>} params.customParameters
 * @returns {string} TwiML XML string.
 */
const buildConversationRelayConnectTwiml = ({
  connectActionUrl,
  conversationRelayWsUrl,
  welcomeGreeting,
  sourceLanguage,
  targetLanguage,
  customParameters,
}) => {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

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
    ` interruptible="true"`,
    ` interruptByDtmf="true"`,
    ` dtmfDetection="true">`,
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
};

