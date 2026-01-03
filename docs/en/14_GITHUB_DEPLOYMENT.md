# GitHub Deployment & Auto-Update Guide

## 🚀 Overview

This guide explains how to set up automatic deployment from GitHub to Render, so that any changes you push to GitHub automatically update the live site at https://crypto-academy-pro.onrender.com/

## 🎯 Goal

**What We Want:**
- Push changes to GitHub → Automatically deploy to Render
- Live site updates automatically
- No manual deployment needed
- Site accessible worldwide

## 📋 Prerequisites

1. **GitHub Repository** - Your code must be on GitHub
2. **Render Account** - Connected to GitHub
3. **Auto-Deploy Enabled** - Render watches GitHub for changes

## 🔧 Setup Steps

### Step 1: Ensure GitHub Repository is Connected

**Check current repository:**
```bash
cd /Users/elizavetamedvedeva/Documents/GitHub/crypto-academy-pro
git remote -v
```

**If no remote exists, add GitHub repository:**
```bash
git remote add origin https://github.com/your-username/crypto-academy-pro.git
```

### Step 2: Push All Changes to GitHub

**Commit all changes:**
```bash
git add .
git commit -m "Update documentation and fix links"
git push origin main
```

### Step 3: Configure Render Auto-Deploy

1. **Go to Render Dashboard**
   - https://dashboard.render.com
   - Select your service (crypto-academy-pro)

2. **Enable Auto-Deploy**
   - Settings → Build & Deploy
   - Enable "Auto-Deploy"
   - Select branch: `main`
   - Save

3. **Verify Webhook**
   - Render automatically creates GitHub webhook
   - Should show "Connected" status

### Step 4: Test Auto-Deploy

1. **Make a small change:**
```bash
# Edit a file
echo "# Test" >> README.md
```

2. **Commit and push:**
```bash
git add README.md
git commit -m "Test auto-deploy"
git push origin main
```

3. **Check Render:**
   - Go to Render dashboard
   - Should see new deployment starting
   - Wait for deployment to complete
   - Check live site

## 🔄 Workflow

### Daily Workflow

1. **Make Changes Locally**
   ```bash
   # Edit files
   # Test locally
   ```

2. **Commit Changes**
   ```bash
   git add .
   git commit -m "Description of changes"
   ```

3. **Push to GitHub**
   ```bash
   git push origin main
   ```

4. **Auto-Deploy Happens**
   - Render detects push
   - Starts deployment
   - Updates live site automatically

5. **Verify on Live Site**
   - Visit https://crypto-academy-pro.onrender.com/
   - Check changes are live

## ✅ Best Practices

### Commit Messages
Use clear, descriptive commit messages:
```bash
git commit -m "Fix Crypto Basics link in main menu"
git commit -m "Add documentation for News sub-site"
git commit -m "Update payment integration docs"
```

### Before Pushing
1. Test locally
2. Check for errors
3. Verify all files are included
4. Review changes

### After Pushing
1. Check Render dashboard
2. Monitor deployment logs
3. Test live site
4. Verify changes

## 🔍 Troubleshooting

### Auto-Deploy Not Working

**Check:**
1. GitHub webhook is connected
2. Auto-deploy is enabled in Render
3. Branch name matches (usually `main`)
4. GitHub repository is correct

**Fix:**
1. Go to Render → Settings → Build & Deploy
2. Reconnect GitHub repository
3. Enable auto-deploy
4. Save settings

### Deployment Fails

**Check logs:**
- Render dashboard → Deployments → View logs
- Look for error messages
- Common issues:
  - Missing environment variables
  - Build errors
  - Dependency issues

**Fix:**
- Check error in logs
- Fix issue locally
- Push fix to GitHub
- Auto-deploy will retry

### Changes Not Appearing

**Possible causes:**
1. Deployment still in progress
2. Browser cache (hard refresh: Cmd+Shift+R)
3. Changes not pushed to GitHub
4. Wrong branch

**Fix:**
1. Wait for deployment to complete
2. Clear browser cache
3. Verify `git push` succeeded
4. Check branch is `main`

## 📝 Important Notes

### File Paths
- **Always use relative paths** in HTML
- Don't use hardcoded IP addresses
- Example: `sub-sites/crypto-basics/index.html` ✅
- Not: `http://192.168.1.142:4000/...` ❌

### Environment Variables
- Set in Render dashboard
- Not committed to GitHub
- Update in Render if needed

### Static Files
- All files in repository are deployed
- Changes to HTML/CSS/JS deploy automatically
- No build step needed (static site)

## 🎯 Quick Reference

### Check Status
```bash
# Check git status
git status

# Check remote
git remote -v

# Check recent commits
git log --oneline -5
```

### Deploy Changes
```bash
# Standard workflow
git add .
git commit -m "Your message"
git push origin main
```

### Verify Deployment
1. Check Render dashboard
2. Visit live site
3. Test functionality

---

## 🌐 Live Site

**URL:** https://crypto-academy-pro.onrender.com/

**How to Update:**
1. Make changes locally
2. `git push origin main`
3. Wait 1-2 minutes
4. Changes are live!

---

**Last Updated:** January 2024

