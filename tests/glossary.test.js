const {
  applySpokenForms,
  canonicalizeGlossaryTerms,
  findGlossaryMatches,
  formatGlossaryForPrompt,
  protectPreservedTerms,
  restorePreservedTerms,
  stripGlossaryTerms,
} = require('../src/translation/glossary');
const { hasWrongScriptForTarget } = require('../src/translation/translate');

describe('glossary matching', () => {
  it('finds only terms present in the utterance', () => {
    const hits = findGlossaryMatches('Can I book Blys for Gaurab?');
    expect(hits.map((e) => e.term).sort()).toEqual(['Blys', 'Gaurab']);
    expect(formatGlossaryForPrompt('Can I book Blys for Gaurab?')).toContain('Blys');
    expect(formatGlossaryForPrompt('Can I book Blys for Gaurab?')).toContain('Gaurab');
    expect(formatGlossaryForPrompt('Can I book Blys for Gaurab?')).not.toContain(
      'Remedial Deep Tissue'
    );
    expect(formatGlossaryForPrompt('hello there')).toBe('');
  });

  it('maps STT alias Bliss to Blys, then TTS says Bliss', () => {
    expect(canonicalizeGlossaryTerms('I love Bliss')).toBe('I love Blys');
    expect(applySpokenForms('Book with Blys tomorrow')).toBe('Book with Bliss tomorrow');
  });

  it('does not treat preserved names as a failed Hindi translation', () => {
    expect(stripGlossaryTerms('Gaurab')).toBe('');
    expect(hasWrongScriptForTarget('Remedial Deep Tissue', 'hi-IN', 'en-US')).toBe(false);
    expect(hasWrongScriptForTarget('Gaurab booked Remedial Deep Tissue at Blys', 'hi-IN', 'en-US')).toBe(
      true
    );
    expect(hasWrongScriptForTarget('गौरव ने Blys में Remedial Deep Tissue बुक किया', 'hi-IN', 'en-US')).toBe(
      false
    );
  });

  it('protects service names so they are restored in English after translation', () => {
    const { text, slots } = protectPreservedTerms('Please book Remedial Deep Tissue today');
    expect(text).toContain('__GLOSS_0__');
    expect(text).not.toContain('Remedial Deep Tissue');
    expect(slots[0].term).toBe('Remedial Deep Tissue');
    expect(restorePreservedTerms('कृपया आज __GLOSS_0__ बुक करें', slots)).toBe(
      'कृपया आज Remedial Deep Tissue बुक करें'
    );
  });
});
