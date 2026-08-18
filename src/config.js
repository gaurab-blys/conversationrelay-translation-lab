require('dotenv').config();

module.exports = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER || '',
  WEBHOOK_BASE_URL: (process.env.WEBHOOK_BASE_URL || 'http://localhost:4000').replace(/\/$/, ''),
  // Keep unit tests deterministic and offline: never hit external translation providers during Jest.
  TRANSLATION_PROVIDER:
    process.env.NODE_ENV === 'test' ? 'stub' : process.env.TRANSLATION_PROVIDER || 'stub',
  DEEPL_API_KEY: process.env.DEEPL_API_KEY || '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_TRANSLATION_MODEL: process.env.OPENAI_TRANSLATION_MODEL || 'gpt-5.6',
  OPENAI_MAX_OUTPUT_TOKENS: parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || '120', 10),
  CALLER_A_LANG: process.env.CALLER_A_LANG || 'en-US',
  CALLER_B_LANG: process.env.CALLER_B_LANG || 'hi-IN',
  // 'turn' = translate when prompt.last === true (current behavior)
  // 'segment' = translate each prompt segment immediately (lower perceived latency, more fragmented speech)
  TRANSLATE_MODE: process.env.TRANSLATE_MODE || 'turn',
};
