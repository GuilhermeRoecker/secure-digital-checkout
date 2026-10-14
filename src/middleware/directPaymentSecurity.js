const { isIP } = require('node:net');

// Confia nos headers Cloudflare SOMENTE por opt-in e quando cloudflared é o peer local.
// Não habilita trust proxy global nem aceita X-Forwarded-For arbitrário.
function payerConnection(req) {
  const peer = req.socket.remoteAddress || '';
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
  const viaTunnel = process.env.DIRECT_PAYMENT_TRUST_CLOUDFLARE === 'true' && local;
  const forwarded = viaTunnel ? req.get('cf-connecting-ip') : null;
  const validForwarded = Boolean(forwarded && isIP(forwarded));
  const ip = forwarded ? (validForwarded ? forwarded : '') : peer.replace(/^::ffff:/, '');
  return { ip, https: req.secure || (viaTunnel && validForwarded && req.get('x-forwarded-proto') === 'https') };
}

function requireDirectHttps(req, res, next) {
  const connection = payerConnection(req);
  if ((!connection.https && process.env.NODE_ENV !== 'test') || !isIP(connection.ip)) {
    return res.status(400).json({ success: false, error: { type: 'HTTPS_REQUIRED', message: 'Abra a aplicação pela URL HTTPS pública para pagar com cartão.' } });
  }
  req.payerIp = connection.ip;
  res.set('Cache-Control', 'no-store');
  return next();
}

function createDirectPaymentLimiter() {
  const clients = new Map();
  const windowMs = 10 * 60 * 1000;
  let total = { count: 0, until: 0 };
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of clients) if (value.until <= now) clients.delete(key);
    if (total.until <= now) total = { count: 0, until: now + windowMs };
    if (total.count >= 30) {
      res.set('Retry-After', String(Math.ceil((total.until - now) / 1000)));
      return res.status(429).json({ success: false, error: { type: 'RATE_LIMITED', message: 'Limite de tentativas atingido. Aguarde antes de tentar novamente.' } });
    }
    const key = req.payerIp;
    const entry = clients.get(key) || { count: 0, until: now + windowMs };
    clients.set(key, entry);
    entry.count += 1;
    total.count += 1;
    if (entry.count > 5 || total.count > 30) {
      res.set('Retry-After', String(Math.ceil((Math.max(entry.until, total.until) - now) / 1000)));
      return res.status(429).json({ success: false, error: { type: 'RATE_LIMITED', message: 'Limite de tentativas atingido. Aguarde antes de tentar novamente.' } });
    }
    return next();
  };
}

module.exports = { requireDirectHttps, createDirectPaymentLimiter, payerConnection };
