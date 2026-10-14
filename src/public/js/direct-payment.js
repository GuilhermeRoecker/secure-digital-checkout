const directForm = document.querySelector('#direct-payment-form');
const directButton = document.querySelector('#buy-button');
const directPanel = document.querySelector('#direct-payment-result');
const directMessage = document.querySelector('#direct-payment-message');
const sensitiveFields = ['holderName', 'cardNumber', 'expiryMonth', 'expiryYear', 'ccv'];
let submitting = false;

// Identificador técnico em memória, sem persistir cartão ou tentativa no storage do browser.
const attemptId = window.crypto.randomUUID();
function clearCard() {
  sensitiveFields.forEach(id => { document.getElementById(id).value = ''; });
}
window.addEventListener('pagehide', clearCard);
window.addEventListener('pageshow', clearCard);

directForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (submitting) return;
  submitting = true;
  directButton.disabled = true;
  directButton.setAttribute('aria-busy', 'true');
  directPanel.hidden = false;
  directMessage.textContent = 'Enviando pagamento de teste. Aguarde antes de tentar novamente.';
  const tracking = document.querySelector('#direct-order-link');
  tracking.href = `/order/${attemptId}`;
  tracking.hidden = false;
  let body;
  try {
    const customer = Object.fromEntries(new FormData(directForm).entries());
    body = {
      attemptId, customer,
      creditCard: { holderName: document.querySelector('#holderName').value,
        number: document.querySelector('#cardNumber').value.replace(/[\s-]/g, ''),
        expiryMonth: document.querySelector('#expiryMonth').value,
        expiryYear: document.querySelector('#expiryYear').value,
        ccv: document.querySelector('#ccv').value },
      // Campos do guia Asaas. Offset em HORAS; userAgent e IP são obtidos no backend.
      deviceInfo: { colorDepth: window.screen.colorDepth, screenHeight: window.screen.height,
        screenWidth: window.screen.width, timeZoneOffset: new Date().getTimezoneOffset() / 60,
        language: navigator.language }
    };
    const requestBody = JSON.stringify(body);
    clearCard();
    const response = await fetch('/api/payments/direct', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestBody
    });
    const result = await readApiJsonResponse(response);
    if (!response.ok) {
      if (response.status === 400 && !result.orderPublicId) {
        submitting = false;
        directButton.disabled = false;
        tracking.hidden = true;
      }
      directMessage.textContent = result.error?.message || 'Não foi possível concluir. Consulte o pedido antes de tentar novamente.';
      return;
    }
    directMessage.textContent = '3DS enviado ao Asaas. No Sandbox, a autenticação é aprovada automaticamente e o desafio do emissor não é exibido. Aguardando confirmação do pagamento por webhook.';
    if (result.challengeRequired && result.challengeUrl) {
      const challenge = new URL(result.challengeUrl);
      if (challenge.protocol !== 'https:' || challenge.username || challenge.password) throw new Error();
      const link = document.querySelector('#direct-challenge-link');
      link.href = challenge.href;
      link.hidden = false;
      directMessage.textContent = 'O emissor solicitou autenticação. Você será encaminhado para concluir o desafio.';
      window.location.assign(challenge.href);
    }
  } catch {
    directMessage.textContent = 'O resultado ainda não está disponível. Consulte o pedido antes de tentar novamente.';
  } finally {
    if (body) { body.creditCard.number = ''; body.creditCard.ccv = ''; }
    body = undefined;
    clearCard();
    directButton.removeAttribute('aria-busy');
    // Não reenvia cobrança após timeout/resultado incerto. Nova tentativa precisa ser consciente.
  }
});
