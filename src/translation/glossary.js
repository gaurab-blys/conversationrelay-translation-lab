const fs = require('fs');
const path = require('path');
const AhoCorasick = require('modern-ahocorasick');

const GLOSSARY_PATH = path.join(__dirname, 'glossary.json');

/**
 * @typedef {object} GlossaryEntry
 * @property {string} term
 * @property {string[]} [aliases]
 * @property {string} [kind]
 * @property {boolean} [preserve]
 * @property {string} [sayAs]
 * @property {string} [note]
 */

/**
 * @returns {GlossaryEntry[]}
 */
const loadGlossary = () => {
  try {
    const raw = fs.readFileSync(GLOSSARY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
};

/**
 * @param {GlossaryEntry} entry
 * @returns {string[]}
 */
const termsForEntry = (entry) => {
  const terms = [entry.term, ...(entry.aliases || [])].filter(Boolean);
  return [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))];
};

/**
 * @param {string} phrase
 * @returns {string}
 */
const normalizePhrase = (phrase) =>
  String(phrase || '')
    .toLowerCase()
    .replace(/\s+/g, ' ');

/**
 * @param {string} text
 * @returns {string}
 */
const normalizeHaystack = (text) => normalizePhrase(text);

/**
 * @param {string} ch
 * @returns {boolean}
 */
const isLetter = (ch) => !!ch && /\p{L}/u.test(ch);

/**
 * Word-boundary check on a normalized haystack at [start, start+length).
 *
 * @param {string} haystack
 * @param {number} start
 * @param {number} length
 * @returns {boolean}
 */
const hasWordBoundary = (haystack, start, length) => {
  const before = start === 0 ? '' : haystack[start - 1];
  const after = haystack[start + length] || '';
  return !isLetter(before) && !isLetter(after);
};

/**
 * @param {string} phrase
 * @returns {RegExp}
 */
const phraseRegex = (phrase) => {
  const escaped = String(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const spaced = escaped.replace(/\s+/g, '\\s+');
  return new RegExp(`(?<!\\p{L})${spaced}(?!\\p{L})`, 'giu');
};

/**
 * Builds Aho-Corasick automaton and phrase -> glossary-entry lookup at startup.
 *
 * @param {GlossaryEntry[]} glossaryEntries
 * @returns {{
 *   phraseMatcher: import('modern-ahocorasick'),
 *   phraseByNormalized: Map<string, GlossaryEntry[]>,
 *   regexByPhrase: Map<string, RegExp> // lazily filled
 * }}
 */
const buildGlossaryIndex = (glossaryEntries) => {
  /** @type {Map<string, PhraseIndexItem[]>} */
  const phraseByNormalized = new Map();
  /** @type {Map<string, RegExp>} Lazily compiled on first use */
  const regexByPhrase = new Map();

  for (const entry of glossaryEntries) {
    const seen = new Set();
    for (const phrase of termsForEntry(entry)) {
      const normalized = normalizePhrase(phrase);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);

      if (!phraseByNormalized.has(normalized)) {
        phraseByNormalized.set(normalized, []);
      }
      phraseByNormalized.get(normalized).push(entry);
    }
  }

  const normalizedPatterns = [...phraseByNormalized.keys()];
  const phraseMatcher = new AhoCorasick(normalizedPatterns);

  return { phraseMatcher, phraseByNormalized, regexByPhrase };
};

const glossaryEntries = loadGlossary();
const { phraseMatcher, phraseByNormalized, regexByPhrase } = buildGlossaryIndex(glossaryEntries);

/** @type {Map<string, string[]>} */
const entryTermsSortedDescCache = new Map();
/** @type {Map<string, string[]>} */
const entryTermsCache = new Map();
/** @type {Map<string, string[]>} */
const entryAliasesSortedDescCache = new Map();

for (const entry of glossaryEntries) {
  const terms = termsForEntry(entry);
  entryTermsCache.set(entry.term, terms);
  entryTermsSortedDescCache.set(entry.term, [...terms].sort((a, b) => b.length - a.length));

  const aliases = (entry.aliases || [])
    .filter(Boolean)
    .map((a) => String(a).trim())
    .filter(Boolean)
    .filter((a) => a.toLowerCase() !== String(entry.term).toLowerCase())
    // Keep aliases even if they equal `sayAs`; those are needed for STT -> canonical replacement.
    ;

  entryAliasesSortedDescCache.set(entry.term, [...aliases].sort((a, b) => b.length - a.length));
}

/**
 * Returns precompiled word-boundary regex for a glossary phrase.
 *
 * @param {string} phrase
 * @returns {RegExp}
 */
const getPhraseRegex = (phrase) => {
  const cached = regexByPhrase.get(phrase);
  if (cached) return cached;
  const compiled = phraseRegex(phrase);
  regexByPhrase.set(phrase, compiled);
  return compiled;
};

/**
 * Glossary entries that appear in STT/TTS text (terms or aliases).
 * Uses Aho-Corasick for O(n) multi-pattern search, then word-boundary filtering.
 *
 * @param {string} text
 * @returns {GlossaryEntry[]}
 */
const findGlossaryMatches = (text) => {
  const haystack = normalizeHaystack(text);
  if (!haystack) return [];

  /** @type {Map<string, { entry: GlossaryEntry, matchedLength: number }>} */
  const matchedByTerm = new Map();

  // modern-ahocorasick reports the inclusive end index of each match, not the start.
  for (const [endIndex, patterns] of phraseMatcher.search(haystack)) {
    for (const normalized of patterns) {
      const matchStart = endIndex - normalized.length + 1;
      if (matchStart < 0 || !hasWordBoundary(haystack, matchStart, normalized.length)) continue;

      const items = phraseByNormalized.get(normalized) || [];
      for (const entry of items) {
        const existing = matchedByTerm.get(entry.term);
        if (!existing || normalized.length > existing.matchedLength) {
          matchedByTerm.set(entry.term, { entry, matchedLength: normalized.length });
        }
      }
    }
  }

  return [...matchedByTerm.values()]
    .sort((a, b) => b.matchedLength - a.matchedLength)
    .map(({ entry }) => entry);
};

/**
 * Replaces preserved glossary phrases with copy-through tokens so the model cannot translate them.
 *
 * @param {string} text
 * @returns {{ text: string, slots: Array<{ token: string, term: string, sayAs?: string }> }}
 */
const protectPreservedTerms = (text) => {
  let out = String(text || '');
  const slots = [];
  if (!out) return { text: out, slots };

  const matches = findGlossaryMatches(out).filter((entry) => entry.preserve !== false);
  let i = 0;
  for (const entry of matches) {
    const token = `__GLOSS_${i}__`;
    const phrases = entryTermsSortedDescCache.get(entry.term) || termsForEntry(entry).sort((a, b) => b.length - a.length);
    let replaced = false;
    for (const phrase of phrases) {
      const next = out.replace(getPhraseRegex(phrase), token);
      if (next !== out) {
        out = next;
        replaced = true;
      }
    }
    if (replaced) {
      slots.push({ token, term: entry.term, sayAs: entry.sayAs });
      i += 1;
    }
  }
  return { text: out, slots };
};

/**
 * Puts protected terms back after translation. Uses sayAs when present so TTS pronunciation is correct.
 *
 * @param {string} text
 * @param {Array<{ token: string, term: string, sayAs?: string }>} slots
 * @returns {string}
 */
const restorePreservedTerms = (text, slots) => {
  let out = String(text || '');
  if (!slots || !slots.length) return out;

  for (const slot of slots) {
    const spoken = slot.sayAs || slot.term;
    if (out.includes(slot.token)) {
      out = out.split(slot.token).join(spoken);
      continue;
    }
    const hasTerm = getPhraseRegex(slot.term).test(out);
    const hasSpoken = slot.sayAs ? getPhraseRegex(slot.sayAs).test(out) : false;
    if (!hasTerm && !hasSpoken) {
      out = `${out} ${spoken}`.trim();
    }
  }
  return out;
};

/**
 * Prompt block for terms found in this utterance only.
 *
 * @param {string} [text]
 * @param {Array<{ token: string, term: string, sayAs?: string }>} [slots]
 * @returns {string}
 */
const formatGlossaryForPrompt = (text, slots = []) => {
  if (slots.length) {
    const lines = [
      `Protected business names: copy each token into the output UNCHANGED. Do not translate these names into the target language. Keep them in English in both directions.`,
    ];
    for (const slot of slots) {
      const spoken = slot.sayAs ? ` Spoken form: "${slot.sayAs}".` : '';
      lines.push(`- ${slot.token} = "${slot.term}". Keep as English.${spoken}`);
    }
    return lines.join('\n');
  }

  const matches = findGlossaryMatches(text);
  if (!matches.length) return '';

  const lines = [
    `Protected business names (do not translate in either direction; keep the English wording):`,
  ];

  for (const entry of matches) {
    const kind = entry.kind || 'term';
    const aliases = (entry.aliases || []).filter(Boolean);
    const aliasText = aliases.length ? ` Also recognize: ${aliases.join(', ')}.` : '';
    const sayAs = entry.sayAs ? ` When speaking, pronounce it as "${entry.sayAs}".` : '';
    const note = entry.note ? ` ${entry.note}` : '';
    const keep = entry.preserve === false ? '' : ` Keep "${entry.term}" in English (do not translate).`;
    lines.push(`- [${kind}] ${entry.term}.${keep}${aliasText}${sayAs}${note}`);
  }

  return lines.join('\n');
};

/**
 * Applies spoken forms for glossary terms that appear in this TTS string.
 *
 * @param {string} text
 * @returns {string}
 */
const applySpokenForms = (text) => {
  let out = String(text || '');
  if (!out) return out;

  const matches = findGlossaryMatches(out);
  for (const entry of matches) {
    if (!entry.sayAs) continue;
    const sayAsLower = String(entry.sayAs).toLowerCase();
    const termsSorted = entryTermsSortedDescCache.get(entry.term) || termsForEntry(entry).sort((a, b) => b.length - a.length);
    for (const term of termsSorted) {
      if (term.toLowerCase() === sayAsLower) continue;
      out = out.replace(getPhraseRegex(term), entry.sayAs);
    }
  }
  return out;
};

/**
 * Strips glossary phrases that appear in this text (for script-mismatch checks).
 *
 * @param {string} text
 * @returns {string}
 */
const stripGlossaryTerms = (text) => {
  let out = String(text || '');
  const matches = findGlossaryMatches(out);
  const phrases = [];
  for (const entry of matches) {
    const terms = entryTermsCache.get(entry.term) || termsForEntry(entry);
    phrases.push(...terms);
    if (entry.sayAs) phrases.push(entry.sayAs);
  }
  phrases.sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    out = out.replace(getPhraseRegex(phrase), ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
};

/**
 * Rewrites STT aliases to the canonical glossary term (e.g. Bliss → Blys).
 *
 * @param {string} text
 * @returns {string}
 */
const canonicalizeGlossaryTerms = (text) => {
  let out = String(text || '');
  if (!out) return out;

  const matches = findGlossaryMatches(out);
  const replacements = [];
  for (const entry of matches) {
    const aliases = entryAliasesSortedDescCache.get(entry.term) || [];
    for (const alias of aliases) replacements.push({ from: alias, to: entry.term });
  }
  replacements.sort((a, b) => b.from.length - a.from.length);
  for (const { from, to } of replacements) {
    out = out.replace(getPhraseRegex(from), to);
  }
  return out;
};

module.exports = {
  applySpokenForms,
  canonicalizeGlossaryTerms,
  findGlossaryMatches,
  formatGlossaryForPrompt,
  glossaryEntries,
  protectPreservedTerms,
  restorePreservedTerms,
  stripGlossaryTerms,
};
