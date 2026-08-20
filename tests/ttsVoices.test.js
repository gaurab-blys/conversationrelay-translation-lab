const { buildVoiceAttribute, resolveTtsLanguage } = require('../src/voice/ttsVoices');

describe('ttsVoices', () => {
  it('maps English accent aliases to locale voices', () => {
    expect(resolveTtsLanguage('en-US', 'gb')).toBe('en-GB');
    expect(buildVoiceAttribute({ language: 'en-US', englishAccent: 'gb' })).toContain(
      'Fahco4VZzobUeiPqni1S'
    );
    expect(buildVoiceAttribute({ language: 'en-US', englishAccent: 'in' })).toContain(
      'mCQMfsqGDT6IDkEKR20a'
    );
  });

  it('maps Hindi accent aliases to hi-IN', () => {
    expect(resolveTtsLanguage('hi-IN', 'in')).toBe('hi-IN');
    expect(buildVoiceAttribute({ language: 'hi-IN', accent: 'in' })).toContain(
      'IvLWq57RKibBrqZGpQrC'
    );
  });

  it('formats ElevenLabs model and voice settings', () => {
    expect(
      buildVoiceAttribute({
        language: 'en-US',
        model: 'turbo_v2_5',
        speed: 1.1,
        stability: 0.5,
        similarity: 0.9,
      })
    ).toBe('UgBBYS2sOqTuMpoF3BR0-turbo_v2_5-1.1_0.5_0.9');
  });
});

describe('buildLegTwiML TTS attributes', () => {
  const loadTwiml = (env = {}) => {
    Object.assign(process.env, {
      TTS_PROVIDER: 'ElevenLabs',
      TTS_ACCENT_A: 'us',
      TTS_ACCENT_B: 'us',
      TTS_EN_ACCENT: 'us',
      TTS_VOICE_A: '',
      TTS_VOICE_B: '',
      TTS_VOICE_EN: '',
      TTS_VOICE_HI: '',
      TTS_ELEVENLABS_MODEL: 'flash_v2_5',
      TTS_ELEVENLABS_SPEED: '1.0',
      TTS_ELEVENLABS_STABILITY: '0.6',
      TTS_ELEVENLABS_SIMILARITY: '0.8',
      ELEVENLABS_TEXT_NORMALIZATION: 'on',
      ...env,
    });
    jest.resetModules();
    return require('../src/voice/twiml');
  };

  it('sets ttsProvider, voice, and Language elements for both sides', () => {
    const { buildLegTwiML: build } = loadTwiml();
    const xml = build({
      pairId: 'pair-1',
      role: 'a',
      sourceLanguage: 'en-US',
      targetLanguage: 'hi-IN',
      connectActionUrl: 'https://example.test/voice/connect-action',
      conversationRelayWsUrl: 'wss://example.test/voice/relay-ws',
    });

    expect(xml).toContain('ttsProvider="ElevenLabs"');
    expect(xml).toContain('elevenlabsTextNormalization="on"');
    expect(xml).toContain('ttsLanguage="hi-IN"');
    expect(xml).toContain('voice="IvLWq57RKibBrqZGpQrC-flash_v2_5-1.0_0.6_0.8"');
    expect(xml).toContain(
      '<Language code="hi-IN" ttsProvider="ElevenLabs" voice="IvLWq57RKibBrqZGpQrC-flash_v2_5-1.0_0.6_0.8" />'
    );
    expect(xml).toContain(
      '<Language code="en-US" ttsProvider="ElevenLabs" voice="UgBBYS2sOqTuMpoF3BR0-flash_v2_5-1.0_0.6_0.8" />'
    );
  });

  it('uses the client-leg accent for English TTS on role b', () => {
    const { buildLegTwiML: build } = loadTwiml({
      TTS_ACCENT_A: 'us',
      TTS_ACCENT_B: 'gb',
    });

    const xml = build({
      pairId: 'pair-2',
      role: 'b',
      sourceLanguage: 'hi-IN',
      targetLanguage: 'en-US',
      connectActionUrl: 'https://example.test/voice/connect-action',
      conversationRelayWsUrl: 'wss://example.test/voice/relay-ws',
    });

    expect(xml).toContain('ttsLanguage="en-US"');
    expect(xml).toContain('voice="Fahco4VZzobUeiPqni1S-flash_v2_5-1.0_0.6_0.8"');
  });
});
