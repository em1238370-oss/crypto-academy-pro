# Troubleshooting Guide

## Common Issues and Solutions

### Issue: Cannot Access Sub-sites (ERR_CONNECTION_TIMED_OUT)

**Problem:** Getting timeout error when trying to open sub-sites like Crypto Basics.

**Symptoms:**
- Error: "ERR_CONNECTION_TIMED_OUT"
- Cannot access `192.168.1.142:4000/sub-sites/...`
- Site not loading

**Solutions:**

#### Solution 1: Check Server is Running
```bash
cd /Users/elizavetamedvedeva/Documents/GitHub/crypto-academy-pro
npm start
```

#### Solution 2: Use Relative Paths
Instead of hardcoded IP addresses like `http://192.168.1.142:4000/sub-sites/...`, use relative paths:
```html
<!-- ❌ Wrong -->
<a href="http://192.168.1.142:4000/sub-sites/crypto-basics/index.html">

<!-- ✅ Correct -->
<a href="sub-sites/crypto-basics/index.html">
```

#### Solution 3: Check Port Configuration
```bash
# Check what port server is using
cat .env | grep PORT

# Or check running processes
lsof -i -P | grep node | grep LISTEN
```

#### Solution 4: Restart Server
```bash
# Kill existing server
pkill -f "node server.js"

# Start fresh
npm start
```

---

### Issue: Server Won't Start

**Problem:** Server fails to start or crashes immediately.

**Solutions:**

1. **Check Port Availability**
```bash
lsof -i :4000
# If port is in use, kill the process or change PORT in .env
```

2. **Check Environment Variables**
```bash
# Make sure .env file exists and has required variables
cat .env
```

3. **Check Dependencies**
```bash
npm install
```

4. **Check Node Version**
```bash
node --version  # Should be 18+
```

---

### Issue: Sub-sites Not Loading

**Problem:** Sub-sites return 404 or don't load properly.

**Solutions:**

1. **Check File Paths**
   - Ensure files exist in `sub-sites/` directory
   - Check file names match exactly

2. **Check Server Static File Serving**
   - Server should serve static files from root
   - Check `server.js` has: `app.use(express.static(__dirname))`

3. **Use Relative Paths**
   - Don't use absolute URLs with IP addresses
   - Use relative paths: `sub-sites/news/index.html`

---

### Issue: Payment Not Working

**Problem:** Payment buttons don't work or payment fails.

**Solutions:**

1. **Check Environment Variables**
```bash
# Verify payment service keys are set
cat .env | grep -E "CRYPTOCLOUD|CLOUDPAYMENTS"
```

2. **Check API Keys**
   - Verify keys are valid
   - Check service dashboards

3. **Check Webhooks**
   - Verify webhook URLs are correct
   - Check webhook logs

---

### Issue: AI Chat Not Responding

**Problem:** Chat widget doesn't respond or shows errors.

**Solutions:**

1. **Check Mistral API Key**
```bash
cat .env | grep MISTRAL_API_KEY
```

2. **Check Subscription Status**
   - User needs active subscription or free trial
   - Check `/api/status` endpoint

3. **Check Network**
   - Verify connection to Mistral API
   - Check firewall settings

---

### Issue: Styles Not Loading

**Problem:** Page loads but looks broken, no styles.

**Solutions:**

1. **Check CSS File Path**
   - Verify `styles.css` exists in root
   - Check path in HTML: `<link rel="stylesheet" href="styles.css">`

2. **Check Server Static Files**
   - Server must serve static files
   - Check Express static middleware

3. **Clear Browser Cache**
   - Hard refresh: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)

---

## Quick Fixes

### Restart Everything
```bash
# Kill all node processes
pkill -f node

# Restart server
cd /Users/elizavetamedvedeva/Documents/GitHub/crypto-academy-pro
npm start
```

### Check Server Status
```bash
# Check if server is running
ps aux | grep "node server.js"

# Check what port it's using
lsof -i -P | grep node | grep LISTEN
```

### Test Local Access
```bash
# Test if server responds
curl http://localhost:4000/health
# Or
curl http://localhost:4000/
```

---

## Getting Help

If issues persist:
1. Check server logs
2. Check browser console (F12)
3. Verify all environment variables
4. Check file permissions
5. Review documentation

---

**Last Updated:** January 2024

