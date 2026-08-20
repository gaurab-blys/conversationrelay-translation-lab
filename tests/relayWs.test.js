const { handleConversationRelayConnection } = require('../src/relay/relayWsServer');
const config = require('../src/config');

const createMockWs = () => {
  const listeners = {};

  return {
    readyState: 1, // WebSocket.OPEN
    send: jest.fn(),
    on: (event, handler) => {
      listeners[event] = handler;
    },
    emit: (event, payload) => {
      if (listeners[event]) listeners[event](payload);
    },
  };
};

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

describe('ConversationRelay WS bridge (translation)', () => {
  const originalTranslateMode = config.TRANSLATE_MODE;

  afterEach(() => {
    config.TRANSLATE_MODE = originalTranslateMode;
  });

  it('bridges prompt(last=true) from leg a to leg b', async () => {
    const wsA = createMockWs();
    const wsB = createMockWs();

    handleConversationRelayConnection(wsA);
    handleConversationRelayConnection(wsB);

    const pairId = 'pair-test-1';
    wsA.emit(
      'message',
      JSON.stringify({
        type: 'setup',
        sessionId: 'S_A',
        callSid: 'CA_A',
        customParameters: {
          pairId,
          role: 'a',
          sourceLanguage: 'en-US',
          targetLanguage: 'hi-IN',
        },
      })
    );
    wsB.emit(
      'message',
      JSON.stringify({
        type: 'setup',
        sessionId: 'S_B',
        callSid: 'CA_B',
        customParameters: {
          pairId,
          role: 'b',
          sourceLanguage: 'hi-IN',
          targetLanguage: 'en-US',
        },
      })
    );

    wsA.emit(
      'message',
      JSON.stringify({
        type: 'prompt',
        voicePrompt: 'Hello',
        lang: 'en-US',
        last: true,
      })
    );

    await flush();

    expect(wsB.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(wsB.send.mock.calls[0][0]);
    expect(payload.type).toBe('text');
    expect(payload.last).toBe(true);
    expect(payload.token).toBe('(hi-IN) Hello');
  });

  it('sets preemptible on next outgoing token after interrupt', async () => {
    const wsA = createMockWs();
    const wsB = createMockWs();

    handleConversationRelayConnection(wsA);
    handleConversationRelayConnection(wsB);

    const pairId = 'pair-test-2';
    wsA.emit(
      'message',
      JSON.stringify({
        type: 'setup',
        sessionId: 'S_A',
        callSid: 'CA_A2',
        customParameters: {
          pairId,
          role: 'a',
          sourceLanguage: 'en-US',
          targetLanguage: 'hi-IN',
        },
      })
    );
    wsB.emit(
      'message',
      JSON.stringify({
        type: 'setup',
        sessionId: 'S_B',
        callSid: 'CA_B2',
        customParameters: {
          pairId,
          role: 'b',
          sourceLanguage: 'hi-IN',
          targetLanguage: 'en-US',
        },
      })
    );

    wsA.emit(
      'message',
      JSON.stringify({
        type: 'interrupt',
        utteranceUntilInterrupt: 'something',
        durationUntilInterruptMs: 100,
      })
    );

    wsA.emit(
      'message',
      JSON.stringify({
        type: 'prompt',
        voicePrompt: 'Next sentence',
        last: true,
      })
    );

    await flush();

    expect(wsB.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(wsB.send.mock.calls[0][0]);
    expect(payload.preemptible).toBe(true);
    expect(payload.token).toBe('(hi-IN) Next sentence');
  });

  it('streams each prompt segment immediately in segment mode', async () => {
    config.TRANSLATE_MODE = 'segment';
    const wsA = createMockWs();
    const wsB = createMockWs();

    handleConversationRelayConnection(wsA);
    handleConversationRelayConnection(wsB);

    const pairId = 'pair-test-buffer';
    wsB.emit(
      'message',
      JSON.stringify({
        type: 'setup',
        sessionId: 'S_B3',
        callSid: 'CA_B3',
        customParameters: {
          pairId,
          role: 'b',
          sourceLanguage: 'hi-IN',
          targetLanguage: 'en-US',
        },
      })
    );
    wsA.emit(
      'message',
      JSON.stringify({
        type: 'setup',
        sessionId: 'S_A3',
        callSid: 'CA_A3',
        customParameters: {
          pairId,
          role: 'a',
          sourceLanguage: 'en-US',
          targetLanguage: 'hi-IN',
        },
      })
    );

    wsB.emit(
      'message',
      JSON.stringify({
        type: 'prompt',
        voicePrompt: 'I want to book',
        last: false,
      })
    );
    wsB.emit(
      'message',
      JSON.stringify({
        type: 'prompt',
        voicePrompt: 'a Swedish massage tomorrow afternoon',
        last: true,
      })
    );

    await flush();

    // Segment mode: each STT chunk is forwarded as its own TTS token.
    // Mid chunks must keep last:false so ConversationRelay queues them in one talk cycle.
    expect(wsA.send).toHaveBeenCalledTimes(2);
    const first = JSON.parse(wsA.send.mock.calls[0][0]);
    const second = JSON.parse(wsA.send.mock.calls[1][0]);
    expect(first.type).toBe('text');
    expect(first.token).toBe('(en-US) I want to book');
    expect(first.last).toBe(false);
    expect(first.preemptible).toBe(false);
    expect(second.token).toBe('(en-US) a Swedish massage tomorrow afternoon');
    expect(second.last).toBe(true);
    expect(second.preemptible).toBe(false);
  });

  it('queues translation until the opposite leg connects', async () => {
    const wsA = createMockWs();
    const wsB = createMockWs();

    handleConversationRelayConnection(wsA);
    handleConversationRelayConnection(wsB);

    const pairId = 'pair-test-queue';
    wsA.emit(
      'message',
      JSON.stringify({
        type: 'setup',
        sessionId: 'S_AQ',
        callSid: 'CA_AQ',
        customParameters: {
          pairId,
          role: 'a',
          sourceLanguage: 'en-US',
          targetLanguage: 'hi-IN',
        },
      })
    );

    wsA.emit(
      'message',
      JSON.stringify({
        type: 'prompt',
        voicePrompt: 'Please wait for the other person',
        last: true,
      })
    );

    await flush();
    expect(wsB.send).not.toHaveBeenCalled();

    wsB.emit(
      'message',
      JSON.stringify({
        type: 'setup',
        sessionId: 'S_BQ',
        callSid: 'CA_BQ',
        customParameters: {
          pairId,
          role: 'b',
          sourceLanguage: 'hi-IN',
          targetLanguage: 'en-US',
        },
      })
    );

    expect(wsB.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(wsB.send.mock.calls[0][0]);
    expect(payload.token).toBe('(hi-IN) Please wait for the other person');
    expect(payload.last).toBe(true);
  });
});
