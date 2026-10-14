const { validateBuyer } = require('./checkoutController');
const { createDirectPayment } = require('../services/directPaymentService');
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function validateInput(body, userAgent) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const customer = validateBuyer(body.customer);
  const c = body.creditCard;
  const d = body.deviceInfo;
  if (!customer || !c || !d || !isUuid(body.attemptId)) return null;
  if (customer.address.length > 200 || customer.province.length > 100) return null;
  // Titular igual ao comprador nesta PoC; nome no cartão é coletado separadamente.
  if (typeof c.holderName !== 'string' || c.holderName.trim().length < 2 || c.holderName.length > 100
    || typeof c.number !== 'string' || !/^\d{13,19}$/.test(c.number)
    || typeof c.ccv !== 'string' || !/^\d{3,4}$/.test(c.ccv)
    || typeof c.expiryMonth !== 'string' || !/^(0[1-9]|1[0-2])$/.test(c.expiryMonth)
    || typeof c.expiryYear !== 'string' || !/^20\d{2}$/.test(c.expiryYear)) return null;
  const now = new Date();
  if (Number(c.expiryYear) * 12 + Number(c.expiryMonth) < now.getFullYear() * 12 + now.getMonth() + 1) return null;
  if (!Number.isInteger(d.colorDepth) || d.colorDepth < 1 || d.colorDepth > 64
    || !Number.isInteger(d.screenHeight) || d.screenHeight < 1 || d.screenHeight > 20000
    || !Number.isInteger(d.screenWidth) || d.screenWidth < 1 || d.screenWidth > 20000
    || !Number.isFinite(d.timeZoneOffset) || Math.abs(d.timeZoneOffset) > 14
    || typeof d.language !== 'string' || !/^[a-zA-Z0-9-]{2,35}$/.test(d.language)
    || typeof userAgent !== 'string' || userAgent.length < 1 || userAgent.length > 1024) return null;
  return { publicId: body.attemptId, customer,
    creditCard: { holderName: c.holderName.trim(), number: c.number, ccv: c.ccv, expiryMonth: c.expiryMonth, expiryYear: c.expiryYear },
    deviceInfo: { colorDepth: d.colorDepth, screenHeight: d.screenHeight, screenWidth: d.screenWidth,
      timeZoneOffset: d.timeZoneOffset, language: d.language, userAgent } };
}

async function create(req, res) {
  const input = validateInput(req.body, req.get('user-agent'));
  req.body = undefined;
  if (!input) return res.status(400).json({ success: false, error: { type: 'VALIDATION_ERROR', message: 'Revise os dados do comprador, cartão e dispositivo.' } });
  try {
    const result = await createDirectPayment({ ...input, remoteIp: req.payerIp });
    const trackingUrl = `/order/${result.publicId}`;
    return res.status(result.errorType ? 422 : 201).json({
      success: !result.errorType, orderPublicId: result.publicId, status: result.status, trackingUrl,
      challengeRequired: Boolean(result.challengeUrl), challengeUrl: result.challengeUrl,
      ...(result.errorType ? { error: { type: result.errorType, message: result.errorType === 'PAYMENT_REJECTED_OR_INVALID'
        ? 'O pagamento foi recusado ou os dados não foram aceitos. Consulte o pedido.'
        : 'A tentativa não foi concluída. Consulte o pedido antes de tentar novamente.' } } : {})
    });
  } catch {
    return res.status(503).json({ success: false, orderPublicId: input.publicId,
      trackingUrl: `/order/${input.publicId}`, error: { type: 'PAYMENT_UNAVAILABLE', message: 'Não foi possível concluir. Consulte o pedido antes de tentar novamente.' } });
  } finally {
    // Remove referências explícitas; não há persistência ou garantia de zeroização da memória JS.
    input.creditCard.number = '';
    input.creditCard.ccv = '';
  }
}
module.exports = { create, validateInput };
