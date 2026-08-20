const logger = require('../logger');
const config = require('../config');
const {
  applySpokenForms,
  canonicalizeGlossaryTerms,
  formatGlossaryForPrompt,
  protectPreservedTerms,
  restorePreservedTerms,
  stripGlossaryTerms,
} = require('./glossary');

// Very small in-memory cache to avoid repeating translations for common short phrases.
// This is per-process (ok for a dev lab) and keeps latency down.
const cache = new Map(); // key -> { value, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_ITEMS = 500;

/** Minimum output/input char ratio before we treat a translation as suspiciously truncated. */
const SHORT_OUTPUT_RATIO = 0.25;
/** Absolute floor: very short inputs are allowed to stay short. */
const SHORT_OUTPUT_MIN_INPUT_CHARS = 40;

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
 * - Strips surrounding quotes if the model included them
 * - Adds terminal punctuation only when this is the final speech token in a talk cycle
 *
 * @param {string} s
 * @param {{ final?: boolean }} [options]
 * @returns {string}
 */
const toSpeechReadyText = (s, options = {}) => {
  const final = options.final !== false;
  let out = String(s || '').trim();
  if (!out) return '';

  // Collapse repeated whitespace/newlines.
  out = out.replace(/\s+/g, ' ');

  // Remove surrounding quotes the model might return.
  out = out.replace(/^["']|["']$/g, '');

  out = applySpokenForms(out);

  // Only punctuate the end of a talk cycle. Mid-stream segments must stay open so
  // ConversationRelay can continue the same utterance without restarting cadence.
  if (final && !/[.!?。！？]$/.test(out)) out += '.';

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
 * True when the output never switched into the target script (still fully in the source language).
 * Mixed output is allowed: a word may be kept in the source language when translating it would change the meaning.
 *
 * @param {string} text
 * @param {string} targetLanguage
 * @param {string} [sourceLanguage]
 * @returns {boolean}
 */
const hasWrongScriptForTarget = (text, targetLanguage, sourceLanguage) => {
  const value = stripGlossaryTerms(String(text || '').replace(/__GLOSS_\d+__/g, ' '));
  if (!value) return false;

  const targetScripts = scriptsForLanguage(targetLanguage);
  const sourceScripts = scriptsForLanguage(sourceLanguage || '');
  const sourceOnlyScripts = sourceScripts.filter((script) => !targetScripts.includes(script));

  const usesTargetScript = targetScripts.some(
    (script) => SCRIPT_RANGES[script] && SCRIPT_RANGES[script].test(value)
  );
  const usesSourceOnlyScript = sourceOnlyScripts.some(
    (script) => SCRIPT_RANGES[script] && SCRIPT_RANGES[script].test(value)
  );

  return usesSourceOnlyScript && !usesTargetScript;
};

/**
 * @param {object} params
 * @param {string} params.text
 * @param {string} params.sourceLanguage
 * @param {string} params.targetLanguage
 * @param {boolean} [params.strict]
 * @returns {string}
 */
const buildTranslationPrompt = ({
  text,
  sourceLanguage,
  targetLanguage,
  strict = false,
  slots = [],
}) => {
  const sourceName = languageDisplayName(sourceLanguage);
  const targetName = languageDisplayName(targetLanguage);
  const lines = [
    `You are translating real-time phone speech between two people.`,
    `Style: casual conversational (friendly, natural, how a person would speak on a call).`,
    `Source language: ${sourceName} (${sourceLanguage})`,
    `Target language: ${targetName} (${targetLanguage})`,
    `Requirements:`,
    `- Return ONLY the translated speech (no quotes, headings, or explanations).`,
    `- Prefer ${targetName} for the utterance, including dates, times, numbers, money, addresses, weekdays, months, and years.`,
    `- Say dates and numbers the way a native ${targetName} speaker would say them aloud.`,
    `- Mixing languages is preferred when a word would change meaning if translated (false friends, domain terms, or words whose native sense differs in ${targetName}). Keep that word in the source language.`,
    `- Always copy protected English business names/tokens listed below unchanged.`,
    `- Otherwise preserve meaning and sound natural for a phone call in ${targetName}.`,
    `- Add appropriate punctuation for speech (commas/periods) when needed.`,
    `- Keep the full meaning; do not summarize or omit later sentences.`,
  ];
  const glossaryBlock = formatGlossaryForPrompt(text, slots);
  if (glossaryBlock) {
    lines.push(glossaryBlock);
  }
  if (strict) {
    lines.push(
      `- Previous output never used ${targetName}. Translate into ${targetName}, keep meaning-critical source words if translating them would change the sense, and copy any __GLOSS_n__ tokens unchanged.`
    );
  }
  lines.push('', `Text: ${text}`);
  return lines.join('\n');
};

/**
 * True when the model returned far less text than the source (classic reasoning-budget truncation).
 *
 * @param {string} input
 * @param {string} output
 * @returns {boolean}
 */
const isSuspiciouslyShortTranslation = (input, output) => {
  const inLen = String(input || '').trim().length;
  const outLen = String(output || '').trim().length;
  if (inLen < SHORT_OUTPUT_MIN_INPUT_CHARS) return false;
  if (!outLen) return true;
  return outLen / inLen < SHORT_OUTPUT_RATIO;
};

/**
 * @param {object} payload
 * @returns {{ text: string, incomplete: boolean, reason: string|undefined, usage: object|undefined }}
 */
const extractTranslationResult = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return { text: '', incomplete: true, reason: 'empty_payload', usage: undefined };
  }

  let text = '';
  if (typeof payload.output_text === 'string') {
    text = payload.output_text.trim();
  } else {
    const outputs = Array.isArray(payload.output) ? payload.output : [];
    for (const item of outputs) {
      if (!item || typeof item !== 'object') continue;
      if (item.type !== 'message') continue;
      const content = Array.isArray(item.content) ? item.content : [];
      for (const c of content) {
        if (c && c.type === 'output_text' && typeof c.text === 'string') {
          text += c.text;
        }
      }
    }
    text = text.trim();
  }

  const status = payload.status;
  const reason =
    (payload.incomplete_details && payload.incomplete_details.reason) ||
    (status === 'incomplete' ? 'incomplete' : undefined);
  const incomplete =
    status === 'incomplete' ||
    reason === 'max_output_tokens' ||
    (!text &&
      Array.isArray(payload.output) &&
      payload.output.some((o) => o && o.type === 'reasoning'));

  return { text, incomplete: !!incomplete, reason, usage: payload.usage };
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
 * @param {boolean} [params.speechFinal=true] - When false, skip forced trailing punctuation (segment streaming).
 * @returns {Promise<string>}
 * @throws {Error} When the configured translation provider is missing/unsupported or API calls fail.
 */
const translateText = async ({ text, sourceLanguage, targetLanguage, speechFinal = true }) => {
  const clean = String(text || '');

  switch (config.TRANSLATION_PROVIDER) {
    case 'stub':
      // Make it obvious in audio that we are doing "something" without calling external services.
      return `(${targetLanguage}) ${clean}`;
    case 'openai': {
      const prepared = canonicalizeGlossaryTerms(String(text || ''));
      const protectedInput = protectPreservedTerms(prepared);
      const cacheKey = `${sourceLanguage}->${targetLanguage}:${prepared}:final=${speechFinal ? 1 : 0}`;
      const cached = getCached(cacheKey);
      if (cached) return cached;

      const apiKey = config.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY missing');
      }

      /**
       * @param {string} prompt
       * @param {number} maxOutputTokens
       * @returns {Promise<{ text: string, incomplete: boolean, reason: string|undefined, usage: object|undefined }>}
       */
      const requestTranslation = async (prompt, maxOutputTokens) => {
        const body = {
          model: config.OPENAI_TRANSLATION_MODEL,
          input: prompt,
          text: { format: { type: 'text' } },
          max_output_tokens: maxOutputTokens,
        };
        // Reasoning models (gpt-5.x) burn max_output_tokens on thinking first.
        // Keep effort low for realtime voice so visible translation tokens remain.
        if (config.OPENAI_REASONING_EFFORT) {
          body.reasoning = { effort: config.OPENAI_REASONING_EFFORT };
        }

        const res = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          const message =
            errBody?.error?.message ||
            errBody?.message ||
            `OpenAI request failed with status ${res.status}`;
          throw new Error(message);
        }

        const payload = await res.json();
        return extractTranslationResult(payload);
      };

      /**
       * Runs translation and retries once with a larger token budget if reasoning ate the output.
       *
       * @param {object} promptParams
       * @returns {Promise<string>}
       */
      const translateWithBudget = async (promptParams) => {
        const prompt = buildTranslationPrompt(promptParams);
        let maxTokens = config.OPENAI_MAX_OUTPUT_TOKENS;
        let result = await requestTranslation(prompt, maxTokens);
        let translated = restorePreservedTerms(result.text, protectedInput.slots);

        const needsRetry =
          result.incomplete || isSuspiciouslyShortTranslation(prepared, translated);

        if (needsRetry) {
          const retryTokens = Math.max(maxTokens * 2, 4000);
          logger.warn('[translate] short/incomplete OpenAI output; retrying with higher budget', {
            inputChars: prepared.length,
            outputChars: translated.length,
            incomplete: result.incomplete,
            reason: result.reason,
            usage: result.usage,
            maxTokens,
            retryTokens,
          });
          result = await requestTranslation(prompt, retryTokens);
          translated = restorePreservedTerms(result.text, protectedInput.slots);
        }

        return translated;
      };

      let translated = await translateWithBudget({
        text: protectedInput.text,
        sourceLanguage,
        targetLanguage,
        slots: protectedInput.slots,
      });

      if (translated && hasWrongScriptForTarget(translated, targetLanguage, sourceLanguage)) {
        translated = await translateWithBudget({
          text: protectedInput.text,
          sourceLanguage,
          targetLanguage,
          strict: true,
          slots: protectedInput.slots,
        });
      }

      const speechReady = toSpeechReadyText(translated, { final: speechFinal });
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
  isSuspiciouslyShortTranslation,
};

