const {
  buildTranslationPrompt,
  hasWrongScriptForTarget,
  languageDisplayName,
} = require('../src/translation/translate');

describe('translation prompt', () => {
  it('is language-pair agnostic and requires dates in the target language', () => {
    const prompt = buildTranslationPrompt({
      text: '20 agosto 2026',
      sourceLanguage: 'es-ES',
      targetLanguage: 'ja-JP',
    });
    expect(prompt).toContain('Source language: Spanish (es-ES)');
    expect(prompt).toContain('Target language: Japanese (ja-JP)');
    expect(prompt).toContain('Prefer Japanese for the utterance');
    expect(prompt).toContain('weekdays, months, and years');
    expect(prompt).toContain('Mixing languages is preferred when a word would change meaning');
    expect(prompt).not.toContain('Glossary');
    expect(prompt).not.toContain('Blys');
    expect(prompt).not.toContain('Devanagari');
    expect(prompt).toContain('Text: 20 agosto 2026');
  });

  it('injects protected tokens so service names stay English', () => {
    const prompt = buildTranslationPrompt({
      text: 'Book __GLOSS_0__ with __GLOSS_1__',
      sourceLanguage: 'en-US',
      targetLanguage: 'hi-IN',
      slots: [
        { token: '__GLOSS_0__', term: 'Remedial Deep Tissue' },
        { token: '__GLOSS_1__', term: 'Gaurab' },
      ],
    });
    expect(prompt).toContain('__GLOSS_0__ = "Remedial Deep Tissue"');
    expect(prompt).toContain('Keep as English');
    expect(prompt).toContain('Gaurab');
    expect(prompt).not.toContain('[brand] Blys');
    expect(prompt).toContain('Always copy protected English business names');
  });

  it('detects leftover source script for any pair', () => {
    expect(languageDisplayName('ta-IN')).toBe('Tamil');
    expect(hasWrongScriptForTarget('अगस्त बीस', 'en-US', 'hi-IN')).toBe(true);
    expect(hasWrongScriptForTarget('August twentieth', 'en-US', 'hi-IN')).toBe(false);
    expect(hasWrongScriptForTarget('August twentieth', 'hi-IN', 'en-US')).toBe(true);
    expect(hasWrongScriptForTarget('कृपया tissue बुक करें', 'hi-IN', 'en-US')).toBe(false);
    expect(hasWrongScriptForTarget('こんにちは', 'en-US', 'ja-JP')).toBe(true);
  });
});
