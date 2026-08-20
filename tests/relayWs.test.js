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

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

describe('ConversationRelay WS bridge (translation)', () => {
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
