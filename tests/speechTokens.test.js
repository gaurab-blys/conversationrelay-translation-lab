const { splitSpeechTokens } = require('../src/voice/speechTokens');

describe('splitSpeechTokens', () => {
  it('returns a single token when text fits', () => {
    expect(splitSpeechTokens('Hello there.', 280)).toEqual(['Hello there.']);
  });

  it('splits on sentence boundaries when over the limit', () => {
    const text = 'First sentence is done. Second sentence is also done.';
    expect(splitSpeechTokens(text, 30)).toEqual([
      'First sentence is done.',
      'Second sentence is also done.',
    ]);
  });
});
