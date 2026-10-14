const form = document.querySelector('#checkout-form');
const button = document.querySelector('#buy-button');
const resultPanel = document.querySelector('#checkout-result');
const resultTitle = document.querySelector('#result-title');
const resultMessage = document.querySelector('#result-message');
const checkoutLink = document.querySelector('#checkout-link');
const orderSummary = document.querySelector('#order-summary');
const orderDetailLink = document.querySelector('#order-detail-link');
const retryButton = document.querySelector('#retry-button');

function setSteps(states) {
  for (const step of document.querySelectorAll('#order-steps [data-step]')) {
    const state = states[step.dataset.step] || 'pending';
    const icon = step.querySelector('.step-icon');
    step.dataset.state = state;
    icon.textContent = state === 'done' ? '✓' : state === 'error' ? '×' : state === 'active' ? '…' : '';
  }
}

function setOrderSummary(order) {
  if (!order) return;
  document.querySelector('#result-order').textContent = order.number;
  document.querySelector('#result-amount').textContent = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(order.amount);
  document.querySelector('#result-status').textContent = order.status === 'CHECKOUT_CREATED'
    ? 'Aguardando pagamento'
    : 'Checkout não criado';
  orderSummary.hidden = false;
  orderDetailLink.href = `/order/${encodeURIComponent(order.publicId)}`;
  orderDetailLink.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  form.hidden = true;
  resultPanel.hidden = false;
  resultTitle.textContent = 'Processando sua compra';
  resultMessage.textContent = 'Validando os dados e solicitando um checkout seguro.';
  setSteps({ data: 'done', order: 'active', checkout: 'active' });

  const formData = new FormData(form);
  const buyer = Object.fromEntries(formData.entries());

  try {
    const response = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buyer)
    });
    const result = await readApiJsonResponse(response);

    if (!response.ok) {
      if (result.order) {
        setOrderSummary(result.order);
        setSteps({ data: 'done', order: 'done', checkout: 'error' });
      } else {
        resultPanel.hidden = true;
        form.hidden = false;
        throw new Error(result.error?.message || 'Revise os dados informados.');
      }
      resultTitle.textContent = 'Não foi possível iniciar o pagamento';
      resultMessage.textContent = result.error?.details || result.error?.message || 'Nenhuma cobrança foi realizada.';
      resultMessage.dataset.state = 'error';
      resultMessage.dataset.code = result.error?.code || result.error?.type || '';
      retryButton.hidden = false;
      return;
    }

    setOrderSummary(result.order);
    setSteps({ data: 'done', order: 'done', checkout: 'done' });
    resultTitle.textContent = 'Checkout seguro criado';
    resultMessage.textContent = 'O pagamento ainda está aguardando confirmação segura.';
    resultMessage.dataset.state = 'success';
    checkoutLink.href = result.checkoutUrl;
    checkoutLink.hidden = false;
  } catch (error) {
    resultPanel.hidden = false;
    resultTitle.textContent = 'Não foi possível iniciar o pagamento';
    resultMessage.textContent = error.message === unexpectedApiResponseMessage
      ? unexpectedApiResponseMessage
      : 'Não foi possível conectar ao servidor. Tente novamente.';
    resultMessage.dataset.state = 'error';
    setSteps({ data: 'error' });
    retryButton.hidden = false;
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
});

retryButton.addEventListener('click', () => window.location.reload());
