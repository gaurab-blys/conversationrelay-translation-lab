const fs = require('fs');
const path = require('path');

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

const glossaryEntries = loadGlossary();

/**
 * @param {GlossaryEntry} entry
 * @returns {string[]}
 */
const termsForEntry = (entry) => {
  const terms = [entry.term, ...(entry.aliases || [])].filter(Boolean);
  return [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))];
};

/** @type {Array<{ phrase: string, normalized: string, entry: GlossaryEntry }>} */
const phraseIndex = [];
for (const entry of glossaryEntries) {
  const seen = new Set();
  for (const phrase of termsForEntry(entry)) {
    const normalized = phrase.toLowerCase().replace(/\s+/g, ' ');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    phraseIndex.push({ phrase, normalized, entry });
  }
}
phraseIndex.sort((a, b) => b.normalized.length - a.normalized.length);

/**
 * @param {string} ch
 * @returns {boolean}
 */
const isLetter = (ch) => !!ch && /\p{L}/u.test(ch);

/**
 * @param {string} text
 * @returns {string}
 */
const normalizeHaystack = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ');

/**
 * Word-boundary phrase search on a normalized (lowercased, collapsed space) haystack.
 *
 * @param {string} haystack
 * @param {string} needle
 * @returns {boolean}
 */
const containsPhrase = (haystack, needle) => {
  if (!haystack || !needle) return false;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return false;
    const before = i === 0 ? '' : haystack[i - 1];
    const after = haystack[i + needle.length] || '';
    if (!isLetter(before) && !isLetter(after)) return true;
    from = i + 1;
  }
  return false;
};

/**
 * Glossary entries that appear in STT/TTS text (terms or aliases).
 *
 * @param {string} text
 * @returns {GlossaryEntry[]}
 */
const findGlossaryMatches = (text) => {
  const haystack = normalizeHaystack(text);
  if (!haystack) return [];

  const matched = [];
  const seen = new Set();
  for (const { normalized, entry } of phraseIndex) {
    if (seen.has(entry.term)) continue;
    if (!containsPhrase(haystack, normalized)) continue;
    seen.add(entry.term);
    matched.push(entry);
  }
  return matched;
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
    const phrases = termsForEntry(entry).slice().sort((a, b) => b.length - a.length);
    let replaced = false;
    for (const phrase of phrases) {
      const next = out.replace(phraseRegex(phrase), token);
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
    const hasTerm = phraseRegex(slot.term).test(out);
    const hasSpoken = slot.sayAs ? phraseRegex(slot.sayAs).test(out) : false;
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
  const replacements = [];
  for (const entry of matches) {
    if (!entry.sayAs) continue;
    for (const term of termsForEntry(entry)) {
      if (term.toLowerCase() === String(entry.sayAs).toLowerCase()) continue;
      replacements.push({ term, sayAs: entry.sayAs });
    }
  }
  replacements.sort((a, b) => b.term.length - a.term.length);
  for (const { term, sayAs } of replacements) {
    out = out.replace(phraseRegex(term), sayAs);
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
    phrases.push(...termsForEntry(entry));
    if (entry.sayAs) phrases.push(entry.sayAs);
  }
  phrases.sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    out = out.replace(phraseRegex(phrase), ' ');
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
    for (const alias of entry.aliases || []) {
      if (!alias || alias.toLowerCase() === entry.term.toLowerCase()) continue;
      replacements.push({ from: alias, to: entry.term });
    }
  }
  replacements.sort((a, b) => b.from.length - a.from.length);
  for (const { from, to } of replacements) {
    out = out.replace(phraseRegex(from), to);
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
