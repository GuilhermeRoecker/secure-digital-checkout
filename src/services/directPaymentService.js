const axios = require('axios');
const { createHash } = require('node:crypto');
const { getAsaasConfig } = require('../config/asaas');
const repo = require('../repositories/orderRepository');

// Nenhum erro Axios, request config, descrição arbitrária, cartão ou URL de desafio sai deste módulo.
class DirectPaymentError extends Error {
  constructor(type = 'ASAAS_UNAVAILABLE', httpStatus = null) {
    super('Não foi possível concluir a tentativa de pagamento.');
    this.name = 'DirectPaymentError';
    this.type = type;
    this.providerStatus = Number.isInteger(httpStatus) ? httpStatus : null;
  }
}
const technicalId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;

function callbackUrl(publicId) {
  try {
    const base = new URL(process.env.APP_BASE_URL);
    if (base.protocol !== 'https:' || base.username || base.password || ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error();
    return `${base.origin}/payments/3ds/callback?order=${encodeURIComponent(publicId)}`;
  } catch { throw new DirectPaymentError('DIRECT_PAYMENT_CONFIG_ERROR'); }
}

async function request(config, method, path, data, params) {
  try {
    return (await axios.request({
      method, url: `${config.baseUrl}${path}`, data, params,
      headers: { access_token: config.apiKey, 'User-Agent': 'SecureDigitalCheckout/1.0.0', 'Content-Type': 'application/json' },
      timeout: path === '/payments' && method === 'POST' ? 65000 : 15000,
      maxRedirects: 0, maxContentLength: 256 * 1024
    })).data;
  } catch (error) {
    const status = error.response?.status;
    // Lista fixa de categorias locais; nunca propaga error.message, errors[].description ou config.
    const type = ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code) ? 'PAYMENT_RESULT_UNKNOWN'
      : method === 'POST' && path === '/payments' && status === 400 ? 'PAYMENT_REJECTED_OR_INVALID'
        : path === '/customers' && status === 400 ? 'CUSTOMER_INVALID' : 'ASAAS_UNAVAILABLE';
    throw new DirectPaymentError(type, status);
  }
}

async function resolveCustomerId(config, customer) {
  const list = await request(config, 'GET', '/customers', undefined, { cpfCnpj: customer.cpfCnpj, limit: 100 });
  if (!Array.isArray(list?.data)) throw new DirectPaymentError('ASAAS_INVALID_RESPONSE');
  const existing = list.data.find(c => String(c.cpfCnpj || '').replace(/\D/g, '') === customer.cpfCnpj && technicalId(c.id));
  if (existing) return existing.id;
  const created = await request(config, 'POST', '/customers', {
    ...customer, addressNumber: String(customer.addressNumber), notificationDisabled: true
  });
  if (!technicalId(created?.id)) throw new DirectPaymentError('ASAAS_INVALID_RESPONSE');
  return created.id;
}

// Compartilha apenas a busca/criação em andamento; reduz clientes duplicados entre tentativas concorrentes.
// Não é fingerprint de dispositivo e não grava CPF ou hash em logs/arquivos.
const customerLookups = new Map();
async function customerId(config, customer) {
  const key = createHash('sha256').update(customer.cpfCnpj).digest('hex');
  if (customerLookups.has(key)) return customerLookups.get(key);
  const pending = resolveCustomerId(config, customer);
  customerLookups.set(key, pending);
  try { return await pending; } finally { customerLookups.delete(key); }
}

function challengeUrl(value) {
  if (value === null || value === undefined) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 4096) throw new Error();
    return url.href;
  } catch { throw new DirectPaymentError('ASAAS_INVALID_CHALLENGE'); }
}

async function createDirectPayment({ publicId, customer, creditCard, deviceInfo, remoteIp }) {
  let config;
  try { config = getAsaasConfig(); } catch { throw new DirectPaymentError('DIRECT_PAYMENT_CONFIG_ERROR'); }
  if (!config.apiKey) throw new DirectPaymentError('DIRECT_PAYMENT_CONFIG_ERROR');
  const callback = callbackUrl(publicId);
  // UUID de tentativa: uma cobrança por submissão mesmo com requests concorrentes/repetidos.
  const order = await repo.createOrder({ publicId, customer, productName: 'Gift Card Digital', amount: 100, paymentFlow: 'DIRECT_3DS' });
  if (!order) {
    const existing = await repo.findOrderByPublicId(publicId);
    return { publicId, status: existing?.status || 'PENDING', challengeUrl: null, duplicate: true };
  }
  let paymentId = null;
  let asaasCustomerId = null;
  try {
    asaasCustomerId = await customerId(config, customer);
    const response = await request(config, 'POST', '/payments', {
      customer: asaasCustomerId, billingType: 'CREDIT_CARD', value: 100,
      dueDate: new Date().toISOString().slice(0, 10), description: 'Gift Card Digital — PoC Sandbox',
      externalReference: publicId, creditCard,
      creditCardHolderInfo: { ...customer, addressNumber: String(customer.addressNumber) },
      remoteIp, threeDSecure: { callbackUrl: callback }, deviceInfo: { ...deviceInfo, remoteIp }
    });
    paymentId = technicalId(response?.id);
    if (!paymentId) throw new DirectPaymentError('ASAAS_INVALID_RESPONSE');
    // Vincula antes de interpretar URL: até resposta inválida preserva o ID para o webhook.
    await repo.recordDirectResult(publicId, { paymentId, customerId: asaasCustomerId, challenge: Boolean(response.threeDSecureChallengeUrl) });
    const url = challengeUrl(response.threeDSecureChallengeUrl);
    console.info('[Pagamento direto]', JSON.stringify({ orderPublicId: publicId, paymentId, result: 'SUBMITTED' }));
    const saved = await repo.findOrderByPublicId(publicId);
    return { publicId, status: saved.status, challengeUrl: url };
  } catch (error) {
    // Mesmo falhas SQL são convertidas em exceção própria sem dados da requisição.
    const safe = error instanceof DirectPaymentError ? error : new DirectPaymentError('PAYMENT_RESULT_UNKNOWN');
    await repo.recordDirectResult(publicId, { paymentId, customerId: asaasCustomerId, failure: safe.type });
    console.error('[Pagamento direto]', JSON.stringify({ orderPublicId: publicId, paymentId, httpStatus: safe.providerStatus, result: safe.type }));
    return { publicId, status: (await repo.findOrderByPublicId(publicId)).status, errorType: safe.type, challengeUrl: null };
  }
}

module.exports = { createDirectPayment, DirectPaymentError };
