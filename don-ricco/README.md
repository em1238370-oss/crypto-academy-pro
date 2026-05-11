# Don Ricco

Отдельное мобильное приложение-витрина. Оно не импортирует стили, скрипты или API основного сайта.

Текущая версия сделана как mobile-first product page в стиле Whop: product image, цена, Get access, автор, длинный продающий текст, FAQ и нижняя sticky-кнопка покупки.

## Структура

```text
don-ricco/
├── index.html
├── styles.css
└── scripts/
    └── app.js
```

## Оплата

Кнопки покупки книги используют переменную `RUSSIAN_PAYMENT_URL` в `scripts/app.js`.

Для российской оплаты проще всего вставить payment-link от YooKassa, Robokassa или CloudPayments:

```js
const RUSSIAN_PAYMENT_URL = 'https://your-payment-link.example';
```

После этого кнопки будут вести человека на оплату картой, через СБП, SberPay или другие доступные методы провайдера.
