/**
 * ConversationRelay TTS voice catalog.
 *
 * Voice IDs match Twilio ConversationRelay defaults:
 * https://www.twilio.com/docs/voice/conversationrelay/voice-configuration
 *
 * ElevenLabs `voice` attribute format:
 *   {voiceId}[-{model}][-{speed}_{stability}_{similarity}]
 */

const ELEVENLABS_VOICES_BY_LANGUAGE = {
  'bg-BG': 'AB9XsbSA4eLG12t2myjN',
  'cs-CZ': 'uYFJyGaibp4N2VwYQshk',
  'da-DK': 'ygiXC2Oa1BiHksD3WkJZ',
  'de-DE': 'FTNCalFNG5bRnkkaP5Ug',
  'en-AU': '9Ft9sm9dzvprPILZmLJl',
  'en-GB': 'Fahco4VZzobUeiPqni1S',
  'en-IN': 'mCQMfsqGDT6IDkEKR20a',
  'en-US': 'UgBBYS2sOqTuMpoF3BR0',
  'es-ES': '6xftrpatV0jGmFHxDjUv',
  'es-US': 'CaJslL1xziwefCeTNzHv',
  'fi-FI': '6xPz2opT0y5qtoRh1U1Y',
  'fr-CA': 'IPgYtHTNLjC7Bq7IPHrm',
  'fr-FR': 'a5n9pJUnAhX4fn7lx3uo',
  'hi-IN': 'IvLWq57RKibBrqZGpQrC',
  'hu-HU': 'TumdjBNWanlT3ysvclWh',
  'id-ID': '1k39YpzqXZn52BgyLyGO',
  'it-IT': 'uScy1bXtKz8vPzfdFsFw',
  'ja-JP': '3JDquces8E8bkmvbh6Bc',
  'ko-KR': 'uyVNoMrnUku1dZyVEXwD',
  'nl-BE': 's7Z6uboUuE4Nd8Q2nye6',
  'nl-NL': 'UNBIyLbtFB9k7FKW8wJv',
  'pl-PL': 'W0sqKm1Sfw1EzlCH14FQ',
  'pt-BR': 'CstacWqMhJQlnfLPxRG4',
  'pt-PT': 'TsZfI8Nbn2Xd7ArC76n9',
  'ro-RO': 'OlBp4oyr3FBAGEAtJOnU',
  'ru-RU': 'AB9XsbSA4eLG12t2myjN',
  'sv-SE': '4xkUqaR9MYOJHoaC1Nak',
  'ta-IN': 'ZhJ5LanYnCmLKQUXvsV7',
  'tr-TR': 'IuRRIAcbQK5AQk1XevPj',
  'uk-UA': 'nCqaTnIbLdME87OuQaZY',
  'vi-VN': 'foH7s9fX31wFFH2yqrFa',
};

/**
 * Accent aliases → ConversationRelay locale, keyed by language prefix.
 * Example: Hindi + `in` → `hi-IN`; English + `gb` → `en-GB`.
 */
const ACCENT_TO_LANGUAGE_BY_PREFIX = {
  en: {
    us: 'en-US',
    usa: 'en-US',
    american: 'en-US',
    gb: 'en-GB',
    uk: 'en-GB',
    british: 'en-GB',
    au: 'en-AU',
    australian: 'en-AU',
    in: 'en-IN',
    indian: 'en-IN',
  },
  es: {
    es: 'es-ES',
    us: 'es-US',
    mx: 'es-US',
  },
  fr: {
    fr: 'fr-FR',
    ca: 'fr-CA',
  },
  pt: {
    br: 'pt-BR',
    pt: 'pt-PT',
  },
  nl: {
    nl: 'nl-NL',
    be: 'nl-BE',
  },
  hi: {
    in: 'hi-IN',
    indian: 'hi-IN',
  },
};

/** @deprecated use ACCENT_TO_LANGUAGE_BY_PREFIX.en */
const ENGLISH_ACCENT_TO_LANGUAGE = ACCENT_TO_LANGUAGE_BY_PREFIX.en;

const GOOGLE_CHIRP_VOICE_NAME = 'Aoede';

const GOOGLE_STANDARD_FALLBACK = {
  'kn-IN': 'kn-IN-Standard-A',
  'ml-IN': 'ml-IN-Standard-A',
  'mr-IN': 'mr-IN-Standard-A',
  'te-IN': 'te-IN-Standard-A',
  'th-TH': 'th-TH-Standard-A',
};

/**
 * @param {string} language
 * @returns {string}
 */
const normalizeLanguage = (language) => String(language || '').trim() || 'en-US';

/**
 * @param {string} language
 * @returns {string}
 */
const languagePrefix = (language) => normalizeLanguage(language).split('-')[0].toLowerCase();

/**
 * @param {string} accent
 * @returns {string}
 */
const normalizeAccent = (accent) =>
  String(accent || '')
    .trim()
    .toLowerCase();

/**
 * @param {string} accent
 * @returns {string|null} BCP-47 language tag, or null if accent is empty/unknown.
 */
const resolveEnglishAccentLanguage = (accent) => {
  const key = normalizeAccent(accent);
  if (!key) return null;
  return ACCENT_TO_LANGUAGE_BY_PREFIX.en[key] || null;
};

/**
 * Picks the TTS language tag used for voice lookup (accent remaps within a language family).
 *
 * @param {string} language
 * @param {string} [accent]
 * @returns {string}
 */
const resolveTtsLanguage = (language, accent) => {
  const lang = normalizeLanguage(language);
  const key = normalizeAccent(accent);
  if (!key) return lang;

  const prefix = languagePrefix(lang);
  if (key.includes('-')) {
    if (!key.startsWith(`${prefix}-`) && key !== prefix) return lang;
    const match = Object.keys(ELEVENLABS_VOICES_BY_LANGUAGE).find(
      (code) => code.toLowerCase() === key
    );
    return match || lang;
  }

  return ACCENT_TO_LANGUAGE_BY_PREFIX[prefix]?.[key] || lang;
};

/**
 * @param {string} language
 * @returns {string}
 */
const googleVoiceForLanguage = (language) => {
  const lang = normalizeLanguage(language);
  if (GOOGLE_STANDARD_FALLBACK[lang]) return GOOGLE_STANDARD_FALLBACK[lang];
  return `${lang}-Chirp3-HD-${GOOGLE_CHIRP_VOICE_NAME}`;
};

/**
 * @param {string} language
 * @param {string} [englishAccent]
 * @returns {string} ElevenLabs voice ID
 */
const elevenLabsVoiceIdForLanguage = (language, englishAccent) => {
  const ttsLang = resolveTtsLanguage(language, englishAccent);
  if (ELEVENLABS_VOICES_BY_LANGUAGE[ttsLang]) {
    return ELEVENLABS_VOICES_BY_LANGUAGE[ttsLang];
  }
  const prefix = ttsLang.split('-')[0].toLowerCase();
  const match = Object.keys(ELEVENLABS_VOICES_BY_LANGUAGE).find((code) =>
    code.toLowerCase().startsWith(`${prefix}-`)
  );
  return ELEVENLABS_VOICES_BY_LANGUAGE[match] || ELEVENLABS_VOICES_BY_LANGUAGE['en-US'];
};

/**
 * Builds the ConversationRelay `voice` attribute for a language.
 *
 * @param {object} options
 * @param {string} options.language
 * @param {string} [options.provider]
 * @param {string} [options.accent]
 * @param {string} [options.englishAccent] - Alias of `accent`.
 * @param {string} [options.voiceId] - Explicit override (ElevenLabs ID or Google/Amazon name).
 * @param {string} [options.model] - ElevenLabs model (flash_v2_5, turbo_v2_5, …).
 * @param {number|string} [options.speed]
 * @param {number|string} [options.stability]
 * @param {number|string} [options.similarity]
 * @returns {string}
 */
const buildVoiceAttribute = ({
  language,
  provider = 'ElevenLabs',
  accent,
  englishAccent,
  voiceId,
  model = 'flash_v2_5',
  speed = 1.0,
  stability = 0.6,
  similarity = 0.8,
} = {}) => {
  const ttsProvider = String(provider || 'ElevenLabs');
  const resolvedAccent = accent || englishAccent;
  const ttsLang = resolveTtsLanguage(language, resolvedAccent);

  if (ttsProvider.toLowerCase() === 'google') {
    return voiceId || googleVoiceForLanguage(ttsLang);
  }

  if (ttsProvider.toLowerCase() === 'amazon') {
    return voiceId || 'Joanna-Neural';
  }

  const id = voiceId || elevenLabsVoiceIdForLanguage(language, resolvedAccent);
  const modelId = String(model || '').trim();
  if (!modelId) return id;
  return `${id}-${modelId}-${speed}_${stability}_${similarity}`;
};

module.exports = {
  ACCENT_TO_LANGUAGE_BY_PREFIX,
  ELEVENLABS_VOICES_BY_LANGUAGE,
  ENGLISH_ACCENT_TO_LANGUAGE,
  buildVoiceAttribute,
  elevenLabsVoiceIdForLanguage,
  googleVoiceForLanguage,
  resolveEnglishAccentLanguage,
  resolveTtsLanguage,
};
