const RUSSIAN_PAYMENT_URL = '';

const paymentButtons = document.querySelectorAll('[data-payment-button]');

paymentButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (RUSSIAN_PAYMENT_URL) {
      window.location.href = RUSSIAN_PAYMENT_URL;
      return;
    }

    alert(
      'Демо-режим оплаты. Вставьте ссылку YooKassa, Robokassa или CloudPayments в RUSSIAN_PAYMENT_URL внутри don-ricco/scripts/app.js.'
    );
  });
});
