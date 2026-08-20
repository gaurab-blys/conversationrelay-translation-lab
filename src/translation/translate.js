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

      const prompt = [
        `You are translating real-time phone speech.`,
        `Style: casual conversational (friendly, natural, how a person would answer on a call).`,
        `Source language: ${sourceLanguage}`,
        `Target language: ${targetLanguage}`,
        `Requirements:`,
        `- Return ONLY the translated speech text.`,
        `- Preserve meaning, but make it sound natural for the target language.`,
        `- Add appropriate punctuation for speech (commas/periods) when needed.`,
        `- Do not add quotes, headings, or explanations.`,
        `- Keep the full meaning; do not summarize or omit later sentences.`,
        '',
        `Text: ${clean}`,
      ].join('\n');

      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.OPENAI_TRANSLATION_MODEL,
          input: prompt,
          // Ensure the response contains a text payload we can extract quickly.
          text: { format: { type: 'text' } },
          // Keep output compact since this gets turned into TTS.
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
      const translated = extractOutputText(payload);
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
};

