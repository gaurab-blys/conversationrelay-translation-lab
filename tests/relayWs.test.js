const { handleConversationRelayConnection } = require('../src/relay/relayWsServer');

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

describe('ConversationRelay WS bridge (translation)', () => {
  it('bridges prompt(last=true) from leg a to leg b', () => {
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

    // Handler is async; flush microtasks.
    return Promise.resolve().then(() => {
      expect(wsB.send).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(wsB.send.mock.calls[0][0]);
      expect(payload.type).toBe('text');
      expect(payload.last).toBe(true);
      // Stub translation includes target language prefix.
      expect(payload.token).toBe('(hi-IN) Hello');
    });
  });

  it('sets preemptible on next outgoing token after interrupt', () => {
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

    // Interrupt from leg a should preempt TTS on the opposite leg (b).
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

    return Promise.resolve().then(() => {
      expect(wsB.send).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(wsB.send.mock.calls[0][0]);
      expect(payload.preemptible).toBe(true);
      expect(payload.token).toBe('(hi-IN) Next sentence');
    });
  });
});

