const config = require('../config');
const logger = require('../logger');
const {
  upsertLeg,
  removeLegByCallSid,
  markOppositePreemptNext,
  sendTranslatedToOpposite,
} = require('./sessionStore');

const { translateText } = require('../translation/translate');

/**
 * Attaches a ConversationRelay message handler to a WebSocket connection.
 * @param {import('ws').WebSocket} ws
 */
const handleConversationRelayConnection = (ws) => {
  const state = {
    callSid: undefined,
    pairId: undefined,
    role: undefined,
    sourceLanguage: undefined,
    targetLanguage: undefined,
    // Used by turn mode to buffer caller speech until `prompt.last === true`.
    pendingPromptText: '',
    // Serialize translate+send so overlapping prompts stay in order.
    workQueue: Promise.resolve(),
  };

  /**
   * @param {() => Promise<void>} work
   */
  const enqueueWork = (work) => {
    state.workQueue = state.workQueue.then(work).catch((err) => {
      logger.error('[relay] queued work failed', { error: err.message });
    });
  };

  /**
   * Translates speech and sends (or queues) it to the opposite leg.
   *
   * @param {string} text
   * @param {boolean} last - ConversationRelay talk-cycle end flag
   */
  const translateAndForward = async (text, last) => {
    if (!text || !state.callSid) return;

    let translated;
    try {
      translated = await translateText({
        text,
        sourceLanguage: state.sourceLanguage,
        targetLanguage: state.targetLanguage,
        // Mid-stream segments must not get forced terminal punctuation.
        speechFinal: last,
      });
    } catch (err) {
      logger.error('[relay] translation failed', { error: err.message });
      translated = '';
    }

    if (!translated) return;

    logger.info('[relay] translated utterance', {
      pairId: state.pairId,
      role: state.role,
      inputChars: text.length,
      outputChars: translated.length,
      last,
      mode: config.TRANSLATE_MODE,
    });

    // Stream with last:false until the final STT segment so ConversationRelay queues
    // TTS instead of starting a new talk cycle / dropping earlier words.
    sendTranslatedToOpposite({
      fromCallSid: state.callSid,
      token: translated,
      last,
    });
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_e) {
      return;
    }

    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'setup': {
        const customParameters = msg.customParameters || {};

        state.callSid = msg.callSid;
        state.pairId = customParameters.pairId;
        state.role = customParameters.role;
        state.sourceLanguage = customParameters.sourceLanguage;
        state.targetLanguage = customParameters.targetLanguage;

        if (!state.callSid || !state.pairId || !state.role) {
          logger.warn('[relay] setup missing required fields', {
            callSid: state.callSid,
            pairId: state.pairId,
            role: state.role,
          });
          return;
        }

        upsertLeg({
          pairId: state.pairId,
          role: state.role,
          callSid: state.callSid,
          sessionId: msg.sessionId,
          sourceLanguage: state.sourceLanguage,
          targetLanguage: state.targetLanguage,
          ws,
        });

        logger.info('[relay] leg registered', {
          pairId: state.pairId,
          role: state.role,
          callSid: state.callSid,
          sourceLanguage: state.sourceLanguage,
          targetLanguage: state.targetLanguage,
        });

        break;
      }

      case 'prompt': {
        const segment = String(msg.voicePrompt || '');
        const last = !!msg.last;
        const translateMode = config.TRANSLATE_MODE;

        enqueueWork(async () => {
          if (translateMode === 'segment') {
            // Low-latency path: translate each STT chunk as it arrives and stream TTS.
            // Keep last:false on mid-utterance tokens so Twilio queues them in one talk cycle
            // (preemptible stays false unless barge-in set preemptNext).
            if (!segment) return;
            await translateAndForward(segment, last);
            if (last) state.pendingPromptText = '';
            return;
          }

          // turn mode: buffer until prompt.last === true, then translate once.
          state.pendingPromptText += segment
            ? state.pendingPromptText
              ? ` ${segment}`
              : segment
            : '';

          if (!last) return;

          const textToTranslate = state.pendingPromptText.trim();
          state.pendingPromptText = '';
          if (!textToTranslate) return;

          await translateAndForward(textToTranslate, true);
        });

        break;
      }

      case 'interrupt': {
        if (state.pairId && state.role) {
          markOppositePreemptNext(state.pairId, state.role);
        }
        state.pendingPromptText = '';
        break;
      }

      case 'error':
        logger.warn('[relay] conversation relay error', { description: msg.description });
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (state.callSid) removeLegByCallSid(state.callSid);
  });

  ws.on('error', (err) => {
    logger.warn('[relay] ws error', { error: err.message });
  });
};

module.exports = {
  handleConversationRelayConnection,
};
