(() => {
  const customer = {
    name: 'João da Silva',
    cpfCnpj: '52998224725',
    email: 'joao.silva@example.com',
    phone: '11999999999',
    postalCode: '01310-100',
    address: 'Avenida Paulista',
    addressNumber: '1000',
    province: 'Bela Vista'
  };

  document.querySelectorAll('[data-form-preset]').forEach(button => {
    button.addEventListener('click', () => {
      const form = button.closest('form');
      if (form.querySelector('[type="submit"]').disabled) return;
      const approve = button.dataset.formPreset === 'approve';
      const values = button.dataset.formPreset === 'customer' ? customer : {
        ...customer,
        holderName: customer.name,
        cardNumber: approve ? '4444 4444 4444 4444' : '5184019740373151',
        expiryMonth: '12',
        expiryYear: '2028',
        ccv: '123'
      };

      Object.entries(values).forEach(([id, value]) => {
        const input = form.querySelector(`#${id}`);
        if (!input) return;
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      form.querySelector('.preset-status').textContent =
        button.dataset.formPreset === 'customer'
          ? 'Dados de teste preenchidos.'
          : `Dados de teste preenchidos: ${approve ? 'aprovação' : 'rejeição'}.`;
    });
  });
})();
