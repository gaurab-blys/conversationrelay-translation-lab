const Twilio = require('twilio');
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = require('../config');
const logger = require('../logger');

/**
 * Creates a Twilio REST client when credentials are configured.
 * @returns {import('twilio').Twilio|null}
 */
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

if (!twilioClient) {
  logger.warn('[twilio] missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN; outbound dialing will fail');
}

module.exports = { twilioClient };

