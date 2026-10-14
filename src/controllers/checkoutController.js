const { createOrder } = require('../services/orderService');

function validateBuyer(body = {}) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const cpfCnpj = typeof body.cpfCnpj === 'string' ? body.cpfCnpj.replace(/\D/g, '') : '';
  const phone = typeof body.phone === 'string' ? body.phone.replace(/\D/g, '') : '';
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  const addressNumberInput = String(body.addressNumber ?? '').trim();
  const addressNumber = /^\d+$/.test(addressNumberInput) ? Number(addressNumberInput) : NaN;
  const postalCode = typeof body.postalCode === 'string' ? body.postalCode.replace(/\D/g, '') : '';
  const province = typeof body.province === 'string' ? body.province.trim() : '';

  if (name.length < 2 || name.length > 100) {
    return null;
  }

  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }

  if (
    ![11, 14].includes(cpfCnpj.length)
    || phone.length < 10
    || phone.length > 13
    || !address
    || !Number.isSafeInteger(addressNumber)
    || addressNumber < 0
    || addressNumber > 2147483647
    || postalCode.length !== 8
    || !province
  ) {
    return null;
  }

  return { name, email, cpfCnpj, phone, address, addressNumber, postalCode, province };
}

async function create(req, res, next) {
  const customerData = validateBuyer(req.body);

  if (!customerData) {
    return res.status(400).json({
      success: false,
      error: {
        type: 'VALIDATION_ERROR',
        message: 'Revise os dados pessoais e o endereço informados.'
      }
    });
  }

  try {
    const result = await createOrder(customerData);
    const order = {
      publicId: result.order.public_id,
      number: result.order.public_id.slice(0, 8).toUpperCase(),
      productName: result.order.product_name,
      amount: Number(result.order.amount),
      status: result.order.status,
      createdAt: result.order.created_at
    };

    if (!result.success) {
      return res.status(422).json({ success: false, order, error: result.error });
    }

    return res.status(201).json({
      success: true,
      order,
      checkoutUrl: result.checkout.link
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { create, validateBuyer };
