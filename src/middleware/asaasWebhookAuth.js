const { timingSafeEqual } = require('node:crypto');

function reject(res, status, type, message) {
  return res.status(status).json({ success: false, error: { type, message } });
}

function requireAsaasWebhookToken(req, res, next) {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN || '';
  if (expected.length < 32 || expected.length > 255 || /\s/.test(expected)) {
    return reject(res, 503, 'WEBHOOK_NOT_CONFIGURED', 'O Webhook Asaas não está configurado.');
  }

  const received = req.get('asaas-access-token') || '';
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  if (
    receivedBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    return reject(res, 401, 'WEBHOOK_UNAUTHORIZED', 'Autenticação do Webhook inválida.');
  }

  return next();
}

module.exports = { requireAsaasWebhookToken };
