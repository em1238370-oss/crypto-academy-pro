# 🚀 Пошаговая настройка Render

## 📋 ШАГ 1: Загрузить проект в GitHub

**Если проекта нет в GitHub:**

1. **Создайте новый репозиторий на GitHub:**
   - Перейдите на https://github.com/new
   - Название: `crypto-academy-pro`
   - Сделайте его **Private** (или Public)
   - Нажмите "Create repository"

2. **Загрузите проект:**
   ```bash
   cd /Users/macmini/crypto-website
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/em1238370-oss/crypto-academy-pro.git
   git push -u origin main
   ```

**Если проект уже в GitHub:**
- Выберите его из списка в Render

---

## 📋 ШАГ 2: Настройка в Render

**На странице, которую вы видите:**

1. **Repository:**
   - Выберите репозиторий из списка (или создайте новый)

2. **Name:**
   - Введите: `crypto-academy-pro`

3. **Language:**
   - Уже выбрано: `Node` ✅

4. **Branch:**
   - Уже выбрано: `main` ✅

5. **Region:**
   - Оставьте: `Oregon (US West)` ✅

6. **Нажмите "Continue"** (или "Next")

---

## 📋 ШАГ 3: Настройка Build и Start команд

**На следующей странице нужно будет указать:**

1. **Root Directory:** (оставьте пустым)

2. **Build Command:**
   ```
   cd backend && npm install
   ```

3. **Start Command:**
   ```
   cd backend && npm start
   ```

4. **Plan:**
   - Выберите: **Free** ✅

5. **Нажмите "Create Web Service"**

---

## 📋 ШАГ 4: Добавить переменные окружения

**После создания сервиса:**

1. Перейдите в **Environment** (или **Environment Variables**)
2. Добавьте переменные из `.env` файла:
   - `NOWPAYMENTS_API_KEY=AWSK5JE-ZD5MGYE-QH1F0F2-BNHA3YA`
   - `NOWPAYMENTS_IPN_SECRET=b1GhzIDJRz7AIKZ9ZETY/ZiN2yx42Rgf`
   - `MISTRAL_API_KEY=your_mistral_api_key_here`
   - `APP_BASE_URL=https://crypto-academy-pro.onrender.com` (URL будет после деплоя)
   - И другие переменные из `.env`

---

## 📋 ШАГ 5: Получить URL

**После деплоя:**
- Render даст вам URL (например: `https://crypto-academy-pro.onrender.com`)
- Обновите `APP_BASE_URL` в переменных окружения
- Обновите Webhook URL в NOWPayments

---

**Сейчас:** Выберите репозиторий или создайте новый на GitHub!

