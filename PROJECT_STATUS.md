# 📊 СТАТУС ПРОЕКТА Crypto Academy Pro

**Дата обновления:** 14 декабря 2024  
**Версия:** 1.0.0

---

## 🎯 О ПРОЕКТЕ

**Crypto Academy Pro** - это веб-сайт с подпиской для обучения криптовалютам:
- 🤖 AI-чатбот на базе Mistral AI
- 💳 Система оплаты подписки ($10/месяц)
- 📰 Разделы: News, Risk Distribution, Crypto Basics, Crypto Coach
- 🌐 Публичный деплой на Render

---

## ✅ ЧТО УЖЕ РАБОТАЕТ

### 1. Структура проекта
- ✅ Главная страница (`index.html`) с красивым дизайном
- ✅ Backend сервер (`backend/server.js`) с полной интеграцией платежей
- ✅ AI-чатбот (`scripts/chatbot.js`)
- ✅ Подсайты в папке `sub-sites/`:
  - News
  - Risk Distribution
  - Crypto Basics
  - Crypto Coach

### 2. Платежные системы (интеграция готова)
- ✅ **NOWPayments** - международные карты + крипта (Russia-friendly)
- ✅ **CryptoCloud** - криптовалютные платежи
- ✅ **CloudPayments** - карты (российские)
- ✅ **CoinGate** - карты (европейские и американские)
- ✅ **YooKassa** - карты (российские)
- ✅ **Stripe** - карты (американские и европейские)

### 3. Деплой
- ✅ Сайт задеплоен на Render
- ✅ URL: `https://crypto-academy-pro.onrender.com`

---

## ⚠️ ЧТО НУЖНО НАСТРОИТЬ

### 1. Environment Variables в Render

**Текущие переменные (нужно проверить):**
- `NOWPAYMENTS_API_KEY` - API ключ NOWPayments
- `NOWPAYMENTS_IPN_SECRET` - секретный ключ для webhook
- `MISTRAL_API_KEY` - ключ для AI-чатбота
- `CRYPTOCLOUD_API_KEY` и `CRYPTOCLOUD_SHOP_ID` - для криптоплатежей
- `CLOUDPAYMENTS_PUBLIC_ID` и `CLOUDPAYMENTS_API_SECRET` - для карт
- `COINGATE_API_KEY` - для CoinGate
- `YOOKASSA_SHOP_ID` и `YOOKASSA_SECRET_KEY` - для YooKassa
- `STRIPE_SECRET_KEY` и `STRIPE_PUBLISHABLE_KEY` - для Stripe

**Нужно добавить/проверить:**
- ✅ `APP_BASE_URL` = `https://crypto-academy-pro.onrender.com`
- ✅ `PORT` = `10000` (или порт, который использует Render)
- ✅ `SUBSCRIPTION_PRICE_USD` = `10` (по умолчанию)
- ✅ `SUBSCRIPTION_PERIOD_DAYS` = `30` (по умолчанию)
- ✅ `FREE_TRIAL_HOURS` = `24` (по умолчанию)

### 2. NOWPayments Webhook URL

**В личном кабинете NOWPayments нужно установить:**
- Webhook URL: `https://crypto-academy-pro.onrender.com/api/payments/nowpayments/callback`
- IPN Secret: должен совпадать с `NOWPAYMENTS_IPN_SECRET` в Render

### 3. Проверка работы

**Нужно проверить:**
1. ✅ Сайт открывается: https://crypto-academy-pro.onrender.com
2. ✅ Чатбот работает и отвечает на вопросы
3. ✅ Кнопка "Pay with Card" создает платеж через NOWPayments
4. ✅ Webhook получает уведомления о платежах
5. ✅ Подписка активируется после успешной оплаты

---

## 📁 СТРУКТУРА ПРОЕКТА

```
crypto-website/
├── index.html              # Главная страница
├── styles.css              # Стили
├── server.js               # Простой сервер (не используется?)
├── backend/
│   └── server.js           # Полный сервер с интеграциями (ИСПОЛЬЗУЕТСЯ)
├── scripts/
│   └── chatbot.js          # Логика чатбота на фронтенде
├── sub-sites/              # Подсайты
│   ├── news/
│   ├── risk-distribution/
│   ├── crypto-basics/
│   └── crypto-coach/
├── .env                    # Локальные переменные (не в git)
├── .env.example            # Шаблон переменных
└── [много .md файлов]      # Документация по настройке
```

---

## 🔧 ТЕХНИЧЕСКИЕ ДЕТАЛИ

### Backend (backend/server.js)
- **Framework:** Express.js
- **Порт:** 4000 (локально) / 10000 (Render)
- **API Endpoints:**
  - `GET /api/status` - проверка статуса подписки
  - `POST /api/chat` - запросы к AI-чатботу
  - `POST /api/payments/nowpayments/invoice` - создание платежа
  - `POST /api/payments/nowpayments/callback` - webhook от NOWPayments
  - И другие endpoints для других платежных систем

### Frontend
- **HTML/CSS/JS** без фреймворков
- **Chatbot:** работает через API на бэкенде
- **Payment Modal:** модальное окно для оплаты

### Хранение данных
- ⚠️ **Временное хранилище в памяти** (Map)
- ⚠️ При перезапуске сервера данные теряются
- 💡 **Нужно добавить базу данных** (PostgreSQL, MongoDB, или SQLite)

---

## 🚀 СЛЕДУЮЩИЕ ШАГИ

### Приоритет 1: Настройка Render
1. Проверить все Environment Variables в Render
2. Убедиться, что `APP_BASE_URL` установлен правильно
3. Убедиться, что `PORT` установлен правильно

### Приоритет 2: Настройка NOWPayments
1. Войти в личный кабинет NOWPayments
2. Установить Webhook URL: `https://crypto-academy-pro.onrender.com/api/payments/nowpayments/callback`
3. Убедиться, что IPN Secret совпадает с переменной в Render

### Приоритет 3: Тестирование
1. Открыть сайт на Render
2. Протестировать чатбот
3. Протестировать создание платежа (тестовый режим)
4. Проверить, что webhook получает уведомления

### Приоритет 4: Улучшения (опционально)
1. Добавить базу данных для хранения пользователей
2. Добавить логирование
3. Добавить админ-панель
4. Улучшить обработку ошибок

---

## 📝 ЗАМЕТКИ

- Проект использует **ES Modules** (`type: "module"` в package.json)
- Backend сервер находится в папке `backend/`, а не в корне
- Есть два server.js файла - используется `backend/server.js`
- Все платежные системы интегрированы, но нужно настроить API ключи

---

## 🔗 ПОЛЕЗНЫЕ ССЫЛКИ

- **Сайт:** https://crypto-academy-pro.onrender.com
- **NOWPayments:** https://nowpayments.io
- **Render Dashboard:** https://dashboard.render.com
- **Mistral AI:** https://mistral.ai

---

**Готов продолжать работу над проектом! 🚀**


