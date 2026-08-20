const config = require('../config');
const logger = require('../logger');
const { splitSpeechTokens } = require('../voice/speechTokens');

const byCallSid = new Map();
const byPairRole = new Map();
/** @type {Map<string, Array<{token: string, last: boolean, interruptible: boolean}>>} */
const pendingByPairRole = new Map();

const roleOpposite = (role) => (role === 'a' ? 'b' : role === 'b' ? 'a' : undefined);

/**
 * @param {string} pairId
 * @param {string} role
 * @returns {string}
 */
const pairRoleKey = (pairId, role) => `${pairId}:${role}`;

/**
 * @param {import('ws').WebSocket|null|undefined} ws
 * @returns {boolean}
 */
const isWsOpen = (ws) => !!(ws && ws.readyState === 1);

/**
 * Sends one translated utterance as one or more ConversationRelay text tokens.
 *
 * @param {import('ws').WebSocket} ws
 * @param {object} params
 * @param {string} params.token
 * @param {boolean} params.last
 * @param {boolean} [params.interruptible]
 * @param {boolean} [params.preemptible]
 */
const sendTextChunksToWs = (ws, { token, last, interruptible = true, preemptible = false }) => {
  const chunks = splitSpeechTokens(token, config.TTS_TOKEN_MAX_CHARS);
  if (!chunks.length) return;

  if (chunks.length > 1) {
    logger.info('[relay] split TTS into chunks', { chunks: chunks.length, totalChars: token.length });
  }

  chunks.forEach((chunk, i) => {
    ws.send(
      JSON.stringify({
        type: 'text',
        token: chunk,
        last: !!(last && i === chunks.length - 1),
        interruptible,
        preemptible: i === 0 ? !!preemptible : false,
      })
    );
  });
};

/**
 * Queues TTS if the destination leg is not connected yet; otherwise sends immediately.
 *
 * @param {object} params
 * @param {string} params.pairId
 * @param {'a'|'b'} params.toRole
 * @param {string} params.token
 * @param {boolean} params.last
 * @param {boolean} [params.interruptible]
 */
const enqueueOrSendText = ({ pairId, toRole, token, last, interruptible = true }) => {
  if (!pairId || !toRole || !token) return;

  const key = pairRoleKey(pairId, toRole);
  const dest = byPairRole.get(key);
  if (isWsOpen(dest?.ws)) {
    const preemptible = consumePreemptNext(dest);
    sendTextChunksToWs(dest.ws, { token, last, interruptible, preemptible });
    return;
  }

  const max = config.TTS_PENDING_MAX || 30;
  const queue = pendingByPairRole.get(key) || [];
  if (queue.length >= max) {
    queue.shift();
    logger.warn('[relay] pending TTS queue full; dropped oldest', { pairId, toRole, max });
  }
  queue.push({ token, last, interruptible });
  pendingByPairRole.set(key, queue);
  logger.info('[relay] queued TTS until opposite leg is ready', {
    pairId,
    toRole,
    queued: queue.length,
  });
};

/**
 * Plays any TTS that arrived before this leg's WebSocket was ready.
 *
 * @param {string} pairId
 * @param {'a'|'b'} role
 */
const flushPendingForLeg = (pairId, role) => {
  const key = pairRoleKey(pairId, role);
  const queue = pendingByPairRole.get(key);
  if (!queue || !queue.length) return;

  const dest = byPairRole.get(key);
  if (!isWsOpen(dest?.ws)) return;

  pendingByPairRole.delete(key);
  logger.info('[relay] flushing queued TTS', { pairId, role, count: queue.length });

  queue.forEach((msg, i) => {
    const preemptible = i === 0 ? consumePreemptNext(dest) : false;
    sendTextChunksToWs(dest.ws, {
      token: msg.token,
      last: msg.last,
      interruptible: msg.interruptible,
      preemptible,
    });
  });
};

/**
 * Drops queued TTS for a destination (used on barge-in).
 *
 * @param {string} pairId
 * @param {'a'|'b'} role
 */
const clearPendingForLeg = (pairId, role) => {
  pendingByPairRole.delete(pairRoleKey(pairId, role));
};

/**
 * Registers a ConversationRelay "leg" (one PSTN caller side) so we can bridge prompts to the opposite leg.
 * @param {object} params
 * @param {string} params.pairId
 * @param {'a'|'b'} params.role
 * @param {string} params.callSid
 * @param {string} params.sessionId
 * @param {string} params.sourceLanguage
 * @param {string} params.targetLanguage
 * @param {import('ws').WebSocket} params.ws
 */
const upsertLeg = ({
  pairId,
  role,
  callSid,
  sessionId,
  sourceLanguage,
  targetLanguage,
  ws,
}) => {
  if (!pairId || !role || !callSid) return;

  const key = pairRoleKey(pairId, role);

  const existing = byPairRole.get(key);
  const entry = {
    pairId,
    role,
    callSid,
    sessionId,
    sourceLanguage,
    targetLanguage,
    ws,
    // When true, the next outgoing `{type:'text'}` we send to this leg should use `preemptible:true`.
    preemptNext: existing?.preemptNext || false,
  };

  byPairRole.set(key, entry);
  byCallSid.set(callSid, entry);
  flushPendingForLeg(pairId, role);
};

/**
 * Marks a leg as disconnected while keeping metadata for reconnect/restoration.
 *
 * Twilio's Connect `action` callback may arrive after the WS disconnect; if we delete the leg
 * entirely, we can't rebuild TwiML for the same callSid.
 *
 * @param {string} callSid
 */
const removeLegByCallSid = (callSid) => {
  const entry = byCallSid.get(callSid);
  if (!entry) return;

  const key = pairRoleKey(entry.pairId, entry.role);
  const updated = { ...entry, ws: null };

  byPairRole.set(key, updated);
  byCallSid.set(callSid, updated);
};

/**
 * Marks that the opposite leg should use `preemptible:true` for its next TTS output.
 * Also drops queued TTS for that listener so stale translations are not played after barge-in.
 *
 * @param {string} pairId
 * @param {'a'|'b'} fromRole - The role that caused the interrupt.
 */
const markOppositePreemptNext = (pairId, fromRole) => {
  const opposite = roleOpposite(fromRole);
  if (!opposite) return;
  const entry = byPairRole.get(pairRoleKey(pairId, opposite));
  if (entry) {
    entry.preemptNext = true;
    byPairRole.set(pairRoleKey(pairId, opposite), entry);
  }
  clearPendingForLeg(pairId, opposite);
};

/**
 * Gets the opposite leg entry for a given callSid.
 * @param {string} callSid
 * @returns {object|undefined}
 */
const getOppositeLegByCallSid = (callSid) => {
  const entry = byCallSid.get(callSid);
  if (!entry) return undefined;
  const opposite = roleOpposite(entry.role);
  if (!opposite) return undefined;
  return byPairRole.get(pairRoleKey(entry.pairId, opposite));
};

/**
 * Sends (or queues) translated speech to the opposite party.
 *
 * @param {object} params
 * @param {string} params.fromCallSid
 * @param {string} params.token
 * @param {boolean} params.last
 */
const sendTranslatedToOpposite = ({ fromCallSid, token, last }) => {
  const from = byCallSid.get(fromCallSid);
  if (!from) {
    logger.warn('[relay] cannot send translation; unknown fromCallSid', { fromCallSid });
    return;
  }
  const toRole = roleOpposite(from.role);
  if (!toRole) return;
  enqueueOrSendText({
    pairId: from.pairId,
    toRole,
    token,
    last,
  });
};

/**
 * Consumes the `preemptNext` flag so it is only applied once.
 * @param {object} legEntry
 * @returns {boolean}
 */
const consumePreemptNext = (legEntry) => {
  if (!legEntry) return false;
  const current = !!legEntry.preemptNext;
  legEntry.preemptNext = false;
  byPairRole.set(pairRoleKey(legEntry.pairId, legEntry.role), legEntry);
  byCallSid.set(legEntry.callSid, legEntry);
  return current;
};

/**
 * @param {string} callSid
 */
const getLegByCallSid = (callSid) => byCallSid.get(callSid);

/**
 * Ends the opposite ConversationRelay session (if still open) when one party hangs up.
 *
 * @param {string} callSid
 * @returns {object|undefined} opposite leg, if any
 */
const endOppositeSession = (callSid) => {
  const opposite = getOppositeLegByCallSid(callSid);
  if (!opposite) return undefined;

  clearPendingForLeg(opposite.pairId, opposite.role);
  const from = byCallSid.get(callSid);
  if (from) clearPendingForLeg(from.pairId, from.role);

  if (isWsOpen(opposite.ws)) {
    try {
      opposite.ws.send(
        JSON.stringify({
          type: 'end',
          handoffData: JSON.stringify({ reason: 'peer-hangup' }),
        })
      );
    } catch (err) {
      logger.warn('[relay] failed to send end to opposite leg', {
        callSid: opposite.callSid,
        error: err.message,
      });
    }
  }

  return opposite;
};

module.exports = {
  upsertLeg,
  removeLegByCallSid,
  markOppositePreemptNext,
  getOppositeLegByCallSid,
  sendTranslatedToOpposite,
  consumePreemptNext,
  getLegByCallSid,
  endOppositeSession,
  roleOpposite,
};
