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
    expect(prompt).toContain('The entire utterance must be Japanese');
    expect(prompt).toContain('weekdays, months, and years');
    expect(prompt).not.toContain('Hindi');
    expect(prompt).not.toContain('Devanagari');
    expect(prompt).toContain('Text: 20 agosto 2026');
  });

  it('detects leftover source script for any pair', () => {
    expect(languageDisplayName('ta-IN')).toBe('Tamil');
    expect(hasWrongScriptForTarget('अगस्त बीस', 'en-US', 'hi-IN')).toBe(true);
    expect(hasWrongScriptForTarget('August twentieth', 'en-US', 'hi-IN')).toBe(false);
    expect(hasWrongScriptForTarget('August twentieth', 'hi-IN', 'en-US')).toBe(true);
    expect(hasWrongScriptForTarget('こんにちは', 'en-US', 'ja-JP')).toBe(true);
  });
});
