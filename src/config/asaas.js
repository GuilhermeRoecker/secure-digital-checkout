const SANDBOX_BASE_URL = 'https://api-sandbox.asaas.com/v3';

function getAsaasConfig() {
  const baseUrl = process.env.ASAAS_BASE_URL || SANDBOX_BASE_URL;
  const parsedBaseUrl = new URL(baseUrl);

  if (parsedBaseUrl.protocol !== 'https:' || parsedBaseUrl.hostname !== 'api-sandbox.asaas.com') {
    throw new Error('A aplicação está configurada exclusivamente para o Asaas Sandbox.');
  }

  return {
    apiKey: process.env.ASAAS_API_KEY,
    baseUrl: baseUrl.replace(/\/$/, '')
  };
}

module.exports = { getAsaasConfig };
