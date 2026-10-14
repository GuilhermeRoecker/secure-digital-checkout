const unexpectedApiResponseMessage = 'Foi recebida uma resposta inesperada do servidor.';

async function readApiJsonResponse(response) {
  const contentType = response.headers.get('content-type') || '';

  if (!/(^|\/)(?:[^;]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new Error(unexpectedApiResponseMessage);
  }

  try {
    return await response.json();
  } catch {
    throw new Error(unexpectedApiResponseMessage);
  }
}
