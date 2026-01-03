# Development Guide

## Getting Started

### Prerequisites
- Node.js 18+ installed
- npm or yarn package manager
- Git for version control
- Code editor (VS Code recommended)

### Installation

1. **Clone repository**
```bash
git clone [repository-url]
cd crypto-academy-pro
```

2. **Install dependencies**
```bash
npm install
```

3. **Set up environment variables**
```bash
cp .env.example .env
# Edit .env with your API keys
```

4. **Run development server**
```bash
node server.js
```

Server runs on `http://localhost:4000` by default.

## Project Structure

```
crypto-academy-pro/
├── index.html              # Main landing page
├── server.js               # Express backend
├── styles.css              # Global styles
├── scripts/                 # Client-side JS
│   ├── chatbot.js         # AI chat
│   └── scroll-optimizer.js
├── sub-sites/              # Feature modules
│   ├── news/
│   ├── crypto-basics/
│   ├── crypto-coach/
│   └── risk-distribution/
└── docs/                   # Documentation
```

## Development Workflow

### Making Changes

1. **Create feature branch**
```bash
git checkout -b feature/new-feature
```

2. **Make changes**
- Edit files
- Test locally
- Check for errors

3. **Commit changes**
```bash
git add .
git commit -m "Description of changes"
```

4. **Push to repository**
```bash
git push origin feature/new-feature
```

### Adding New Features

1. **Plan the feature**
   - What problem does it solve?
   - How will users interact with it?
   - What API endpoints needed?

2. **Create files**
   - HTML for UI
   - JavaScript for logic
   - CSS for styling
   - Backend endpoints if needed

3. **Test locally**
   - Test all functionality
   - Check mobile responsiveness
   - Verify API calls

4. **Document**
   - Update documentation
   - Add to feature list
   - Update API docs if needed

## Code Style

### JavaScript
- Use modern ES6+ syntax
- Consistent naming (camelCase for variables)
- Comment complex logic
- Keep functions small and focused

### CSS
- Use meaningful class names
- Group related styles
- Use CSS variables for colors
- Keep responsive design in mind

### HTML
- Use semantic HTML5
- Include proper meta tags
- Ensure accessibility
- Keep structure clean

## Testing

### Manual Testing
1. Test all features
2. Check different browsers
3. Test on mobile devices
4. Verify API endpoints

### Testing Checklist
- [ ] All links work
- [ ] Forms submit correctly
- [ ] API calls succeed
- [ ] Error handling works
- [ ] Mobile responsive
- [ ] Payment flow works

## Debugging

### Common Issues

1. **Server won't start**
   - Check port availability
   - Verify environment variables
   - Check for syntax errors

2. **API calls fail**
   - Check API keys
   - Verify endpoints
   - Check network requests

3. **Styles not applying**
   - Check CSS file path
   - Verify class names
   - Check browser console

### Debug Tools
- Browser DevTools
- Node.js debugger
- Network tab for API calls
- Console logs

## Environment Variables

### Required Variables
```env
MISTRAL_API_KEY=your_key
CRYPTOCLOUD_API_KEY=your_key
CRYPTOCLOUD_SHOP_ID=your_id
CLOUDPAYMENTS_PUBLIC_ID=your_id
CLOUDPAYMENTS_API_SECRET=your_secret
APP_BASE_URL=http://localhost:4000
```

### Optional Variables
```env
SUBSCRIPTION_PRICE_USD=10
SUBSCRIPTION_PERIOD_DAYS=30
FREE_TRIAL_HOURS=24
```

## Deployment

### Render Deployment

1. **Connect repository**
   - Link GitHub repository
   - Select branch

2. **Configure build**
   - Build command: `npm install`
   - Start command: `node server.js`

3. **Set environment variables**
   - Add all required variables
   - Keep secrets secure

4. **Deploy**
   - Render auto-deploys on push
   - Check deployment logs

## Best Practices

### Security
- Never commit `.env` file
- Use environment variables for secrets
- Validate user input
- Sanitize data

### Performance
- Optimize images
- Minify CSS/JS in production
- Use lazy loading
- Cache static assets

### Code Quality
- Write readable code
- Add comments where needed
- Follow existing patterns
- Keep functions focused

## Troubleshooting

### Port Already in Use
```bash
# Find process using port
lsof -i :4000
# Kill process
kill -9 [PID]
```

### Module Not Found
```bash
# Reinstall dependencies
rm -rf node_modules
npm install
```

### API Errors
- Check API keys
- Verify endpoints
- Check rate limits
- Review error messages

---

**Next:** See [08_DEPLOYMENT.md](./08_DEPLOYMENT.md) for deployment details.

