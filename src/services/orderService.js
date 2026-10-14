const { randomUUID } = require('node:crypto');
const orderRepository = require('../repositories/orderRepository');
const { AsaasServiceError, createCheckout } = require('./asaasService');

const PRODUCT = Object.freeze({ name: 'Gift Card Digital', amount: 100 });

async function createOrder(customer) {
  const publicId = randomUUID();
  const order = await orderRepository.createOrder({
    publicId,
    customer,
    productName: PRODUCT.name,
    amount: PRODUCT.amount
  });

  await orderRepository.addEvent(publicId, 'CHECKOUT_REQUESTED', 'Solicitação enviada ao Asaas Sandbox.');

  try {
    const checkout = await createCheckout({
      name: customer.name,
      cpfCnpj: customer.cpfCnpj,
      email: customer.email,
      phone: customer.phone,
      address: customer.address,
      addressNumber: customer.addressNumber,
      postalCode: customer.postalCode,
      province: customer.province
    }, publicId);
    const updatedOrder = await orderRepository.markCheckoutCreated(publicId, checkout);

    return { success: true, order: updatedOrder, checkout };
  } catch (error) {
    if (!(error instanceof AsaasServiceError)) {
      throw error;
    }

    const failedOrder = await orderRepository.markCheckoutError(
      publicId,
      error.failureCode,
      error.details
    );

    return {
      success: false,
      order: failedOrder,
      error: {
        type: error.type,
        message: error.message,
        details: error.details,
        code: error.failureCode
      }
    };
  }
}

module.exports = { createOrder };
