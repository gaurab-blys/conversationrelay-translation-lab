const logger = require('../logger');

const byCallSid = new Map();
const byPairRole = new Map();

const roleOpposite = (role) => (role === 'a' ? 'b' : role === 'b' ? 'a' : undefined);

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

  const key = `${pairId}:${role}`;

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

  const key = `${entry.pairId}:${entry.role}`;
  const updated = { ...entry, ws: null };

  byPairRole.set(key, updated);
  byCallSid.set(callSid, updated);
};

/**
 * Marks that the opposite leg should use `preemptible:true` for its next TTS output.
 * @param {string} pairId
 * @param {'a'|'b'} fromRole - The role that caused the interrupt.
 */
const markOppositePreemptNext = (pairId, fromRole) => {
  const opposite = roleOpposite(fromRole);
  if (!opposite) return;
  const entry = byPairRole.get(`${pairId}:${opposite}`);
  if (!entry) return;
  entry.preemptNext = true;
  byPairRole.set(`${pairId}:${opposite}`, entry);
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
  return byPairRole.get(`${entry.pairId}:${opposite}`);
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
  byPairRole.set(`${legEntry.pairId}:${legEntry.role}`, legEntry);
  byCallSid.set(legEntry.callSid, legEntry);
  return current;
};

/**
 * @param {string} callSid
 */
const getLegByCallSid = (callSid) => byCallSid.get(callSid);

module.exports = {
  upsertLeg,
  removeLegByCallSid,
  markOppositePreemptNext,
  getOppositeLegByCallSid,
  consumePreemptNext,
  getLegByCallSid,
};

