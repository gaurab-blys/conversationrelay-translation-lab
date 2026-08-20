const config = require('../config');
const logger = require('../logger');
const {
  upsertLeg,
  removeLegByCallSid,
  markOppositePreemptNext,
  sendTranslatedToOpposite,
} = require('./sessionStore');

const { translateText } = require('../translation/translate');
const TRANSLATE_MODE = config.TRANSLATE_MODE;

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
    // Buffer caller speech until `prompt.last === true` so we translate a full turn.
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
   * @param {boolean} last
   */
  const translateAndForward = async (text, last) => {
    if (!text || !state.callSid) return;

    let translated;
    try {
      translated = await translateText({
        text,
        sourceLanguage: state.sourceLanguage,
        targetLanguage: state.targetLanguage,
      });
    } catch (err) {
      logger.error('[relay] translation failed', { error: err.message });
      translated = '';
    }

    if (!translated) return;

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

        enqueueWork(async () => {
          if (TRANSLATE_MODE === 'segment') {
            if (!segment) return;
            await translateAndForward(segment, last);
            return;
          }

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
