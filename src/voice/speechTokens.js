/**
 * Splits translated speech into ConversationRelay TTS tokens.
 * Long single tokens are more likely to be truncated or skipped by the TTS provider.
 *
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string[]}
 */
const splitSpeechTokens = (text, maxChars = 280) => {
  const limit = Math.max(40, Number(maxChars) || 280);
  const input = String(text || '').trim();
  if (!input) return [];
  if (input.length <= limit) return [input];

  const sentences = input.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
  const chunks = [];
  let buf = '';

  const pushBuf = () => {
    if (buf) chunks.push(buf);
    buf = '';
  };

  const appendPiece = (piece) => {
    if (!piece) return;
    if (piece.length > limit) {
      pushBuf();
      const words = piece.split(/\s+/);
      let wordBuf = '';
      for (const word of words) {
        const next = wordBuf ? `${wordBuf} ${word}` : word;
        if (next.length <= limit) {
          wordBuf = next;
        } else {
          if (wordBuf) chunks.push(wordBuf);
          if (word.length <= limit) {
            wordBuf = word;
          } else {
            for (let i = 0; i < word.length; i += limit) {
              chunks.push(word.slice(i, i + limit));
            }
            wordBuf = '';
          }
        }
      }
      buf = wordBuf;
      return;
    }

    const next = buf ? `${buf} ${piece}` : piece;
    if (next.length <= limit) {
      buf = next;
    } else {
      pushBuf();
      buf = piece;
    }
  };

  for (const sentence of sentences) appendPiece(sentence);
  pushBuf();
  return chunks;
};

module.exports = {
  splitSpeechTokens,
};
