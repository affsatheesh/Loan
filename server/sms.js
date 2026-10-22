'use strict';
// OTP delivery. Production requires a real SMS service; nothing is ever accepted locally unless DEMO_MODE=1.
//  - DEMO_MODE=1            : code is generated and returned to the screen, clearly labelled DEMO.
//  - SMS_WEBHOOK_URL (+ SMS_WEBHOOK_TOKEN): POSTs {mobile, message} as JSON to your SMS gateway/relay.
//  - otherwise              : sending fails with "SMS provider not configured".
const { ApiError } = require('./http');
const DEMO = () => process.env.DEMO_MODE === '1';
async function sendOtp(mobile, code) {
  if (DEMO()) return { demo: true, provider: 'DEMO' };
  const url = process.env.SMS_WEBHOOK_URL;
  if (!url) throw new ApiError(503, 'SMS provider is not configured. Set SMS_WEBHOOK_URL (see README) or run with DEMO_MODE=1 for testing.');
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json',
    ...(process.env.SMS_WEBHOOK_TOKEN ? { authorization: 'Bearer ' + process.env.SMS_WEBHOOK_TOKEN } : {}) },
    body: JSON.stringify({ mobile: '+91' + mobile, message: `Your HS Small Finance verification code is ${code}. Valid for 5 minutes.` }) });
  if (!res.ok) throw new ApiError(502, 'SMS provider rejected the request.');
  return { demo: false, provider: 'WEBHOOK' };
}
module.exports = { sendOtp, isDemo: DEMO };
