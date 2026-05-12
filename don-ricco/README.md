# Don Ricco

Отдельное мобильное приложение-витрина. Оно не импортирует стили, скрипты или API основного сайта.

`index.html` — входная link-in-bio страница в стиле Linktree: профиль, короткое описание и две большие кнопки.

`product.html` — мобильная продуктовая страница на русском языке, близкая к структуре Whop product-page: верхняя навигация, строка академии, большая обложка продукта, цена, доступ, участники, автор, полный продающий текст, видимые строки частых вопросов, нижняя карточка продукта и повторные кнопки оплаты.

Визуальный слой использует палитру Don Ricco: Dark Coffee `#412722`, Apricot Cream `#F6D8AE`, Black Cherry `#6B0F1A`, Ruby Red `#A51C28`, Turf Green `#0C7C59`.

## Структура

```text
don-ricco/
├── index.html
├── product.html
├── entry.css
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
