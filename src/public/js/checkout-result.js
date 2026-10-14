const callbackIs3ds = window.location.pathname === '/payments/3ds/callback';
const callbackIsCancel = window.location.pathname === '/checkout/cancel';
const orderPublicId = new URLSearchParams(window.location.search).get('order');
const callbackTitle = document.querySelector('#callback-title');
const callbackMessage = document.querySelector('#callback-message');

if (callbackIsCancel) {
  callbackTitle.textContent = 'Checkout encerrado';
  callbackMessage.textContent = 'Estamos consultando o status confirmado pelo provedor.';
}

async function loadOrderStatus() {
  if (!orderPublicId) {
    document.querySelector('#callback-order').textContent = 'Não identificado';
    callbackMessage.textContent = 'Não foi possível identificar o pedido. Consulte a página de pedidos.';
    return;
  }

  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(orderPublicId)}`);
    const result = await readApiJsonResponse(response);
    if (!response.ok) throw new Error(result.error?.message || 'Pedido não encontrado.');

    const order = result.order;
    document.querySelector('#callback-delivery-code').textContent = '';
    document.querySelector('#callback-delivery-code-panel').hidden = true;
    document.querySelector('#callback-order').textContent = order.number;
    document.querySelector('#callback-payment').textContent = order.paymentStatus;
    document.querySelector('#callback-delivery').textContent = order.deliveryStatus;
    const orderLink = document.querySelector('#callback-order-link');
    orderLink.href = `/order/${encodeURIComponent(order.publicId)}`;
    orderLink.hidden = false;

    if (order.status === 'CONFIRMED' && order.deliveryStatus === 'Liberada' && order.deliveryCode) {
      callbackTitle.textContent = 'Pagamento confirmado';
      callbackMessage.textContent = 'O Asaas confirmou o pagamento e o Gift Card foi liberado.';
      document.querySelector('#callback-delivery-code').textContent = order.deliveryCode;
      document.querySelector('#callback-delivery-code-panel').hidden = false;
      return;
    }

    callbackTitle.textContent = callbackIs3ds ? 'Retorno da autenticação' : callbackIsCancel ? 'Checkout encerrado' : 'Pagamento enviado';
    callbackMessage.textContent = 'Estamos aguardando a confirmação do provedor. O retorno do navegador não confirma o pagamento.';
  } catch (error) {
    callbackMessage.textContent = error.message;
  }
}

loadOrderStatus();

setInterval(() => { if (!document.hidden) loadOrderStatus(); }, 5000);
