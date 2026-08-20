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
  // ConversationRelay TTS: ElevenLabs (human + accent), Google (Chirp3-HD), or Amazon.
  TTS_PROVIDER: process.env.TTS_PROVIDER || 'ElevenLabs',
  // Per-leg accent for the TTS that role hears. Agent = a, client phone = b.
  // English: us | gb | au | in. Hindi: in. Spanish: es | us. French: fr | ca.
  TTS_ACCENT_A: process.env.TTS_ACCENT_A || process.env.TTS_EN_ACCENT || 'us',
  TTS_ACCENT_B: process.env.TTS_ACCENT_B || process.env.TTS_EN_ACCENT || 'us',
  // Fallback when a role accent is unset (kept for older .env files).
  TTS_EN_ACCENT: process.env.TTS_EN_ACCENT || 'us',
  // Optional explicit voice IDs for what each role hears.
  TTS_VOICE_A: process.env.TTS_VOICE_A || '',
  TTS_VOICE_B: process.env.TTS_VOICE_B || '',
  TTS_ELEVENLABS_MODEL: process.env.TTS_ELEVENLABS_MODEL || 'flash_v2_5',
  TTS_ELEVENLABS_SPEED: process.env.TTS_ELEVENLABS_SPEED || '1.0',
  TTS_ELEVENLABS_STABILITY: process.env.TTS_ELEVENLABS_STABILITY || '0.6',
  TTS_ELEVENLABS_SIMILARITY: process.env.TTS_ELEVENLABS_SIMILARITY || '0.8',
  // on | auto | off — `on` improves pronunciation; `auto` behaves like `off` on ConversationRelay.
  ELEVENLABS_TEXT_NORMALIZATION: process.env.ELEVENLABS_TEXT_NORMALIZATION || 'on',
  // Optional explicit voice IDs (ElevenLabs ID, or Google/Amazon voice name).
  TTS_VOICE_EN: process.env.TTS_VOICE_EN || '',
  TTS_VOICE_HI: process.env.TTS_VOICE_HI || '',
};
