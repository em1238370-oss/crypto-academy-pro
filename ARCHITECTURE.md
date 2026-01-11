# System Architecture Documentation

## 🏗️ Architecture Overview

Crypto Academy Pro is a full-stack web application with the following architecture:

```
┌─────────────────────────────────────────┐
│         Frontend (Static HTML)          │
│  - index.html (Landing page)            │
│  - sub-sites/ (Feature modules)         │
│  - styles.css (Styling)                 │
│  - scripts/ (Client-side JS)            │
└──────────────┬──────────────────────┘
               │
               │ HTTP/HTTPS
               │
┌──────────────▼──────────────────────┐
│      Backend (Express.js)            │
│  - server.js (Main server)            │
│  - API endpoints                      │
│  - Payment processing                 │
│  - AI chat integration                │
└──────────────┬──────────────────────┘
               │
       ┌───────┼───────┐
       │       │       │
┌──────▼──┐ ┌──▼───┐ ┌─▼────────┐
│ Mistral │ │Crypto│ │CloudPay  │
│   AI    │ │Cloud │ │  ments   │
└─────────┘ └──────┘ └──────────┘
```

---

## 📁 Project Structure

```
crypto-academy-pro/
├── index.html                 # Main landing page
├── server.js                  # Express backend server
├── styles.css                 # Global stylesheet
├── package.json               # Dependencies
├── .env                       # Environment variables
├── .cursorrules               # Cursor AI rules
│
├── scripts/                   # Client-side JavaScript
│   ├── chatbot.js            # AI chat widget
│   └── scroll-optimizer.js   # Performance optimization
│
├── sub-sites/                 # Feature modules
│   ├── news/                  # News aggregator
│   │   ├── index.html
│   │   └── scripts/
│   │
│   ├── crypto-basics/         # Educational course
│   │   ├── index.html
│   │   ├── course.js
│   │   └── scripts/
│   │
│   ├── crypto-coach/          # Portfolio advisor
│   │   ├── index.html
│   │   └── scripts/
│   │
│   └── risk-distribution/     # Risk management
│       └── index.html
│
└── backend/                   # Additional backend services
    ├── server.js
    └── package.json
```

---

## 🔧 Technology Stack

### Frontend
- **HTML5** - Structure
- **CSS3** - Styling (custom, no framework)
- **Vanilla JavaScript** - No frameworks
- **Fonts:** Google Fonts (Poppins, Raleway)

### Backend
- **Node.js** - Runtime
- **Express.js** - Web framework
- **dotenv** - Environment variables
- **axios** - HTTP client
- **crypto** - Cryptographic functions

### External Services
- **Mistral AI** - AI chat assistant
- **CryptoCloud** - Cryptocurrency payments
- **CloudPayments** - Card payments
- **Render** - Hosting platform

---

## 🔄 Data Flow

### User Request Flow

1. **User visits site** → `index.html` loads
2. **User clicks feature** → Navigate to `sub-sites/[feature]/`
3. **User uses chat** → JavaScript calls `/api/chat`
4. **Backend processes** → Calls Mistral AI API
5. **Response sent** → Displayed in chat widget

### Payment Flow

1. **User clicks "Pay"** → Frontend calls `/api/create-crypto-invoice` or `/api/create-card-payment`
2. **Backend creates invoice** → Calls payment provider API
3. **Payment provider responds** → Returns payment details
4. **User completes payment** → Payment provider processes
5. **Webhook received** → Backend verifies and activates subscription
6. **Subscription active** → User gains access

---

## 💾 Data Storage

### Current Implementation
- **In-memory storage** (`Map` objects)
- User data stored in `users` Map
- Invoice data stored in `invoices` Map

### Production Recommendations
- **Database:** PostgreSQL or MongoDB
- **Session storage:** Redis
- **File storage:** AWS S3 or similar

---

## 🔐 Security

### Current Security Measures
1. **CORS** - Configured for allowed origins
2. **CSP Headers** - Content Security Policy
3. **Environment Variables** - Sensitive data in `.env`
4. **HTTPS** - Required in production

### Security Improvements Needed
- [ ] User authentication (JWT)
- [ ] Rate limiting
- [ ] Input validation
- [ ] SQL injection prevention
- [ ] XSS protection
- [ ] CSRF tokens

---

## 🚀 Deployment

### Hosting Platform
**Render.com** - https://crypto-academy-pro.onrender.com/

### Deployment Process
1. Code pushed to Git repository
2. Render detects changes
3. Builds application
4. Deploys to production
5. Environment variables configured

### Environment Setup
Required environment variables:
- `MISTRAL_API_KEY`
- `CRYPTOCLOUD_API_KEY`
- `CRYPTOCLOUD_SHOP_ID`
- `CLOUDPAYMENTS_PUBLIC_ID`
- `CLOUDPAYMENTS_API_SECRET`
- `APP_BASE_URL`

---

## 📊 Performance

### Optimization Strategies
1. **Static file serving** - Express static middleware
2. **Scroll optimization** - `scroll-optimizer.js`
3. **Lazy loading** - Load features on demand
4. **Minification** - Minify CSS/JS in production

### Performance Metrics
- **Page Load:** < 2 seconds
- **API Response:** < 500ms
- **Chat Response:** < 3 seconds (AI dependent)

---

## 🔌 API Integration

### Mistral AI
- **Purpose:** AI chat assistant
- **Endpoint:** `https://api.mistral.ai/v1/chat/completions`
- **Authentication:** API key in header
- **Rate Limits:** Per Mistral AI plan

### CryptoCloud
- **Purpose:** Cryptocurrency payments
- **Endpoint:** `https://api.cryptocloud.plus/v1/`
- **Authentication:** API key + Shop ID
- **Webhooks:** Payment status updates

### CloudPayments
- **Purpose:** Card payments
- **Endpoint:** `https://api.cloudpayments.ru/`
- **Authentication:** Public ID + API Secret
- **Webhooks:** Payment callbacks

---

## 🧪 Testing

### Local Development
```bash
# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Edit .env with your keys

# Run server
node server.js
```

### Testing Endpoints
- Use `curl` or Postman
- Test with localhost:4000
- Verify responses

---

## 📈 Scalability

### Current Limitations
- In-memory storage (lost on restart)
- Single server instance
- No load balancing

### Scaling Options
1. **Database migration** - Move to persistent storage
2. **Load balancing** - Multiple server instances
3. **Caching** - Redis for session storage
4. **CDN** - Static asset delivery

---

## 🔄 Related Projects

### crypto-mailer
Separate project for portfolio email alerts:
- **Location:** `/Users/elizavetamedvedeva/Documents/crypto-mailer/`
- **Purpose:** Email notifications for portfolio changes
- **Integration:** Can be integrated with Crypto Coach feature

---

## 📝 Development Guidelines

### Code Style
- Modern JavaScript (ES6+)
- Consistent naming conventions
- Comment complex logic
- Follow existing patterns

### File Organization
- Features in `sub-sites/`
- Shared scripts in `scripts/`
- Styles in `styles.css`
- Backend in `server.js`

### Documentation
- Keep documentation updated
- Document API changes
- Update feature status

---

## 🐛 Known Issues

1. **In-memory storage** - Data lost on restart
2. **No authentication** - Simple userId system
3. **No rate limiting** - API can be abused
4. **No error logging** - Limited error tracking

---

## 🎯 Future Improvements

- [ ] Database integration
- [ ] User authentication system
- [ ] Rate limiting middleware
- [ ] Error logging service
- [ ] Analytics integration
- [ ] Admin dashboard
- [ ] Email notifications
- [ ] Mobile app API

