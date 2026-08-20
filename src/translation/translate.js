const config = require('../config');

// Very small in-memory cache to avoid repeating translations for common short phrases.
// This is per-process (ok for a dev lab) and keeps latency down.
const cache = new Map(); // key -> { value, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_ITEMS = 500;

/**
 * Gets a cached translation result.
 * @param {string} key
 * @returns {string|undefined}
 */
const getCached = (key) => {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
};

/**
 * Stores a translation result in the cache.
 * @param {string} key
 * @param {string} value
 */
const setCached = (key, value) => {
  // Best-effort cap: if we're too big, clear oldest-ish by insertion order.
  if (cache.size >= CACHE_MAX_ITEMS) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
};

/**
 * Post-processes translated text to be more suitable for TTS playback.
 *
 * - Trims and collapses whitespace
 * - Ensures the text ends with terminal punctuation (if non-empty)
 * - Strips surrounding quotes if the model included them
 *
 * @param {string} s
 * @returns {string}
 */
const toSpeechReadyText = (s) => {
  let out = String(s || '').trim();
  if (!out) return '';

  // Collapse repeated whitespace/newlines.
  out = out.replace(/\s+/g, ' ');

  // Remove surrounding quotes the model might return.
  out = out.replace(/^["']|["']$/g, '');

  // Ensure a terminal punctuation mark helps TTS cadence.
  if (!/[.!?。！？]$/.test(out)) out += '.';

  return out.trim();
};

const LANGUAGE_NAMES = {
  ar: 'Arabic',
  bg: 'Bulgarian',
  cs: 'Czech',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  fi: 'Finnish',
  fr: 'French',
  hi: 'Hindi',
  hu: 'Hungarian',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  kn: 'Kannada',
  ko: 'Korean',
  ml: 'Malayalam',
  mr: 'Marathi',
  nl: 'Dutch',
  pl: 'Polish',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sv: 'Swedish',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  vi: 'Vietnamese',
  zh: 'Chinese',
};

const SCRIPT_RANGES = {
  latin: /[A-Za-z\u00C0-\u024F]/,
  greek: /[\u0370-\u03FF]/,
  cyrillic: /[\u0400-\u04FF]/,
  arabic: /[\u0600-\u06FF]/,
  devanagari: /[\u0900-\u097F]/,
  bengali: /[\u0980-\u09FF]/,
  tamil: /[\u0B80-\u0BFF]/,
  telugu: /[\u0C00-\u0C7F]/,
  kannada: /[\u0C80-\u0CFF]/,
  malayalam: /[\u0D00-\u0D7F]/,
  thai: /[\u0E00-\u0E7F]/,
  hangul: /[\uAC00-\uD7AF]/,
  hiragana: /[\u3040-\u309F]/,
  katakana: /[\u30A0-\u30FF]/,
  han: /[\u4E00-\u9FFF]/,
};

const LANGUAGE_SCRIPTS = {
  ar: ['arabic'],
  bg: ['cyrillic'],
  cs: ['latin'],
  da: ['latin'],
  de: ['latin'],
  el: ['greek'],
  en: ['latin'],
  es: ['latin'],
  fi: ['latin'],
  fr: ['latin'],
  hi: ['devanagari'],
  hu: ['latin'],
  id: ['latin'],
  it: ['latin'],
  ja: ['hiragana', 'katakana', 'han'],
  kn: ['kannada'],
  ko: ['hangul', 'han'],
  ml: ['malayalam'],
  mr: ['devanagari'],
  nl: ['latin'],
  pl: ['latin'],
  pt: ['latin'],
  ro: ['latin'],
  ru: ['cyrillic'],
  sv: ['latin'],
  ta: ['tamil'],
  te: ['telugu'],
  th: ['thai'],
  tr: ['latin'],
  uk: ['cyrillic'],
  vi: ['latin'],
  zh: ['han'],
};

/**
 * @param {string} language
 * @returns {string}
 */
const languagePrefix = (language) =>
  String(language || '')
    .split('-')[0]
    .toLowerCase();

/**
 * @param {string} language
 * @returns {string}
 */
const languageDisplayName = (language) => {
  const prefix = languagePrefix(language);
  return LANGUAGE_NAMES[prefix] || prefix || 'the target language';
};

/**
 * @param {string} language
 * @returns {string[]}
 */
const scriptsForLanguage = (language) => LANGUAGE_SCRIPTS[languagePrefix(language)] || ['latin'];

/**
 * True when output still uses a source-language script that the target language does not use.
 *
 * @param {string} text
 * @param {string} targetLanguage
 * @param {string} [sourceLanguage]
 * @returns {boolean}
 */
const hasWrongScriptForTarget = (text, targetLanguage, sourceLanguage) => {
  const value = String(text || '');
  if (!value) return false;

  const targetScripts = scriptsForLanguage(targetLanguage);
  const sourceScripts = scriptsForLanguage(sourceLanguage || '');
  const sourceOnlyScripts = sourceScripts.filter((script) => !targetScripts.includes(script));

  if (sourceOnlyScripts.some((script) => SCRIPT_RANGES[script] && SCRIPT_RANGES[script].test(value))) {
    return true;
  }

  const usesTargetScript = targetScripts.some(
    (script) => SCRIPT_RANGES[script] && SCRIPT_RANGES[script].test(value)
  );
  const targetIsNonLatin = !targetScripts.includes('latin');
  const sourceIsLatin = sourceScripts.includes('latin') && sourceScripts.every((s) => s === 'latin');
  if (targetIsNonLatin && sourceIsLatin && !usesTargetScript && SCRIPT_RANGES.latin.test(value)) {
    return true;
  }

  return false;
};

/**
 * @param {object} params
 * @param {string} params.text
 * @param {string} params.sourceLanguage
 * @param {string} params.targetLanguage
 * @param {boolean} [params.strict]
 * @returns {string}
 */
const buildTranslationPrompt = ({ text, sourceLanguage, targetLanguage, strict = false }) => {
  const sourceName = languageDisplayName(sourceLanguage);
  const targetName = languageDisplayName(targetLanguage);
  const lines = [
    `You are translating real-time phone speech between two people.`,
    `Style: casual conversational (friendly, natural, how a person would speak on a call).`,
    `Source language: ${sourceName} (${sourceLanguage})`,
    `Target language: ${targetName} (${targetLanguage})`,
    `Requirements:`,
    `- Return ONLY the translated speech text in ${targetName}.`,
    `- The entire utterance must be ${targetName}: words, dates, times, numbers, money, addresses, weekdays, months, and years.`,
    `- Say dates and numbers the way a native ${targetName} speaker would say them aloud, not as leftover source-language words or source script.`,
    `- Do not mix languages. If the speaker code-switches, still output only ${targetName}.`,
    `- Preserve meaning, but make it sound natural for ${targetName}.`,
    `- Add appropriate punctuation for speech (commas/periods) when needed.`,
    `- Do not add quotes, headings, or explanations.`,
    `- Keep the full meaning; do not summarize or omit later sentences.`,
  ];
  if (strict) {
    lines.push(
      `- Previous output was still in the source language or script. Translate every part fully into ${targetName} now.`
    );
  }
  lines.push('', `Text: ${text}`);
  return lines.join('\n');
};

/**
 * Translates a piece of text from one language to another.
 *
 * For the lab, `stub` just passes through (with optional prefix) so the bridging flow can be validated.
 *
 * @param {object} params
 * @param {string} params.text
 * @param {string} params.sourceLanguage
 * @param {string} params.targetLanguage
 * @returns {Promise<string>}
 * @throws {Error} When the configured translation provider is missing/unsupported or API calls fail.
 */
const translateText = async ({ text, sourceLanguage, targetLanguage }) => {
  const clean = String(text || '');

  switch (config.TRANSLATION_PROVIDER) {
    case 'stub':
      // Make it obvious in audio that we are doing "something" without calling external services.
      return `(${targetLanguage}) ${clean}`;
    case 'openai': {
      const cacheKey = `${sourceLanguage}->${targetLanguage}:${clean}`;
      const cached = getCached(cacheKey);
      if (cached) return cached;

      const apiKey = config.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY missing');
      }

      const extractOutputText = (payload) => {
        if (!payload || typeof payload !== 'object') return '';

        if (typeof payload.output_text === 'string') return payload.output_text.trim();

        const outputs = Array.isArray(payload.output) ? payload.output : [];
        let out = '';

        for (const item of outputs) {
          if (!item || typeof item !== 'object') continue;
          if (item.type !== 'message') continue;

          const content = Array.isArray(item.content) ? item.content : [];
          for (const c of content) {
            if (c && c.type === 'output_text' && typeof c.text === 'string') {
              out += c.text;
            }
          }
        }

        return out.trim();
      };

      /**
       * @param {string} prompt
       * @returns {Promise<string>}
       */
      const requestTranslation = async (prompt) => {
        const res = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: config.OPENAI_TRANSLATION_MODEL,
            input: prompt,
            text: { format: { type: 'text' } },
            max_output_tokens: config.OPENAI_MAX_OUTPUT_TOKENS,
          }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const message =
            body?.error?.message ||
            body?.message ||
            `OpenAI request failed with status ${res.status}`;
          throw new Error(message);
        }

        const payload = await res.json();
        return extractOutputText(payload);
      };

      let translated = await requestTranslation(
        buildTranslationPrompt({
          text: clean,
          sourceLanguage,
          targetLanguage,
        })
      );

      if (translated && hasWrongScriptForTarget(translated, targetLanguage, sourceLanguage)) {
        translated = await requestTranslation(
          buildTranslationPrompt({
            text: clean,
            sourceLanguage,
            targetLanguage,
            strict: true,
          })
        );
      }

      const speechReady = toSpeechReadyText(translated);
      if (speechReady) setCached(cacheKey, speechReady);
      return speechReady;
    }
    default:
      throw new Error(`Unsupported TRANSLATION_PROVIDER: ${config.TRANSLATION_PROVIDER}`);
  }
};

module.exports = {
  translateText,
  buildTranslationPrompt,
  hasWrongScriptForTarget,
  languageDisplayName,
};

