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
const relayWsUrl =
  config.WEBHOOK_BASE_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws') + '/voice/relay-ws';
const { getLegByCallSid } = require('./relay/sessionStore');

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
 * Connect action callback.
 *
 * Per Twilio docs, this can be used to restore ConversationRelay by returning new TwiML when
 * the session ends in a failed/unexpected state.
 *
 * This is currently a placeholder; the reconnect logic will be implemented in the reconnect-action
 * TODO once sessionStore exists.
 */
app.post('/voice/connect-action', (req, res) => {
  const callSid = req.body.CallSid || req.body.callSid;
  const sessionStatus = req.body.SessionStatus || req.body.sessionStatus;
  const errorCode = req.body.ErrorCode || req.body.errorCode;

  // Per Twilio docs, SessionStatus can be `ended` or `failed`.
  // On failure/unexpected disconnect we return new TwiML to restore ConversationRelay.
  if (sessionStatus === 'ended') {
    res.status(200).type('text/xml').send('<Response></Response>');
    return;
  }

  if (!callSid) {
    logger.warn('[connect-action] missing CallSid', { sessionStatus, errorCode });
    res.status(200).type('text/xml').send('<Response></Response>');
    return;
  }

  const leg = getLegByCallSid(callSid);
  if (!leg) {
    logger.warn('[connect-action] no sessionStore mapping for callSid', {
      callSid,
      sessionStatus,
      errorCode,
    });
    res.status(200).type('text/xml').send('<Response></Response>');
    return;
  }

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
  logger.info('[server] relayWsUrl', { relayWsUrl });
});

