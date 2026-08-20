require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const crypto = require('crypto');

const logger = require('./logger');
const config = require('./config');
const { twilioClient } = require('./voice/twilioClient');
const { buildLegTwiML } = require('./voice/twiml');
const { getVoiceToken } = require('./voiceToken');

const app = express();

app.use(
  '/vendor',
  express.static(path.join(__dirname, '../node_modules/@twilio/voice-sdk/dist'))
);
app.use(express.static(path.join(__dirname, '../public')));

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = config.PORT;

const connectActionUrl = `${config.WEBHOOK_BASE_URL}/voice/connect-action`;
const callStatusUrl = `${config.WEBHOOK_BASE_URL}/voice/call-status`;
const relayWsUrl =
  config.WEBHOOK_BASE_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws') + '/voice/relay-ws';
const { getLegByCallSid, endOppositeSession } = require('./relay/sessionStore');

/**
 * Voice token for the browser agent (Twilio Voice SDK).
 */
app.get('/api/voice-token', (_req, res) => {
  const result = getVoiceToken();
  if (!result) {
    res.status(500).json({ error: 'TWILIO_API_KEY, TWILIO_API_SECRET, or TWILIO_VOICE_TWIML_APP_SID missing' });
    return;
  }
  res.json(result);
});

/**
 * Agent page redirect.
 */
app.get('/agent', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/agent.html'));
});

/**
 * Health endpoint.
 */
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'conversationrelay-translation-lab' });
});

/**
 * Entry point for an inbound call.
 *
 * Caller A dials our TwiML app webhook at:
 *   POST ${WEBHOOK_BASE_URL}/api/v2/webhook/twilio/voice?to=CALLER_B_NUMBER
 *
 * We:
 *  - create pairId
 *  - dial Caller B using ConversationRelay TwiML (role=b)
 *  - return ConversationRelay TwiML for Caller A (role=a)
 */
app.post('/api/v2/webhook/twilio/voice', async (req, res) => {
  if (!twilioClient) {
    res.status(503).type('text/plain').send('Twilio credentials are missing');
    return;
  }

  const otherTo = String(req.query.to || req.body.to || req.body.To || '').trim();
  if (!otherTo) {
    res.status(400).type('text/plain').send('Missing query/body param: to');
    return;
  }

  const callerALang = String(req.query.callerALang || req.body.callerALang || config.CALLER_A_LANG);
  const callerBLang = String(req.query.callerBLang || req.body.callerBLang || config.CALLER_B_LANG);

  // Shared across both legs, embedded into ConversationRelay customParameters.
  const pairId = crypto.randomUUID();

  try {
    // Dial the 2nd human leg (role=b) to join the same translation session.
    await twilioClient.calls.create({
      from: config.TWILIO_FROM_NUMBER,
      to: otherTo,
      statusCallback: callStatusUrl,
      statusCallbackEvent: ['completed', 'busy', 'no-answer', 'canceled', 'failed'],
      statusCallbackMethod: 'POST',
      twiml: buildLegTwiML({
        pairId,
        role: 'b',
        sourceLanguage: callerBLang,
        targetLanguage: callerALang,
        connectActionUrl,
        conversationRelayWsUrl: relayWsUrl,
      }),
    });
  } catch (err) {
    logger.error('[pairing] outbound dial failed', { error: err.message });
    res.status(502).type('text/plain').send('Failed to start the paired outbound call');
    return;
  }

  // Return TwiML for Caller A (role=a) immediately.
  const twiml = buildLegTwiML({
    pairId,
    role: 'a',
    sourceLanguage: callerALang,
    targetLanguage: callerBLang,
    connectActionUrl,
    conversationRelayWsUrl: relayWsUrl,
  });

  res.type('text/xml').send(twiml);
});

/**
 * Hangs up the other party when one leg leaves the translation pair.
 *
 * @param {string} callSid
 */
const hangupOppositeLeg = async (callSid) => {
  const opposite = endOppositeSession(callSid);
  if (!opposite?.callSid || !twilioClient) return;

  try {
    await twilioClient.calls(opposite.callSid).update({ status: 'completed' });
    logger.info('[pairing] hung up opposite call', {
      fromCallSid: callSid,
      oppositeCallSid: opposite.callSid,
      oppositeRole: opposite.role,
    });
  } catch (err) {
    logger.warn('[pairing] opposite hangup failed', {
      fromCallSid: callSid,
      oppositeCallSid: opposite.callSid,
      error: err.message,
    });
  }
};

/**
 * Connect action callback.
 *
 * Restores ConversationRelay only if the session failed while the call is still up.
 * On a normal hangup (`completed` / `ended`), hang up the paired agent/client call too.
 */
app.post('/voice/connect-action', async (req, res) => {
  const callSid = req.body.CallSid || req.body.callSid;
  const callStatus = String(req.body.CallStatus || req.body.callStatus || '').toLowerCase();
  const sessionStatus = String(req.body.SessionStatus || req.body.sessionStatus || '').toLowerCase();
  const errorCode = req.body.ErrorCode || req.body.errorCode;

  const callStillActive = callStatus === 'in-progress' || callStatus === 'ringing';
  const sessionFailed = sessionStatus === 'failed';
  const peerLeft =
    sessionStatus === 'ended' ||
    sessionStatus === 'completed' ||
    ['completed', 'canceled', 'busy', 'no-answer'].includes(callStatus);

  if (sessionFailed && callStillActive && callSid) {
    const leg = getLegByCallSid(callSid);
    if (leg) {
      logger.warn('[connect-action] restoring ConversationRelay session', {
        callSid,
        pairId: leg.pairId,
        role: leg.role,
        sessionStatus,
        errorCode,
      });
      const twiml = buildLegTwiML({
        pairId: leg.pairId,
        role: leg.role,
        sourceLanguage: leg.sourceLanguage,
        targetLanguage: leg.targetLanguage,
        connectActionUrl,
        conversationRelayWsUrl: relayWsUrl,
      });
      res.status(200).type('text/xml').send(twiml);
      return;
    }
  }

  if (peerLeft && callSid) {
    logger.info('[connect-action] peer left; hanging up opposite leg', {
      callSid,
      sessionStatus,
      callStatus,
    });
    hangupOppositeLeg(callSid).catch((err) => {
      logger.warn('[connect-action] hangupOppositeLeg failed', { error: err.message });
    });
  }

  res.status(200).type('text/xml').send('<Response></Response>');
});

/**
 * PSTN/client call status. If the client phone ends, hang up the browser agent too.
 */
app.post('/voice/call-status', async (req, res) => {
  const callSid = req.body.CallSid || req.body.callSid;
  const callStatus = String(req.body.CallStatus || req.body.callStatus || '').toLowerCase();

  if (callSid && ['completed', 'canceled', 'busy', 'no-answer', 'failed'].includes(callStatus)) {
    logger.info('[call-status] terminal status; hanging up opposite leg', { callSid, callStatus });
    hangupOppositeLeg(callSid).catch((err) => {
      logger.warn('[call-status] hangupOppositeLeg failed', { error: err.message });
    });
  }

  res.status(204).end();
});

const server = http.createServer(app);

// ConversationRelay WS endpoint.
const { WebSocketServer } = require('ws');
const { handleConversationRelayConnection } = require('./relay/relayWsServer');
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', handleConversationRelayConnection);

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/voice/relay-ws') return socket.destroy();
  } catch (_e) {
    return socket.destroy();
  }

  wss.handleUpgrade(req, socket, head, (sock) => {
    wss.emit('connection', sock, req);
  });
});

server.listen(PORT, () => {
  logger.info(`[server] listening on port ${PORT}`);
  logger.info('[server] connectActionUrl', { connectActionUrl });
  logger.info('[server] callStatusUrl', { callStatusUrl });
  logger.info('[server] relayWsUrl', { relayWsUrl });
});

