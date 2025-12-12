# Crypto Academy Pro

AI-powered cryptocurrency assistant website with subscription system.

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your API keys:

```bash
cp .env.example .env
```

Edit `.env` and add your:
- `MISTRAL_API_KEY` - For AI chat responses
- `CRYPTOCLOUD_API_KEY` and `CRYPTOCLOUD_SHOP_ID` - For crypto payments
- `CLOUDPAYMENTS_PUBLIC_ID` and `CLOUDPAYMENTS_API_SECRET` - For card payments (optional)

### 3. Start the Server

```bash
npm start
```

The website will be available at:
- **Frontend**: http://localhost:4000/index.html (or just http://localhost:4000)
- **API**: http://localhost:4000/api/...

## 📁 Project Structure

```
crypto-website/
├── index.html          # Main HTML page
├── styles.css          # All styles
├── server.js           # Backend server (API + static files)
├── scripts/
│   └── chatbot.js      # Frontend chat logic
├── package.json        # Dependencies
├── .env.example        # Environment variables template
└── .env               # Your actual API keys (not in git)
```

## 🌐 Deploying for Public Access

### Option 1: Deploy to Vercel/Netlify (Frontend) + Railway/Render (Backend)

**Backend (Railway/Render):**
1. Push code to GitHub
2. Connect to Railway or Render
3. Set environment variables in dashboard
4. Deploy

**Frontend:**
- The server already serves static files, so you can deploy the whole project as one app
- Or use Vercel/Netlify and set `API_BASE_URL` environment variable

### Option 2: Single Server Deployment (Recommended)

Deploy everything to one server (Railway, Render, Heroku, etc.):

1. Push code to GitHub
2. Connect repository to hosting service
3. Set environment variables
4. Deploy

The server will serve both:
- Static files (HTML, CSS, JS) at root
- API endpoints at `/api/*`

## 🔧 Configuration

- `PORT` - Server port (default: 4000)
- `APP_BASE_URL` - Your public URL (for payment callbacks)
- `SUBSCRIPTION_PRICE_USD` - Subscription price (default: $10)
- `SUBSCRIPTION_PERIOD_DAYS` - Subscription duration (default: 30 days)
- `FREE_TRIAL_HOURS` - Free trial duration (default: 24 hours)

## 📝 Notes

- The chatbot automatically detects the API URL based on the current domain
- For localhost, it uses `http://localhost:4000`
- For production, it uses the current origin (same domain)

