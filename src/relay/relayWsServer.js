const config = require('../config');
const logger = require('../logger');
const {
  upsertLeg,
  removeLegByCallSid,
  markOppositePreemptNext,
  getOppositeLegByCallSid,
  consumePreemptNext,
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
  };

  ws.on('message', async (raw) => {
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
        // `voicePrompt` is the caller's transcript for this turn segment.
        const segment = String(msg.voicePrompt || '');
        const last = !!msg.last;

        const fromLang = state.sourceLanguage;
        const toLang = state.targetLanguage;

        if (TRANSLATE_MODE === 'segment') {
          // Translate each prompt segment immediately to reduce perceived latency.
          // This is "faster" but can be more fragmented because partial transcripts may change.
          if (!segment) return;

          const opposite = getOppositeLegByCallSid(state.callSid);
          if (!opposite?.ws || opposite.ws.readyState !== 1 /* OPEN */) {
            logger.warn('[relay] opposite leg not ready; dropping translation', {
              pairId: state.pairId,
              fromRole: state.role,
              toRole: opposite?.role,
            });
            return;
          }

          let translated;
          try {
            translated = await translateText({
              text: segment,
              sourceLanguage: fromLang,
              targetLanguage: toLang,
            });
          } catch (err) {
            logger.error('[relay] translation failed', { error: err.message });
            translated = '';
          }

          if (!translated) return;

          const preemptible = consumePreemptNext(opposite);
          opposite.ws.send(
            JSON.stringify({
              type: 'text',
              token: translated,
              last: last /* only final segment marks last */,
              preemptible,
              interruptible: true,
            })
          );
          return;
        }

        // Default: Buffer until the end of the caller speech turn.
        state.pendingPromptText += segment ? (state.pendingPromptText ? ' ' + segment : segment) : '';

        if (!last) return;

        const textToTranslate = state.pendingPromptText.trim();
        state.pendingPromptText = '';

        if (!textToTranslate) return;

        const opposite = getOppositeLegByCallSid(state.callSid);
        if (!opposite?.ws || opposite.ws.readyState !== 1 /* OPEN */) {
          logger.warn('[relay] opposite leg not ready; dropping translation', {
            pairId: state.pairId,
            fromRole: state.role,
            toRole: opposite?.role,
          });
          return;
        }

        let translated;
        try {
          translated = await translateText({
            text: textToTranslate,
            sourceLanguage: fromLang,
            targetLanguage: toLang,
          });
        } catch (err) {
          logger.error('[relay] translation failed', { error: err.message });
          translated = '';
        }

        if (!translated) return;

        const preemptible = consumePreemptNext(opposite);

        opposite.ws.send(
          JSON.stringify({
            type: 'text',
            token: translated,
            last: true,
            preemptible,
            interruptible: true,
          })
        );

        break;
      }

      case 'interrupt': {
        // Caller interrupted TTS playback; make the next outgoing TTS preempt the previous one.
        if (state.pairId && state.role) {
          markOppositePreemptNext(state.pairId, state.role);
        }
        // Discard any buffered partial prompt segments.
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

