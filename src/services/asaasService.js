const axios = require('axios');
const { getAsaasConfig } = require('../config/asaas');

const productImageBase64 = [
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkBAMAAADzmCa8AAAALVBMVEXz+uamtbN3j4szVUQhPzgSOzVt',
  'lVTI8WkmSTpaZUukzF+dYFHVcFz/e2Tb9pxTkI5tAAADh0lEQVRYw62Zv2sUQRTHX2yuW0QImC4I9gqe',
  'hcZKLiBaeTfhljQGcly7KNxwVxwIXhBJYeFhNF6VItdLICGkslHMVVbBXdhuu/0bnMvs/djdeW93xhkI',
  'JGHz4fOdmcx7cwsAtx4wcmzy/Ggpn6zvgBg3BjSv0c7zOjX1s811ARwyfcEj7GFXCDJ9QY5LrMNtA8EO',
  '/vhbaBkIjvHnt6CqL0gkZnUwEOxQfwEGgmNzoFKwVzUH7nHdxDSwqRLku+ZApeA88dMv52cHWsDmsQrY',
  'Tab3cBIEgX820AB+UPGSg6bxLZDjd7U0UC3Yk0qPg9n4VSsLVAvKxO5kDgxOSwLVgkniiwUv8KvlgGpB',
  'mXg7WB4/SgERQXm0jlJAf1AGqBaUieuTFDA4KQGsqwVlMXme5gVXJYCPeOnEInOtEIgIyqO1kUkcBMNC',
  'ICIoDxo3y1ueRNASlEfrdg74pwiICCbF5EUOeFUAxASTo/VJDvi3AIgJJsVklAP6NBATnB2tCmCNBGKC',
  's2JykQcOKCAmOC8mukBMcF5MRnpAVLDLmNEcYoKLrnWktW1cTLA3j7WvBfzKixLr/aeggkt9ev5w+IkD',
  'UcFFYtaclD9tcMHlPj27EZfrXgb4mRcnZmwDX5MM0EV5qZuJi09hBogLpm4mjQu0AqSBuGCmT99Hi14a',
  'iAtmutZ0YT7BgFu4YLZP38AEU8B22cRiKy5m0R9iQEIw36fP+zn/FG042+UTi/FMOvrf0ZaYEFTeTOqH',
  'l5eX5wd4097WSSy34/t3xLWCECy4mSDAtmbiIiAl2GUGQEKQtwyAlGBvoA9stG0lToCb3FZiCSQF9RJL',
  'ICl4xLSBpKBm4msgKYh9zEUAaUHNxFMgKciH2sAmKdhh2sA9UnCsDaQFtRMzoAW1EzM4tpuYAcnTOlrL',
  'APUTFwB3LQMNEtPALrMMbFkGmiSeAfvghE4IIYifxVcYiV94sGYO9Jy474RxP4x534k5VDwHvLWb5osS',
  'RlG/ImhhxL1IMJ0pcPXeXXOgBwIIkQR6Aigi/xcwmgKja8MKF1MpmK9WPw7/Yw4FQgKn6xOFYQXur6wM',
  'zLeNWJC4L1ZbfBvHYmXi6PXDO5+s7kODuCSwwywDx7aBQ8tA08QocGwZaHTQUEDjxBhw1zLQPHEDrBWT',
  '2Ws4a8VEjpdgoU9Pv8q0m5itg93ELoDVxNMX1grgG+Ml3gH4ByO41iOiQgDeAAAAAElFTkSuQmCC'
].join('');

const endpoint = '/v3/checkouts';

class AsaasServiceError extends Error {
  constructor({ status, providerCode, details, type, failureCode } = {}) {
    super('Não foi possível criar o checkout.');
    this.name = 'AsaasServiceError';
    this.type = type || 'ASAAS_REQUEST_ERROR';
    this.statusCode = status ? 502 : 503;
    this.providerStatus = status || null;
    this.providerCode = providerCode || null;
    this.failureCode = failureCode || mapFailureCode(providerCode, status);
    this.details = details || 'Não foi possível comunicar com o provedor de pagamentos.';
  }
}

function mapFailureCode(providerCode, status) {
  if (providerCode === 'invalid_action' || providerCode === 'invalid_object') {
    return 'ASAAS_VALIDATION_ERROR';
  }
  if (status === 401 || status === 403) return 'ASAAS_AUTH_ERROR';
  if (status) return 'ASAAS_REQUEST_ERROR';
  return 'ASAAS_NETWORK_ERROR';
}

function sanitizeDescription(value, customerData) {
  const privateValues = [
    customerData?.name,
    customerData?.email,
    customerData?.cpfCnpj,
    customerData?.phone,
    customerData?.address,
    customerData?.province
  ].filter((entry) => typeof entry === 'string' && entry.length >= 3);
  const privateNumbers = [
    customerData?.cpfCnpj,
    customerData?.phone,
    customerData?.postalCode,
    customerData?.addressNumber
  ].filter((entry) => entry !== undefined && entry !== null).map(String);
  const description = privateValues.reduce(
    (text, privateValue) => text.split(privateValue).join('[dado redigido]'),
    String(value || 'Erro sem descrição retornada pelo provedor.')
  );
  const redactedDescription = privateNumbers.reduce((text, privateValue) => {
    if (!privateValue) return text;
    const escapedValue = privateValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`(?<!\\d)${escapedValue}(?!\\d)`, 'g'), '[dado redigido]');
  }, description);

  return redactedDescription
    .replace(/(?:access[_ -]?token|authorization|api[_ -]?key|bearer)\s*[:=]?\s*[^\s,;]+/ig, '[redigido]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[e-mail redigido]')
    .replace(/https?:\/\/[^\s"'<>]+/ig, '[URL redigida]')
    .replace(/\b\d{10,19}\b/g, '[dado redigido]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300);
}

function getResponseContentType(error) {
  const headers = error.response?.headers;
  const value = typeof headers?.get === 'function'
    ? headers.get('content-type')
    : headers?.['content-type'] || headers?.['Content-Type'];

  return typeof value === 'string' ? value.split(';')[0].trim().slice(0, 100) : null;
}

function getResponseBodyType(error, contentType) {
  if (!error.response) return 'NO_RESPONSE';
  if (contentType && /(?:application|text)\/(?:[^;]+\+)?json/i.test(contentType)) return 'JSON';
  if (contentType === 'text/html') return 'HTML';

  const body = error.response.data;
  if (typeof body === 'string' && /^\s*(?:<!doctype\s+html|<html\b)/i.test(body)) {
    return 'HTML';
  }

  return 'NON_JSON';
}

function logProviderFailure(error, customerData, orderId, requestUrl) {
  const contentType = getResponseContentType(error);
  const bodyType = getResponseBodyType(error, contentType);
  const providerErrors = Array.isArray(error.response?.data?.errors)
    ? error.response.data.errors
    : [];
  const entries = providerErrors.length
    ? providerErrors.map((item) => ({
      code: typeof item.code === 'string' ? item.code.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) : null,
      description: sanitizeDescription(item.description, customerData)
    }))
    : [{
      code: null,
      description: bodyType === 'HTML'
        ? 'Resposta externa em HTML; conteúdo omitido.'
        : sanitizeDescription(error.code || error.message, customerData)
    }];
  const status = error.response?.status || null;
  const headers = error.response?.headers;
  const redirectLocation = typeof headers?.get === 'function'
    ? headers.get('location')
    : headers?.location || headers?.Location;

  console.error('[Asaas] Falha ao criar checkout', JSON.stringify({
    endpoint: requestUrl.replace(/[?#].*$/, ''),
    orderId,
    httpStatus: status,
    contentType,
    redirected: Boolean(redirectLocation) || Boolean(status && status >= 300 && status < 400),
    bodyType,
    providerErrors: entries
  }));

  return entries[0];
}

function getCallbackBaseUrl() {
  let callbackUrl;

  try {
    callbackUrl = new URL(process.env.APP_BASE_URL || '');
  } catch {
    throw new AsaasServiceError({
      type: 'ASAAS_CONFIG_ERROR',
      failureCode: 'ASAAS_CALLBACK_URL_CONFIG_ERROR',
      details: 'Configure APP_BASE_URL com uma URL de callback acessível pelo Asaas Sandbox.'
    });
  }

  if (
    !['http:', 'https:'].includes(callbackUrl.protocol)
    || ['localhost', '127.0.0.1', '[::1]'].includes(callbackUrl.hostname)
    || callbackUrl.username
    || callbackUrl.password
  ) {
    throw new AsaasServiceError({
      type: 'ASAAS_CONFIG_ERROR',
      failureCode: 'ASAAS_CALLBACK_URL_CONFIG_ERROR',
      details: 'APP_BASE_URL não pode apontar para localhost e deve ser acessível pelo Asaas Sandbox.'
    });
  }

  return callbackUrl.toString().replace(/\/$/, '');
}

async function createCheckout(customerData, publicId) {
  let config;

  try {
    config = getAsaasConfig();
  } catch {
    throw new AsaasServiceError({
      type: 'ASAAS_CONFIG_ERROR',
      failureCode: 'ASAAS_CONFIG_ERROR',
      details: 'A integração Sandbox não está configurada corretamente.'
    });
  }

  if (!config.apiKey) {
    throw new AsaasServiceError({
      type: 'ASAAS_CONFIG_ERROR',
      failureCode: 'ASAAS_CONFIG_ERROR',
      details: 'A chave Sandbox não está configurada no backend.'
    });
  }

  const appBaseUrl = getCallbackBaseUrl();
  const payload = {
    billingTypes: ['CREDIT_CARD'],
    chargeTypes: ['DETACHED'],
    externalReference: publicId,
    callback: {
      successUrl: `${appBaseUrl}/checkout/success?order=${encodeURIComponent(publicId)}`,
      cancelUrl: `${appBaseUrl}/checkout/cancel?order=${encodeURIComponent(publicId)}`
    },
    items: [
      {
        name: 'Gift Card Digital',
        description: 'Gift Card Digital no valor de R$ 100,00.',
        imageBase64: productImageBase64,
        quantity: 1,
        value: 100
      }
    ],
    customerData
  };

  const requestUrl = `${config.baseUrl}/checkouts`;

  try {
    const response = await axios.post(requestUrl, payload, {
      headers: {
        access_token: config.apiKey,
        'User-Agent': 'SecureDigitalCheckout/1.0.0',
        'Content-Type': 'application/json'
      },
      maxRedirects: 0,
      timeout: 15000
    });
    const checkoutUrl = new URL(response.data?.link || '');

    if (
      typeof response.data?.id !== 'string'
      || checkoutUrl.protocol !== 'https:'
      || checkoutUrl.hostname !== 'sandbox.asaas.com'
    ) {
      throw new Error('Resposta de checkout inválida.');
    }

    return { id: response.data.id, link: checkoutUrl.toString() };
  } catch (error) {
    if (error instanceof AsaasServiceError) {
      throw error;
    }

    const providerError = logProviderFailure(error, customerData, publicId, requestUrl);
    const bodyType = getResponseBodyType(error, getResponseContentType(error));
    const details = bodyType === 'HTML' || bodyType === 'NON_JSON'
      ? 'O provedor respondeu em formato inesperado.'
      : providerError.description === 'Resposta de checkout inválida.'
        ? 'O provedor retornou uma resposta inválida.'
        : providerError.description;

    throw new AsaasServiceError({
      status: error.response?.status,
      providerCode: providerError.code,
      details
    });
  }
}

module.exports = { AsaasServiceError, createCheckout };