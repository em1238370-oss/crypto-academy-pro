# Deployment Guide

## Deployment Platform

**Render.com** - https://crypto-academy-pro.onrender.com/

## Why Render?

- Free tier available
- Easy GitHub integration
- Automatic deployments
- Environment variable management
- HTTPS by default

## Deployment Steps

### 1. Prepare Repository

Ensure your code is in a Git repository:
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin [your-repo-url]
git push -u origin main
```

### 2. Create Render Service

1. Go to https://render.com
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Select the repository and branch

### 3. Configure Build Settings

**Build Command:**
```bash
npm install
```

**Start Command:**
```bash
node server.js
```

**Environment:**
- Node: 18.x or higher

### 4. Set Environment Variables

Add all required environment variables in Render dashboard:

```env
MISTRAL_API_KEY=your_mistral_key
CRYPTOCLOUD_API_KEY=your_cryptocloud_key
CRYPTOCLOUD_SHOP_ID=your_shop_id
CLOUDPAYMENTS_PUBLIC_ID=your_public_id
CLOUDPAYMENTS_API_SECRET=your_api_secret
APP_BASE_URL=https://crypto-academy-pro.onrender.com
SUBSCRIPTION_PRICE_USD=10
SUBSCRIPTION_PERIOD_DAYS=30
FREE_TRIAL_HOURS=24
```

### 5. Deploy

Render will automatically:
1. Clone your repository
2. Install dependencies
3. Build the application
4. Start the server
5. Provide HTTPS URL

## Post-Deployment

### Verify Deployment

1. **Check URL**
   - Visit your Render URL
   - Verify site loads

2. **Test Features**
   - Test main page
   - Test API endpoints
   - Test payment flow

3. **Check Logs**
   - View Render logs
   - Check for errors
   - Monitor performance

### Update Environment Variables

1. Go to Render dashboard
2. Select your service
3. Go to "Environment" tab
4. Add/update variables
5. Save (auto-redeploys)

## Custom Domain (Optional)

### Add Custom Domain

1. Go to Render dashboard
2. Select your service
3. Go to "Settings" → "Custom Domains"
4. Add your domain
5. Update DNS records as instructed

### DNS Configuration

Add CNAME record pointing to your Render URL:
```
Type: CNAME
Name: @ (or www)
Value: [your-render-url].onrender.com
```

## Monitoring

### Render Dashboard

- View deployment logs
- Monitor uptime
- Check resource usage
- View error logs

### Application Logs

Check server logs in Render dashboard:
- API errors
- Payment issues
- User activity

## Troubleshooting

### Deployment Fails

1. **Check build logs**
   - Look for error messages
   - Verify dependencies
   - Check Node version

2. **Verify environment variables**
   - All required vars set
   - No typos in values
   - Correct format

3. **Check code**
   - No syntax errors
   - All files committed
   - Correct file paths

### Site Not Loading

1. **Check service status**
   - Service is running
   - No errors in logs
   - Correct start command

2. **Verify environment**
   - All variables set
   - API keys valid
   - URLs correct

### API Errors

1. **Check API keys**
   - Keys are valid
   - No expiration
   - Correct format

2. **Verify endpoints**
   - URLs are correct
   - CORS configured
   - Rate limits not exceeded

## Continuous Deployment

### Automatic Deployments

Render automatically deploys when you:
- Push to main branch
- Merge pull requests
- Update environment variables

### Manual Deployments

1. Go to Render dashboard
2. Select your service
3. Click "Manual Deploy"
4. Select branch/commit
5. Deploy

## Backup and Recovery

### Code Backup

- Code is in Git repository
- Regular commits
- Tag important versions

### Data Backup

Currently using in-memory storage:
- **Issue:** Data lost on restart
- **Solution:** Migrate to database
- **Backup:** Regular database backups

## Security

### HTTPS

Render provides HTTPS by default:
- SSL certificate included
- Automatic renewal
- Secure connections

### Environment Variables

- Never commit secrets
- Use environment variables
- Keep keys secure
- Rotate keys regularly

## Performance Optimization

### Render Settings

- **Instance Type:** Free tier (upgrade if needed)
- **Auto-scaling:** Configure if needed
- **Health Checks:** Configure endpoint

### Application Optimization

- Minify CSS/JS
- Optimize images
- Use CDN for static assets
- Enable caching

## Cost Management

### Free Tier

- 750 hours/month free
- Sleeps after inactivity
- Good for development

### Paid Tier

- Always-on service
- More resources
- Better performance
- Custom domains

---

**For more help:** Check Render documentation or contact support.

