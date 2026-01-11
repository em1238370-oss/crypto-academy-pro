# Features - Detailed Documentation

## 📰 News Module

### Location
`sub-sites/news/index.html`

### Purpose
Keep users informed about latest cryptocurrency news and market developments.

### Features
- Real-time news feed
- News categorization
- Header animations
- Responsive design

### Why This Feature?
- **User Need:** People want to stay updated
- **Value:** Saves time searching for news
- **Engagement:** Keeps users coming back
- **Free:** Attracts new users

### Technical Details
- **Scripts:** `scripts/header-animation.js`
- **Styling:** Inherits from main `styles.css`
- **Data Source:** News aggregation (to be implemented)

### Design Decisions
- Clean, readable layout
- Easy navigation
- Fast loading
- Mobile-friendly

### Access
- **Status:** ✅ Active
- **Subscription:** Free (no subscription required)
- **Target:** All users

---

## 📊 Risk Distribution Module

### Location
`sub-sites/risk-distribution/index.html`

### Purpose
Help users understand and manage their portfolio risk distribution.

### Features
- Portfolio risk analysis
- Risk visualization
- Smart risk management tools
- Distribution calculations

### Why This Feature?
- **User Need:** Investors need risk management
- **Value:** Prevents losses, optimizes portfolio
- **Education:** Teaches risk concepts
- **Free:** Essential tool, builds trust

### Use Cases
- Calculate portfolio risk
- Visualize risk distribution
- Get risk recommendations
- Optimize portfolio allocation

### Access
- **Status:** ✅ Active
- **Subscription:** Free (no subscription required)
- **Target:** Investors and traders

---

## 📚 Crypto Basics Course

### Location
`sub-sites/crypto-basics/index.html`

### Purpose
Educational course covering cryptocurrency fundamentals for beginners.

### Features
- Interactive course modules
- Table-based module navigation
- Course content pages
- Progress tracking

### Why This Feature?
- **User Need:** Beginners need education
- **Value:** Comprehensive learning resource
- **Retention:** Keeps users engaged
- **Free:** Attracts new users, builds community

### Course Structure
- Module-based learning
- Table of contents
- Interactive elements
- Progressive difficulty

### Files
- `index.html` - Main course page
- `course.js` - Course logic
- `course-content.html` - Course content
- `scripts/table-modules.js` - Module navigation

### Design Decisions
- **Modular:** Easy to add new modules
- **Table Navigation:** Clear structure
- **Interactive:** Engages learners
- **Progress Tracking:** Motivates completion

### Access
- **Status:** ✅ Active
- **Subscription:** Free (no subscription required)
- **Target:** Crypto beginners

---

## 🎓 Crypto Coach

### Location
`sub-sites/crypto-coach/index.html`

### Purpose
Personalized cryptocurrency advice and portfolio coaching.

### Features
- Personalized advice
- Portfolio analysis
- Investment recommendations
- Module-based interface

### Why This Feature?
- **User Need:** People want personalized advice
- **Value:** Saves time, provides expertise
- **Differentiation:** Unique AI-powered service
- **Paid:** Requires AI, ongoing costs

### How It Works
1. User enters portfolio information
2. System analyzes portfolio
3. AI generates personalized advice
4. User receives recommendations

### Files
- `index.html` - Main coach page
- `scripts/table-modules.js` - Module navigation
- `temp_modules.html` - Module templates

### Integration
Can be integrated with:
- **crypto-mailer** - Email alerts
- **Risk Distribution** - Risk analysis
- **News Module** - Market context

### Access
- **Status:** ✅ Active
- **Subscription:** Paid ($15/month)
- **Free Trial:** 24 hours
- **Target:** Active investors

---

## 🔔 Smart Alerts

### Status
🚧 In Development

### Planned Purpose
Smart notification system for cryptocurrency price movements and portfolio changes.

### Planned Features
- Price alerts
- Portfolio change notifications
- Custom alert rules
- Email/SMS notifications

### Why This Feature?
- **User Need:** Users want to be notified
- **Value:** Don't miss opportunities
- **Engagement:** Keeps users active
- **Paid:** Requires server resources, real-time monitoring

### Planned Integration
- **crypto-mailer:** Email notifications
- **Portfolio tracking:** Real-time monitoring
- **Price APIs:** Market data

### Access
- **Status:** 🚧 Coming soon
- **Subscription:** Paid ($15/month)
- **Free Trial:** 24 hours

---

## 💼 Cross Wallet

### Status
🚧 In Development

### Planned Purpose
Multi-wallet management system for tracking and managing cryptocurrency wallets.

### Planned Features
- Multiple wallet support
- Balance tracking
- Transaction history
- Wallet analytics

### Why This Feature?
- **User Need:** People have multiple wallets
- **Value:** Centralized management
- **Convenience:** One place for everything
- **Paid:** Complex integration, security requirements

### Planned Security
- Secure wallet connection
- Encrypted data storage
- No private keys stored
- Read-only access

### Access
- **Status:** 🚧 Coming soon
- **Subscription:** Paid ($15/month)
- **Free Trial:** 24 hours

---

## 🧠 AI Emotional Tracker

### Status
🚧 Planned

### Planned Purpose
AI-powered emotional pattern analysis for trading decisions.

### Planned Features
- Emotional state tracking
- Trading pattern analysis
- Risk assessment based on emotions
- Personalized recommendations

### Why This Feature?
- **User Need:** Emotions affect trading
- **Value:** Prevents emotional decisions
- **Innovation:** Unique AI feature
- **Premium:** Advanced AI, complex analysis

### How It Would Work
1. Track user's emotional state
2. Analyze trading patterns
3. Identify emotional triggers
4. Provide recommendations

### Access
- **Status:** 🚧 Planned
- **Subscription:** Premium ($25/month)
- **Target:** Active traders

---

## 👤 Investor Psychology Profile

### Status
🚧 Planned

### Planned Purpose
AI analysis of investor psychology and behavior patterns.

### Planned Features
- Psychology assessment
- Behavior pattern analysis
- Risk profile identification
- Personalized investment strategy

### Why This Feature?
- **User Need:** Understand own psychology
- **Value:** Better investment decisions
- **Innovation:** Advanced AI analysis
- **Premium:** Deep analysis, personalized profiles

### Access
- **Status:** 🚧 Planned
- **Subscription:** Premium ($25/month)
- **Target:** Serious investors

---

## 🔮 Predictive AI Simulator

### Status
🚧 Planned

### Planned Purpose
AI-powered scenario forecasting and market prediction simulator.

### Planned Features
- Market scenario simulation
- Price prediction models
- Risk scenario analysis
- Portfolio impact forecasting

### Why This Feature?
- **User Need:** Want to predict outcomes
- **Value:** Plan for different scenarios
- **Innovation:** Advanced AI models
- **Premium:** Computational intensive, complex models

### Access
- **Status:** 🚧 Planned
- **Subscription:** Premium ($25/month)
- **Target:** Advanced traders and investors

---

## 💬 AI Chat Assistant

### Location
Bottom-right corner of all pages

### Purpose
Real-time AI assistant for answering crypto questions instantly.

### Features
- Natural language processing
- Crypto terminology understanding
- Quick question buttons
- Context-aware responses

### Why This Feature?
- **User Need:** Instant answers to questions
- **Value:** 24/7 support, no waiting
- **Engagement:** Keeps users on site
- **Differentiation:** AI-powered, not just FAQ

### Quick Questions (Why These?)
1. **"What is HODL?"** - Most common crypto term
2. **"Explain DeFi"** - Popular, complex topic
3. **"What is a whale?"** - Trading terminology
4. **"Wen moon? 🚀"** - Crypto culture, fun
5. **"Rug pulls?"** - Important risk to understand

### Technical Details
- **API:** Mistral AI
- **Script:** `scripts/chatbot.js`
- **Endpoint:** `/api/chat`
- **Response Time:** < 3 seconds

### Design Decisions
- **Bottom-right:** Standard position, doesn't interfere
- **Fixed:** Always accessible
- **Small when closed:** Doesn't distract
- **Expandable:** Full chat when needed

### Access
- **Free Trial:** 24 hours
- **After Trial:** Requires subscription ($10/month)
- **Target:** All users

---

## 🔐 Subscription System

### Free Trial
- **Duration:** 24 hours
- **Access:** All features during trial
- **Auto-expires:** After 24 hours
- **Purpose:** Let users experience value

### Paid Subscription
- **Price:** $10/month
- **Payment Methods:**
  - Crypto (USDT via CryptoCloud)
  - Card (Visa/Mastercard via CloudPayments)

### Subscription Tiers

#### Free Tier
- News
- Risk Distribution
- Crypto Basics

#### Paid Tier ($15/mo)
- Crypto Coach
- Smart Alerts
- Cross Wallet

#### Premium Tier ($25/mo)
- AI Emotional Tracker
- Investor Psychology Profile
- Predictive AI Simulator

### Why This Pricing?
- **Free:** Attracts users, builds trust
- **Paid:** Covers costs, sustainable
- **Premium:** Advanced features, higher value

---

## 🎨 UI/UX Features

### Design Elements
- Dark theme with purple/green accents
- Animated background elements
- Smooth transitions
- Responsive design

### User Experience Principles
- **Intuitive:** Easy to understand
- **Fast:** Quick loading, responsive
- **Clear:** Obvious what to do
- **Engaging:** Keeps users interested

### Mobile Support
All features are fully responsive and work on:
- Desktop browsers
- Tablets
- Mobile devices

---

**Next:** See [04_API_REFERENCE.md](./04_API_REFERENCE.md) for API documentation.

