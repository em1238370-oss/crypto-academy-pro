# Main Menu & Landing Page Documentation

## 🏠 Landing Page Structure

### Hero Section
**Location:** Top of `index.html`

**Content:**
- Main headline: "Crypto: Not Just Madness"
- Animated floating text with gradient effects
- Crypto-themed background elements (blockchain grid, transaction data, price charts)

### Main Text Section
**Purpose:** Platform introduction and value proposition

**Text:**
> "Step into the vast world of cryptocurrency with confidence. Our platform cuts through the noise, offering you clear, powerful tools to explore, learn, and make informed decisions. All you need is discipline and a bit of your time. Start for free today, and if you love it, keep going! Money is somewhere nearby."

### Subscription Banner
**Location:** Below main text

**Features:**
- Displays subscription status
- "Pay with Crypto" button
- Shows free trial information

**States:**
- Hidden by default (`display: none`)
- Shown when user needs to subscribe

---

## 📋 Main Menu Items

### Free Features (Available to all users)

#### 1. News
- **Link:** `sub-sites/news/index.html`
- **Description:** "Stay updated with the latest crypto news."
- **Status:** ✅ Active
- **Access:** Free

#### 2. Risk Distribution
- **Link:** `sub-sites/risk-distribution/index.html`
- **Description:** "Manage your risks with smart tools."
- **Status:** ✅ Active
- **Access:** Free

#### 3. Crypto Basics
- **Link:** `sub-sites/crypto-basics/index.html`
- **Description:** "Learn the basics of cryptocurrency."
- **Status:** ✅ Active
- **Access:** Free

---

### Paid Features ($15/month)

#### 4. Crypto Coach
- **Link:** `sub-sites/crypto-coach/index.html`
- **Description:** "Personalized advice (Free trial, then $15/mo)."
- **Status:** ✅ Active
- **Access:** Paid subscription required

#### 5. Smart Alerts
- **Link:** `#` (placeholder)
- **Description:** "Smart notifications (Free trial, then $15/mo)."
- **Status:** 🚧 In development
- **Access:** Paid subscription required

#### 6. Cross Wallet
- **Link:** `#` (placeholder)
- **Description:** "Manage wallets (Free trial, then $15/mo)."
- **Status:** 🚧 In development
- **Access:** Paid subscription required

---

### Premium Features ($25/month)

#### 7. AI Emotional Tracker
- **Link:** `#` (placeholder)
- **Description:** "AI emotional pattern analysis (Premium $25/mo)."
- **Status:** 🚧 Planned
- **Access:** Premium subscription required

#### 8. Investor Psychology Profile
- **Link:** `#` (placeholder)
- **Description:** "AI investor psychology analysis (Premium $25/mo)."
- **Status:** 🚧 Planned
- **Access:** Premium subscription required

#### 9. Predictive AI Simulator
- **Link:** `#` (placeholder)
- **Description:** "AI scenario forecasts (Premium $25/mo)."
- **Status:** 🚧 Planned
- **Access:** Premium subscription required

---

### Special Item

#### 10. Crafting Websites with Passion
- **Link:** `#` (oval-item style)
- **Description:** "My Why & How You Can Fuel My Journey"
- **Type:** Special content/about section

---

## 🎨 Visual Elements

### Background Elements
The landing page includes animated crypto-themed background elements:

1. **Blockchain Grid** - Decorative grid pattern
2. **Blockchain Blocks** - 3 animated blocks (block-1, block-2, block-3)
3. **Transaction Data** - 5 floating transaction hashes:
   - `0x1a2b3c4d5e6f...`
   - `0x7g8h9i0j1k2l...`
   - `0x3m4n5o6p7q8r...`
   - `0x9s0t1u2v3w4x...`
   - `0x5y6z7a8b9c0d...`
4. **Price Chart Lines** - 3 animated chart lines
5. **Blockchain Connections** - 4 connection lines
6. **Business Indicators** - 3 indicator elements
7. **Data Lines** - 3 data flow lines

### Menu Item Styling
- **Free items:** Green accent (`menu-item free`)
- **Paid items:** Purple accent (`menu-item paid`)
- **Premium items:** Gold/orange accent (`menu-item premium`)

---

## 💬 Chat Widget

### Location
Fixed position in bottom-right corner of the screen.

### Features
- **AI Assistant:** Powered by Mistral AI
- **Quick Questions:** Pre-defined question buttons
- **Subscription Timer:** Shows remaining free trial time
- **Payment Integration:** Subscribe directly from chat

### Quick Questions
- "What is HODL?"
- "Explain DeFi"
- "What is a whale?"
- "Wen moon? 🚀"
- "Rug pulls?"

---

## 🔗 Navigation Flow

```
Landing Page (index.html)
    ├── News → sub-sites/news/
    ├── Risk Distribution → sub-sites/risk-distribution/
    ├── Crypto Basics → sub-sites/crypto-basics/
    ├── Crypto Coach → sub-sites/crypto-coach/
    ├── Smart Alerts → (Coming soon)
    ├── Cross Wallet → (Coming soon)
    ├── AI Emotional Tracker → (Planned)
    ├── Investor Psychology Profile → (Planned)
    └── Predictive AI Simulator → (Planned)
```

---

## 📱 Responsive Design
The landing page is fully responsive and adapts to:
- Desktop (1920px+)
- Tablet (768px - 1919px)
- Mobile (< 768px)

---

## 🎯 User Journey

1. **Landing** → User arrives at main page
2. **Explore** → User clicks on menu items
3. **Free Trial** → User gets 24 hours free access
4. **Subscribe** → User pays for continued access
5. **Use Features** → User accesses paid/premium features

