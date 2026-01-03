# Crypto Academy Pro

## 🌐 Live Site
**URL:** https://crypto-academy-pro.onrender.com/

## 📋 Overview
Crypto Academy Pro is a comprehensive cryptocurrency education and portfolio management platform. It provides users with tools to learn about crypto, manage their portfolios, track market news, and get AI-powered advice.

## 📚 Complete Documentation

### 📖 Quick Access
- **[DOCUMENTATION_INDEX.md](./DOCUMENTATION_INDEX.md)** - Complete documentation index and navigation

### English Documentation
Full documentation in English is available in [`docs/en/`](./docs/en/):
- [01_PROJECT_OVERVIEW.md](./docs/en/01_PROJECT_OVERVIEW.md) - Project overview, goals, philosophy
- [02_MAIN_MENU.md](./docs/en/02_MAIN_MENU.md) - Landing page and navigation
- [03_FEATURES_DETAILED.md](./docs/en/03_FEATURES_DETAILED.md) - Detailed feature descriptions
- [04_API_REFERENCE.md](./docs/en/04_API_REFERENCE.md) - Backend API endpoints
- [05_PAYMENT_INTEGRATION.md](./docs/en/05_PAYMENT_INTEGRATION.md) - Payment system integration
- [06_ARCHITECTURE.md](./docs/en/06_ARCHITECTURE.md) - System architecture
- [07_DEVELOPMENT_GUIDE.md](./docs/en/07_DEVELOPMENT_GUIDE.md) - Development instructions
- [08_DEPLOYMENT.md](./docs/en/08_DEPLOYMENT.md) - Deployment guide

### Русская Документация (Russian Documentation)
Полная документация на русском языке доступна в [`docs/ru/`](./docs/ru/):
- [01_ОБЗОР_ПРОЕКТА.md](./docs/ru/01_ОБЗОР_ПРОЕКТА.md) - Обзор проекта, цели, философия
- [02_ГЛАВНОЕ_МЕНЮ.md](./docs/ru/02_ГЛАВНОЕ_МЕНЮ.md) - Главная страница и навигация
- [03_ФУНКЦИИ_ПОДРОБНО.md](./docs/ru/03_ФУНКЦИИ_ПОДРОБНО.md) - Подробное описание функций

## 🏗️ Project Structure

```
crypto-academy-pro/
├── index.html          # Main landing page
├── server.js           # Express backend server
├── styles.css          # Main stylesheet
├── scripts/            # JavaScript modules
│   ├── chatbot.js     # AI chat widget
│   └── scroll-optimizer.js
├── sub-sites/         # Feature modules
│   ├── news/          # Crypto news aggregator
│   ├── crypto-basics/  # Educational course
│   ├── crypto-coach/   # Portfolio advisor
│   └── risk-distribution/ # Risk management tools
├── docs/               # Complete documentation
│   ├── en/            # English documentation
│   └── ru/            # Russian documentation
└── backend/           # Additional backend services
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- npm or yarn

### Installation
```bash
npm install
```

### Environment Variables
See `.env.example` for required variables:
- `MISTRAL_API_KEY` - AI chat functionality
- `CRYPTOCLOUD_API_KEY` & `CRYPTOCLOUD_SHOP_ID` - Crypto payments
- `CLOUDPAYMENTS_PUBLIC_ID` & `CLOUDPAYMENTS_API_SECRET` - Card payments
- `APP_BASE_URL` - Application base URL

### Run Locally
```bash
node server.js
```
Server runs on port 4000 by default.

## 🎯 Main Features

- **Free Features:**
  - News aggregator
  - Risk distribution calculator
  - Crypto basics course

- **Paid Features ($15/mo):**
  - Crypto Coach (personalized advice)
  - Smart Alerts
  - Cross Wallet management

- **Premium Features ($25/mo):**
  - AI Emotional Tracker
  - Investor Psychology Profile
  - Predictive AI Simulator

## 💬 AI Chat Assistant
Powered by Mistral AI, provides real-time crypto advice and answers questions about cryptocurrency.

## 💳 Subscription System
- Free trial: 24 hours
- Monthly subscription: $10/month
- Payment methods: Crypto (USDT) or Card (Visa/Mastercard)

## 📖 Related Projects
- **crypto-mailer** - Portfolio alert system with email notifications

---

**For detailed information, see [DOCUMENTATION_INDEX.md](./DOCUMENTATION_INDEX.md) or browse the [docs/](./docs/) folder.**
