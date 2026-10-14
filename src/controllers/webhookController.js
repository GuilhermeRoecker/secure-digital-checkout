const { processAsaasWebhook } = require('../services/asaasWebhookService');

function isSafeIdentifier(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && /^[a-zA-Z0-9_&-]+$/.test(value);
}

async function receive(req, res, next) {
  const body = req.body;
  if (
    !body
    || typeof body !== 'object'
    || Array.isArray(body)
    || !isSafeIdentifier(body.id, 255)
    || !isSafeIdentifier(body.event, 100)
  ) {
    return res.status(400).json({
      success: false,
      error: { type: 'INVALID_WEBHOOK_EVENT', message: 'O evento recebido é inválido.' }
    });
  }

  try {
    const result = await processAsaasWebhook(body);
    return res.status(200).json({
      success: true,
      received: true,
      duplicate: result.result === 'DUPLICATE',
      ignored: result.result === 'IGNORED'
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { receive };
