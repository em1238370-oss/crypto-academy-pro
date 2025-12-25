// ========== MODULES JAVASCRIPT ==========
// Initialize drawers
function toggleDrawer(drawerId) {
    const drawer = document.getElementById(drawerId);
    drawer.classList.toggle('open');
}

function toggleDrawerWithInit(drawerId) {
    // Close ALL other drawers
    const allDrawers = ['drawerA', 'drawerB', 'drawerC', 'drawerD'];
    allDrawers.forEach(id => {
        if (id !== drawerId) {
            const drawer = document.getElementById(id);
            if (drawer && drawer.classList.contains('open')) {
                drawer.classList.remove('open');
            }
        }
    });
    
    // Toggle the clicked drawer
    toggleDrawer(drawerId);
    
    // Initialize coins if drawerA is opened
    if (drawerId === 'drawerA') {
        const coinsGrid = document.getElementById('coinsGrid');
        if (coinsGrid && coinsGrid.innerHTML === '') {
            setTimeout(() => {
                console.log('Initializing coins on drawer open');
                initCoins();
                initNewFeatures(); // Initialize new features
            }, 400);
        } else {
            initNewFeatures(); // Initialize new features even if coins already loaded
        }
    }
}

// API Configuration
const API_KEY = 'hfDsgAHIsiU6tKZOSTqAL5pazYPjA8SO';
const API_URL = 'https://api.mistral.ai/v1/chat/completions';
const LIVECOINWATCH_KEY = '84d685c4-2905-4fc2-91fc-ba7b696eb966';
const LIVECOINWATCH_URL = 'https://api.livecoinwatch.com/coins/single';

// Available coins
const availableCoins = [
    'BTC', 'ETH', 'BNB', 'SOL', 'ADA', 'XRP', 'ENA', 'FARTCOIN', 'PEPE', 
    'AVAX', 'NEAR', 'ONDO', 'WLD', 'ARB', 'APT', 'LDO', 'VIRTAUL', 'UNI', 
    'SBIB1000', 'WLFI', 'IJU', 'SOMI', 'IP', 'APE', 'DOGE', 'SUI', 'WIF', 
    'AAVE', 'PENGU', 'SEI', 'GALA', 'TON', 'MYX', 'ATOM'
];

let selectedCoins = {};
let portfolioValue = 10000;

// Module A: Trading Simulator functions
function initCoins() {
    const coinsGrid = document.getElementById('coinsGrid');
    
    if (!coinsGrid) {
        console.error('coinsGrid element not found!');
        return;
    }
    
    if (coinsGrid.innerHTML !== '' && coinsGrid.children.length > 0) {
        console.log('Coins already initialized');
        return;
    }
    
    coinsGrid.innerHTML = '';
    
    availableCoins.forEach(coin => {
        const coinCard = document.createElement('div');
        coinCard.className = 'coin-card';
        coinCard.innerHTML = `
            <h4 style="margin-bottom: 10px; color: #ffffff; font-size: 1.2rem;">${coin}</h4>
            <label style="display: block; margin-bottom: 8px; color: #ff6666; font-size: 0.9rem; font-weight: bold;">Percentage:</label>
            <input type="range" class="percentage-slider" min="0" max="100" value="0" 
                   oninput="setCoinPercentage('${coin}', this.value)"
                   style="width: 100%; margin-bottom: 5px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <span id="percent-${coin}" style="color: #ff0000; font-weight: bold; font-size: 1rem;">0%</span>
                <button class="btn btn-red" style="padding: 5px 15px; font-size: 0.85rem;" 
                        onclick="addRemoveCoin('${coin}')">Remove</button>
            </div>
        `;
        coinCard.style.padding = '20px';
        coinCard.style.minHeight = '140px';
        coinCard.style.display = 'flex';
        coinCard.style.flexDirection = 'column';
        coinsGrid.appendChild(coinCard);
    });
}

function setCoinPercentage(coinSymbol, percentage) {
    const percentElement = document.getElementById('percent-' + coinSymbol);
    if (percentElement) percentElement.textContent = percentage + '%';
    
    if (!selectedCoins[coinSymbol]) {
        selectedCoins[coinSymbol] = { percentage: parseInt(percentage) };
    } else {
        selectedCoins[coinSymbol].percentage = parseInt(percentage);
    }
    
    updateSelectedCoins();
}

function addRemoveCoin(coinSymbol) {
    if (selectedCoins[coinSymbol]) {
        delete selectedCoins[coinSymbol];
        const coinCards = document.querySelectorAll('.coin-card');
        coinCards.forEach(card => {
            if (card.querySelector('h4').textContent === coinSymbol) {
                const slider = card.querySelector('input[type="range"]');
                slider.value = 0;
                const percentEl = document.getElementById('percent-' + coinSymbol);
                if (percentEl) percentEl.textContent = '0%';
            }
        });
    }
    updateSelectedCoins();
}

function updateSelectedCoins() {
    const selectedCoinsList = document.getElementById('selectedCoinsList');
    const activeCoins = Object.keys(selectedCoins).filter(coin => selectedCoins[coin].percentage > 0);
    
    if (!selectedCoinsList) return;
    
    if (activeCoins.length === 0) {
        selectedCoinsList.innerHTML = '<p style="color: #888; text-align: center; padding: 20px;">No coins selected</p>';
    } else {
        selectedCoinsList.innerHTML = '';
        activeCoins.forEach(coin => {
            const item = document.createElement('div');
            item.className = 'selected-coin-item';
            item.innerHTML = `
                <span><strong style="color: #ffffff;">${coin}</strong></span>
                <div style="display: flex; align-items: center; gap: 15px;">
                    <span style="color: #ff0000; font-weight: bold; font-size: 1.1rem;">${selectedCoins[coin].percentage}%</span>
                    <button class="btn btn-red" style="padding: 5px 15px; font-size: 0.85rem;" 
                            onclick="removeCoinFromList('${coin}')">× Remove</button>
                </div>
            `;
            selectedCoinsList.appendChild(item);
        });
    }

    document.querySelectorAll('.coin-card').forEach(card => {
        const coinName = card.querySelector('h4').textContent;
        if (selectedCoins[coinName] && selectedCoins[coinName].percentage > 0) {
            card.style.borderColor = 'rgba(255, 0, 0, 0.8)';
            card.style.boxShadow = '0 0 20px rgba(255, 0, 0, 0.4)';
        } else {
            card.style.borderColor = 'rgba(255, 0, 0, 0.3)';
            card.style.boxShadow = '0 4px 15px rgba(0, 0, 0, 0.3)';
        }
    });

    if (activeCoins.length > 0) {
        getAIRecommendations();
    }
    
    // Update portfolio health score when coins change
    calculatePortfolioHealth();
}

function removeCoinFromList(coinSymbol) {
    if (selectedCoins[coinSymbol]) {
        selectedCoins[coinSymbol].percentage = 0;
        const coinCards = document.querySelectorAll('.coin-card');
        coinCards.forEach(card => {
            if (card.querySelector('h4').textContent === coinSymbol) {
                const slider = card.querySelector('input[type="range"]');
                slider.value = 0;
                const percentEl = document.getElementById('percent-' + coinSymbol);
                if (percentEl) percentEl.textContent = '0%';
            }
        });
        updateSelectedCoins();
    }
}

async function getAIRecommendations() {
    const coins = Object.keys(selectedCoins).join(', ');
    const recommendationsContent = document.getElementById('recommendationsContent');
    
    if (!recommendationsContent) return;
    
    recommendationsContent.innerHTML = '<p style="color: #ffffff; font-weight: bold;">🤖 Fetching real-time market data and analyzing...</p>';

    try {
        let priceData = [];
        const coinSymbols = coins.split(', ').map(c => c.trim());
        
        for (const coinSymbol of coinSymbols) {
            try {
                const priceResponse = await fetch(`${LIVECOINWATCH_URL}/${coinSymbol}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': LIVECOINWATCH_KEY
                    },
                    body: JSON.stringify({
                        currency: 'USD',
                        meta: true
                    })
                });
                
                const priceInfo = await priceResponse.json();
                if (priceInfo) {
                    // Получаем расширенные данные
                    const currentPrice = priceInfo.rate || 0;
                    const marketCap = priceInfo.cap || 0;
                    const volume24h = priceInfo.volume || 0;
                    const priceChange24h = priceInfo.delta?.day || 0;
                    const priceChange7d = priceInfo.delta?.week || 0;
                    const priceChange30d = priceInfo.delta?.month || 0;
                    const allTimeHigh = priceInfo.allTimeHighUSD || currentPrice;
                    const allTimeLow = priceInfo.allTimeLowUSD || currentPrice;
                    
                    // Вычисляем волатильность и тренд
                    const volatility = Math.abs(priceChange24h);
                    const trend = priceChange24h > 0 ? 'bullish' : priceChange24h < 0 ? 'bearish' : 'neutral';
                    const distanceFromATH = ((currentPrice - allTimeHigh) / allTimeHigh * 100).toFixed(2);
                    const distanceFromATL = ((currentPrice - allTimeLow) / allTimeLow * 100).toFixed(2);
                    
                    // Анализ объема (высокий/средний/низкий)
                    const volumeRatio = volume24h / marketCap;
                    let volumeAnalysis = 'low';
                    if (volumeRatio > 0.1) volumeAnalysis = 'very high';
                    else if (volumeRatio > 0.05) volumeAnalysis = 'high';
                    else if (volumeRatio > 0.02) volumeAnalysis = 'moderate';
                    
                    priceData.push({
                        symbol: coinSymbol,
                        price: currentPrice.toFixed(6),
                        marketCap: marketCap > 0 ? `$${(marketCap / 1000000).toFixed(2)}M` : 'N/A',
                        volume24h: volume24h > 0 ? `$${(volume24h / 1000000).toFixed(2)}M` : 'N/A',
                        priceChange24h: `${priceChange24h.toFixed(2)}%`,
                        priceChange7d: `${priceChange7d.toFixed(2)}%`,
                        priceChange30d: `${priceChange30d.toFixed(2)}%`,
                        allTimeHigh: allTimeHigh.toFixed(6),
                        allTimeLow: allTimeLow.toFixed(6),
                        distanceFromATH: distanceFromATH,
                        distanceFromATL: distanceFromATL,
                        volatility: volatility.toFixed(2),
                        trend: trend,
                        volumeAnalysis: volumeAnalysis,
                        timestamp: new Date().toISOString() // Временная метка для актуальности
                    });
                }
            } catch (e) {
                console.log(`Could not fetch data for ${coinSymbol}`);
            }
        }
        
        // Формируем информацию о портфеле с процентами
        const portfolioInfo = Object.keys(selectedCoins).map(coin => {
            const percentage = selectedCoins[coin].percentage || 0;
            const coinData = priceData.find(d => d.symbol === coin);
            return coinData ? {
                symbol: coin,
                percentage: percentage,
                price: coinData.price,
                marketCap: coinData.marketCap,
                volume24h: coinData.volume24h,
                priceChange24h: coinData.priceChange24h
            } : null;
        }).filter(Boolean);
        
        // Формируем детальную информацию с графиками и трендами
        const portfolioText = portfolioInfo.map(coin => {
            const coinData = priceData.find(d => d.symbol === coin.symbol);
            if (!coinData) return null;
            
            return `${coin.symbol} (${coin.percentage}% of portfolio):
📊 CURRENT MARKET DATA (Real-time as of ${new Date().toLocaleString()}):
- Current Price: $${coin.price}
- Market Cap: ${coin.marketCap}
- 24h Volume: ${coin.volume24h} (${coinData.volumeAnalysis} liquidity)
- Price Changes: 24h ${coin.priceChange24h}, 7d ${coinData.priceChange7d}, 30d ${coinData.priceChange30d}
- Trend: ${coinData.trend.toUpperCase()} (Volatility: ${coinData.volatility}%)
- All-Time High: $${coinData.allTimeHigh} (Current price is ${coinData.distanceFromATH}% below ATH)
- All-Time Low: $${coinData.allTimeLow} (Current price is ${coinData.distanceFromATL}% above ATL)
- Price Position: ${parseFloat(coinData.distanceFromATH) > -20 ? 'Near ATH - potential resistance' : parseFloat(coinData.distanceFromATH) < -50 ? 'Far from ATH - potential opportunity' : 'Mid-range'}`
        }).filter(Boolean).join('\n\n');
        
        const prompt = `You are an expert cryptocurrency investment advisor and portfolio strategist with access to REAL-TIME market data and price charts.

⚠️ CRITICAL: All data provided is CURRENT and REAL-TIME as of the moment the user is viewing this. Use these EXACT numbers and trends in your analysis.

USER'S PORTFOLIO ALLOCATION WITH REAL-TIME MARKET DATA:
${portfolioText}

YOUR TASK - Provide a UNIQUE, DETAILED, and ACTIONABLE analysis based on CURRENT market conditions. Use the EXACT price data, trends, and volume information provided above. Analyze price charts, trends, and market dynamics in real-time.

FORMAT YOUR RESPONSE with these EXACT sections:

1. PORTFOLIO OVERVIEW:
   - Quick summary of the portfolio composition
   - Overall risk assessment
   - Portfolio balance analysis

2. COIN COMPARISON (Compare all selected coins):
   - Which coins complement each other? Why?
   - Which coins might conflict? Why?
   - Best coin combinations for this portfolio
   - Relative strengths and weaknesses of each coin

3. TIME-BASED RECOMMENDATIONS (For each coin):

   SHORT-TERM (1-7 days):
   - Immediate actions to take
   - Entry points for buying
   - Quick profit-taking opportunities
   - Day trading opportunities if applicable

   MEDIUM-TERM (1-3 months):
   - Price targets to watch
   - When to accumulate more
   - When to take partial profits
   - Portfolio rebalancing suggestions

   LONG-TERM (6+ months):
   - Strategic hold recommendations
   - Major price milestones
   - When to exit completely
   - Long-term growth potential

4. REAL-TIME MARKET ANALYSIS FOR EACH COIN:
   - Current price position relative to ATH/ATL (use exact percentages provided)
   - Volume analysis: ${portfolioInfo.map(c => `${c.symbol} has ${priceData.find(d => d.symbol === c.symbol)?.volumeAnalysis || 'unknown'} liquidity`).join(', ')}
   - Price momentum: Analyze the 24h, 7d, and 30d changes to identify trends
   - Volatility assessment: Is the coin stable or highly volatile right now?
   - Chart pattern analysis: Based on price changes, is it forming support/resistance?
   - Unique characteristics and current market sentiment

5. ACTIONABLE RECOMMENDATIONS BASED ON CURRENT PRICES:
   For each coin, provide SPECIFIC advice using CURRENT prices:
   - WHEN TO BUY: Based on current price $X, buy if it drops to $Y (X% below current) OR if it breaks above $Z (resistance level)
   - WHEN TO SELL: Based on current price $X, take profits at $Y (X% above current) OR set stop-loss at $Z
   - PORTFOLIO ADJUSTMENT: Increase/decrease percentage? Why? (Consider current trend and distance from ATH)
   - ENTRY STRATEGY: Dollar-cost averaging or lump sum? Based on current volatility

6. MARKET TIMING INSIGHTS:
   - Best time to enter based on current trends
   - Risk assessment based on current volatility
   - Market sentiment analysis (bullish/bearish/neutral)
   - Correlation between selected coins (do they move together or independently?)

7. OVERALL STRATEGY:
   - Portfolio balance assessment based on current market conditions
   - Risk management advice using real-time volatility data
   - Opportunity identification from current price positions
   - Next steps with specific action items

IMPORTANT: 
- Use the EXACT current prices and percentages provided above
- Reference the real-time data (24h, 7d, 30d changes) in your analysis
- Mention the distance from ATH/ATL when relevant
- Be specific with numbers: "Buy at $X" not "Buy when price drops"
- Format your response with clear sections, use bullet points, and make it easy to read
- Add timestamps or "as of now" references to emphasize real-time analysis`;

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: 'mistral-small',
                messages: [
                    { role: 'system', content: 'You are an expert cryptocurrency investment advisor and portfolio strategist. You provide detailed, actionable, and unique investment advice based on real market data. Always be specific with numbers and conditions.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.8,
                max_tokens: 1500
            })
        });

        const data = await response.json();
        
        if (data.choices && data.choices[0]) {
            let recommendations = data.choices[0].message.content.trim();
            
            // Форматируем текст для красивого отображения
            // Заменяем markdown на HTML
            recommendations = recommendations
                .replace(/\*\*(.*?)\*\*/g, '<strong style="color: #ffd700; font-size: 1.1em;">$1</strong>')
                .replace(/\*(.*?)\*/g, '<em style="color: #ffaaaa;">$1</em>')
                .replace(/^### (.*$)/gim, '<h5 style="color: #ffd700; font-size: 1.2em; margin-top: 20px; margin-bottom: 10px; border-bottom: 2px solid rgba(255, 215, 0, 0.3); padding-bottom: 5px; text-align: left;">$1</h5>')
                .replace(/^## (.*$)/gim, '<h4 style="color: #ffd700; font-size: 1.3em; margin-top: 25px; margin-bottom: 15px; border-bottom: 2px solid rgba(255, 215, 0, 0.5); padding-bottom: 8px; text-align: left;">$1</h4>')
                .replace(/^# (.*$)/gim, '<h3 style="color: #ffd700; font-size: 1.4em; margin-top: 30px; margin-bottom: 20px; border-bottom: 3px solid rgba(255, 215, 0, 0.6); padding-bottom: 10px; text-align: left;">$1</h3>')
                .replace(/^(\d+\.\s+.*$)/gim, '<div style="margin: 15px 0; padding-left: 10px; border-left: 3px solid rgba(255, 215, 0, 0.5); text-align: left;"><strong style="color: #ffd700;">$1</strong></div>')
                .replace(/^[-•]\s+(.*$)/gim, '<div style="margin: 8px 0; padding-left: 20px; position: relative; text-align: left;"><span style="position: absolute; left: 0; color: #ffd700;">▸</span> $1</div>')
                .replace(/\n\n/g, '</p><p style="margin: 15px 0; text-align: left;">')
                .replace(/\n/g, '<br>');
            
            // Добавляем иконки для временных рамок
            recommendations = recommendations
                .replace(/SHORT-TERM|Short-term|1-7 days/gi, '<span style="color: #ff6b6b; font-weight: bold;">⚡ SHORT-TERM (1-7 days)</span>')
                .replace(/MEDIUM-TERM|Medium-term|1-3 months/gi, '<span style="color: #ffa500; font-weight: bold;">📅 MEDIUM-TERM (1-3 months)</span>')
                .replace(/LONG-TERM|Long-term|6\+ months/gi, '<span style="color: #4ecdc4; font-weight: bold;">🎯 LONG-TERM (6+ months)</span>')
                .replace(/WHEN TO BUY|Buy/gi, '<span style="color: #51cf66; font-weight: bold;">🟢 BUY:</span>')
                .replace(/WHEN TO SELL|Sell/gi, '<span style="color: #ff6b6b; font-weight: bold;">🔴 SELL:</span>');
            
            // Добавляем временную метку актуальности данных
            const timestamp = new Date().toLocaleString('en-US', { 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric', 
                hour: '2-digit', 
                minute: '2-digit',
                timeZoneName: 'short'
            });
            
            // Красивый дисклеймер
            const disclaimer = `
                <div class="ai-disclaimer" style="
                    margin-top: 30px;
                    padding: 20px;
                    background: linear-gradient(135deg, rgba(202, 0, 0, 0.15) 0%, rgba(139, 0, 0, 0.2) 100%);
                    border: 2px solid rgba(255, 0, 0, 0.4);
                    border-left: 5px solid #ff0000;
                    border-radius: 10px;
                    box-shadow: 0 4px 15px rgba(255, 0, 0, 0.2), inset 0 0 20px rgba(255, 0, 0, 0.1);
                    position: relative;
                    overflow: hidden;
                ">
                    <div style="
                        position: absolute;
                        top: 0;
                        left: 0;
                        right: 0;
                        height: 3px;
                        background: linear-gradient(90deg, transparent, rgba(255, 0, 0, 0.6), transparent);
                        animation: shimmer 3s infinite;
                    "></div>
                    <div style="
                        display: flex;
                        align-items: flex-start;
                        gap: 15px;
                    ">
                        <div style="
                            font-size: 2em;
                            line-height: 1;
                            color: #ff0000;
                            text-shadow: 0 0 10px rgba(255, 0, 0, 0.5);
                        ">⚠️</div>
                        <div style="flex: 1;">
                            <h5 style="
                                color: #ff0000;
                                font-size: 1.2em;
                                font-weight: bold;
                                margin: 0 0 12px 0;
                                text-shadow: 0 0 8px rgba(255, 0, 0, 0.3);
                            ">⚠️ IMPORTANT DISCLAIMER: NOT FINANCIAL ADVICE</h5>
                            <p style="
                                color: #ffffff;
                                font-size: 1.05em;
                                line-height: 1.8;
                                margin: 0;
                                text-align: left;
                                font-weight: 500;
                            ">
                                <strong style="color: #ffaaaa;">This analysis is for educational and training purposes only.</strong> 
                                It is <strong style="color: #ff6666;">NOT financial advice</strong> and should not be considered as such. 
                                Cryptocurrency markets are <strong style="color: #ff0000;">highly unpredictable and volatile</strong>, 
                                making it <strong style="color: #ff0000;">impossible to predict future price movements with certainty</strong>.
                            </p>
                            <p style="
                                color: #ffaaaa;
                                font-size: 1em;
                                line-height: 1.8;
                                margin: 15px 0 0 0;
                                text-align: left;
                                font-style: italic;
                                border-top: 1px solid rgba(255, 0, 0, 0.3);
                                padding-top: 15px;
                            ">
                                <strong style="color: #ff0000;">Real-world proof:</strong> On October 10th, cryptocurrency prices 
                                plummeted to their lowest levels in mere minutes, demonstrating that <strong style="color: #ff0000;">no one can 
                                accurately forecast market movements</strong>. Such sudden crashes can occur at any moment, 
                                regardless of technical analysis or market indicators.
                            </p>
                            <p style="
                                color: #ffffff;
                                font-size: 1em;
                                line-height: 1.8;
                                margin: 15px 0 0 0;
                                text-align: left;
                                font-weight: 500;
                            ">
                                <strong style="color: #ff6666;">Always conduct your own research (DYOR)</strong>, assess your risk 
                                tolerance, and never invest more than you can afford to lose. <strong style="color: #ff0000;">All trading 
                                decisions are your sole responsibility</strong>, and any losses incurred are entirely your own.
                            </p>
                        </div>
                    </div>
                </div>
                <style>
                    @keyframes shimmer {
                        0% { transform: translateX(-100%); }
                        100% { transform: translateX(100%); }
                    }
                </style>
            `;
            
            recommendationsContent.innerHTML = `
                <div class="recommendation-item">
                    <div style="color: #ffd700; font-size: 0.9em; margin-bottom: 15px; padding: 8px; background: rgba(255, 215, 0, 0.1); border-radius: 5px; text-align: center;">
                        📊 Real-time analysis as of ${timestamp} | Data from live market feeds
                    </div>
                    <div style="color: #ffffff; font-weight: bold; line-height: 1.9; font-size: 1.05em; text-align: left; width: 100%;">
                        <p style="margin: 15px 0; text-align: left;">${recommendations}</p>
                    </div>
                    ${disclaimer}
                </div>
            `;
        }
    } catch (error) {
        console.error('AI Error:', error);
        recommendationsContent.innerHTML = '<p style="color: #ffffff; font-weight: bold;">Error connecting to AI</p>';
    }
}

function updateAdvice() {
    const experience = document.getElementById('experienceLevel')?.value || 'beginner';
    const risk = document.getElementById('riskLevel')?.value || 50;
    const goal = document.getElementById('goal')?.value || 'long';

    const adviceContent = document.getElementById('adviceContent');
    if (!adviceContent) return;
    
    adviceContent.innerHTML = '<em style="color: #ff6666;">🤖 Generating personalized advice...</em>';

    const adviceMap = {
        'beginner-low-short': 'As a low-risk beginner, consider ETH staking with a guaranteed 5% APY.',
        'beginner-low-long': 'For long-term growth, start with blue chips: BTC and ETH make an excellent portfolio foundation.',
        'intermediate-medium-short': 'With your experience and medium risk, consider day trading volatile altcoins with a clear 5% stop-loss.',
        'intermediate-medium-long': 'Build a diversified portfolio: 40% BTC/ETH, 30% large altcoins (SOL, ADA), 30% high-potential coins.',
        'expert-high-short': 'Use your expertise for arbitrage and short-term trades.',
        'expert-high-long': 'Create an aggressive portfolio with altcoins.'
    };

    const riskLevel = risk < 30 ? 'low' : risk < 70 ? 'medium' : 'high';
    const key = `${experience}-${riskLevel}-${goal}`;
    
    if (adviceMap[key]) {
        adviceContent.textContent = `"${adviceMap[key]}"`;
    } else {
        adviceContent.textContent = `"Based on your profile, we recommend diversifying your portfolio between BTC, ETH, and verified altcoins."`;
    }
}

// Enhanced Mood Analysis
let currentMoodScore = 50; // 0-100, 0 = extreme fear, 100 = extreme greed

async function analyzeMoodEnhanced() {
    const moodText = document.getElementById('moodText')?.value;
    const moodResult = document.getElementById('moodResult');
    
    if (!moodResult) return;
    
    if (!moodText || !moodText.trim()) {
        alert('Please describe your mood');
        return;
    }

    moodResult.style.display = 'block';
    moodResult.innerHTML = '<em style="color: #ff6666;">🤖 AI is deeply analyzing your emotional state...</em>';

    try {
        const prompt = `The user described their cryptocurrency trading/investment mood as: "${moodText}". 

You are an expert trading psychology coach. Analyze their emotional state and provide:
1. Emotional state assessment (Fear/Greed scale 0-100)
2. Trading readiness (Should they trade now or wait?)
3. Specific risks based on their emotions
4. Practical recommendations
5. When would be the best time to make decisions

Format your response clearly with sections.`;

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: 'mistral-small',
                messages: [
                    { role: 'system', content: 'You are an expert trading psychology coach specializing in emotional intelligence and trading decisions.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.7,
                max_tokens: 500
            })
        });

        const data = await response.json();
        
        if (data.choices && data.choices[0]) {
            const analysis = data.choices[0].message.content.trim();
            
            // Extract mood score (0-100) from analysis
            const scoreMatch = analysis.match(/(\d+)\s*(?:out of 100|\/100|points?)/i);
            if (scoreMatch) {
                currentMoodScore = parseInt(scoreMatch[1]);
            } else {
                // Estimate from keywords
                const fearWords = (analysis.match(/fear|anxious|worried|panic|stress/gi) || []).length;
                const greedWords = (analysis.match(/greed|excited|confident|optimistic|euphoric/gi) || []).length;
                currentMoodScore = Math.max(0, Math.min(100, 50 + (greedWords * 10) - (fearWords * 10)));
            }
            
            moodResult.innerHTML = `
                <div style="color: #ffffff; line-height: 1.8;">
                    <div style="margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid rgba(255, 0, 0, 0.3);">
                        <strong style="color: #ffd700; font-size: 1.1rem;">📊 Your Emotional State:</strong>
                        <div style="margin-top: 10px;">
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <div style="flex: 1; height: 20px; background: rgba(0, 0, 0, 0.5); border-radius: 10px; overflow: hidden; position: relative;">
                                    <div style="
                                        height: 100%;
                                        width: ${currentMoodScore}%;
                                        background: linear-gradient(90deg, #ff0000 0%, #ffaa00 50%, #00ff00 100%);
                                        transition: width 0.5s ease;
                                    "></div>
                                </div>
                                <span style="color: #ffd700; font-weight: bold; font-size: 1.2rem;">${currentMoodScore}/100</span>
                            </div>
                            <div style="margin-top: 5px; color: #cccccc; font-size: 0.9rem;">
                                ${currentMoodScore < 30 ? '😰 Extreme Fear' : currentMoodScore < 50 ? '😟 Fear' : currentMoodScore < 70 ? '😐 Neutral' : currentMoodScore < 90 ? '😊 Greed' : '🤩 Extreme Greed'}
                            </div>
                        </div>
                    </div>
                    <div style="color: #ffffff;">
                        ${analysis.replace(/\n/g, '<br>')}
                    </div>
                </div>
            `;
            
            // Update your mood value in sentiment comparison
            updateYourMoodDisplay(currentMoodScore);
        }
    } catch (error) {
        console.error('AI Error:', error);
        moodResult.innerHTML = '<p style="color: #ff6666;">Error connecting to AI. Please try again.</p>';
    }
}

// Market Sentiment vs Your Mood
let marketSentimentScore = 50;

async function fetchMarketSentiment() {
    try {
        // Using alternative.me API for Fear & Greed Index
        const response = await fetch('https://api.alternative.me/fng/?limit=1');
        const data = await response.json();
        
        if (data.data && data.data[0]) {
            marketSentimentScore = parseInt(data.data[0].value);
            return marketSentimentScore;
        }
    } catch (error) {
        console.error('Error fetching market sentiment:', error);
        // Fallback: random for demo
        marketSentimentScore = Math.floor(Math.random() * 100);
    }
    return marketSentimentScore;
}

function updateYourMoodDisplay(score) {
    const yourMoodValue = document.getElementById('yourMoodValue');
    const yourMoodLabel = document.getElementById('yourMoodLabel');
    
    if (yourMoodValue) yourMoodValue.textContent = score;
    if (yourMoodLabel) {
        yourMoodLabel.textContent = score < 30 ? 'Extreme Fear' : score < 50 ? 'Fear' : score < 70 ? 'Neutral' : score < 90 ? 'Greed' : 'Extreme Greed';
        yourMoodLabel.style.color = score < 30 ? '#ff0000' : score < 50 ? '#ff6666' : score < 70 ? '#ffd700' : score < 90 ? '#00ff00' : '#00ff00';
    }
}

async function compareSentiment() {
    const sentimentComparisonResult = document.getElementById('sentimentComparisonResult');
    const sentimentInsight = document.getElementById('sentimentInsight');
    const marketSentimentValue = document.getElementById('marketSentimentValue');
    const marketSentimentLabel = document.getElementById('marketSentimentLabel');
    
    if (!sentimentComparisonResult) return;
    
    // Fetch market sentiment
    const marketScore = await fetchMarketSentiment();
    
    if (marketSentimentValue) marketSentimentValue.textContent = marketScore;
    if (marketSentimentLabel) {
        marketSentimentLabel.textContent = marketScore < 30 ? 'Extreme Fear' : marketScore < 50 ? 'Fear' : marketScore < 70 ? 'Neutral' : marketScore < 90 ? 'Greed' : 'Extreme Greed';
        marketSentimentLabel.style.color = marketScore < 30 ? '#ff0000' : marketScore < 50 ? '#ff6666' : marketScore < 70 ? '#ffd700' : marketScore < 90 ? '#00ff00' : '#00ff00';
    }
    
    if (currentMoodScore === 50 && !document.getElementById('moodText')?.value) {
        sentimentInsight.textContent = 'Please analyze your mood first to see the comparison.';
        sentimentComparisonResult.style.display = 'block';
        return;
    }
    
    const difference = Math.abs(marketScore - currentMoodScore);
    let insight = '';
    let recommendation = '';
    
    if (difference < 20) {
        insight = `You and the market are aligned (difference: ${difference} points). `;
        if (marketScore < 30) {
            recommendation = 'Both you and the market are in fear. This might be a good buying opportunity, but be cautious.';
        } else if (marketScore > 70) {
            recommendation = 'Both you and the market are in greed. Consider taking profits and being cautious of FOMO.';
        } else {
            recommendation = 'You are both neutral. Good time for rational decision-making.';
        }
    } else {
        if (currentMoodScore < marketScore) {
            insight = `The market is more optimistic than you (difference: ${difference} points). `;
            recommendation = 'You are more cautious than the market. This could be good - avoid FOMO. Consider waiting for better entry points.';
        } else {
            insight = `You are more optimistic than the market (difference: ${difference} points). `;
            recommendation = 'You are more bullish than the market. Be careful of overconfidence. The market might be right - consider being more cautious.';
        }
    }
    
    sentimentInsight.innerHTML = `<strong>${insight}</strong>${recommendation}`;
    sentimentComparisonResult.style.display = 'block';
}

// Stress Level Monitor
let stressHistory = JSON.parse(localStorage.getItem('stressHistory') || '[]');

function updateStressLevel(value) {
    const stressValue = document.getElementById('stressValue');
    if (stressValue) {
        stressValue.textContent = value;
        const color = value < 30 ? '#00ff00' : value < 60 ? '#ffd700' : value < 80 ? '#ff6666' : '#ff0000';
        stressValue.style.color = color;
    }
    
    updateStressRecommendations(parseInt(value));
    drawStressChart();
}

function updateStressRecommendations(level) {
    const stressRecommendations = document.getElementById('stressRecommendations');
    const stressWarning = document.getElementById('stressWarning');
    
    if (!stressRecommendations || !stressWarning) return;
    
    if (level < 30) {
        stressWarning.innerHTML = '<span style="color: #00ff00;">✅ Your stress level is low. Great for making rational trading decisions!</span>';
        stressRecommendations.style.borderLeftColor = '#00ff00';
    } else if (level < 60) {
        stressWarning.innerHTML = '<span style="color: #ffd700;">⚠️ Moderate stress detected. Take a break before making important decisions.</span>';
        stressRecommendations.style.borderLeftColor = '#ffd700';
    } else if (level < 80) {
        stressWarning.innerHTML = '<span style="color: #ff6666;">⚠️ High stress level! Avoid trading now. Take deep breaths, step away from the screen.</span>';
        stressRecommendations.style.borderLeftColor = '#ff6666';
    } else {
        stressWarning.innerHTML = '<span style="color: #ff0000;">🚨 EXTREME STRESS! DO NOT TRADE NOW. Close your trading apps, take a walk, meditate. Your decisions will be emotional and risky.</span>';
        stressRecommendations.style.borderLeftColor = '#ff0000';
    }
    
    stressRecommendations.style.display = 'block';
}

function saveStressLevel() {
    const stressLevel = document.getElementById('stressLevel')?.value;
    if (!stressLevel) return;
    
    const entry = {
        timestamp: Date.now(),
        date: new Date().toLocaleDateString(),
        level: parseInt(stressLevel)
    };
    
    stressHistory.push(entry);
    
    // Keep only last 7 days
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    stressHistory = stressHistory.filter(e => e.timestamp > sevenDaysAgo);
    
    localStorage.setItem('stressHistory', JSON.stringify(stressHistory));
    drawStressChart();
    
    alert(`Stress level ${stressLevel}/100 saved!`);
}

function drawStressChart() {
    const canvas = document.getElementById('stressChart');
    if (!canvas || stressHistory.length === 0) return;
    
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth;
    canvas.height = 120;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const padding = 20;
    const chartWidth = canvas.width - (padding * 2);
    const chartHeight = canvas.height - (padding * 2);
    
    // Draw grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding + (chartHeight / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(padding + chartWidth, y);
        ctx.stroke();
    }
    
    // Draw line
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    const last7Days = stressHistory.slice(-7);
    last7Days.forEach((entry, index) => {
        const x = padding + (chartWidth / (last7Days.length - 1 || 1)) * index;
        const y = padding + chartHeight - (entry.level / 100) * chartHeight;
        
        if (index === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });
    
    ctx.stroke();
    
    // Draw points
    ctx.fillStyle = '#ff0000';
    last7Days.forEach((entry, index) => {
        const x = padding + (chartWidth / (last7Days.length - 1 || 1)) * index;
        const y = padding + chartHeight - (entry.level / 100) * chartHeight;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
    });
}

// Pre-Trade Mental Check
function checkReadiness() {
    const checks = document.querySelectorAll('.mental-check');
    const preTradeResult = document.getElementById('preTradeResult');
    const readinessScore = document.getElementById('readinessScore');
    const readinessLabel = document.getElementById('readinessLabel');
    const readinessRecommendations = document.getElementById('readinessRecommendations');
    
    if (!preTradeResult) return;
    
    let checkedCount = 0;
    const totalChecks = checks.length;
    const missingChecks = [];
    
    checks.forEach(check => {
        if (check.checked) {
            checkedCount++;
        } else {
            const label = check.closest('label')?.querySelector('span')?.textContent || '';
            missingChecks.push(label);
        }
    });
    
    const score = Math.round((checkedCount / totalChecks) * 100);
    
    // Update score display
    if (readinessScore) {
        readinessScore.textContent = score + '%';
        if (score >= 80) {
            readinessScore.style.color = '#00ff00';
        } else if (score >= 60) {
            readinessScore.style.color = '#ffd700';
        } else if (score >= 40) {
            readinessScore.style.color = '#ffaa00';
        } else {
            readinessScore.style.color = '#ff0000';
        }
    }
    
    // Update label
    if (readinessLabel) {
        if (score >= 80) {
            readinessLabel.textContent = '✅ Ready to Trade';
            readinessLabel.style.color = '#00ff00';
        } else if (score >= 60) {
            readinessLabel.textContent = '⚠️ Proceed with Caution';
            readinessLabel.style.color = '#ffd700';
        } else {
            readinessLabel.textContent = '🚫 NOT Ready - Do NOT Trade';
            readinessLabel.style.color = '#ff0000';
        }
    }
    
    // Recommendations
    if (readinessRecommendations) {
        let recommendations = '';
        if (score >= 80) {
            recommendations = '<div style="color: #00ff00; font-weight: bold;">✅ You are in good mental state to make trading decisions. Proceed with your trading plan.</div>';
        } else if (score >= 60) {
            recommendations = '<div style="color: #ffd700; font-weight: bold;">⚠️ You are partially ready. Consider waiting or being extra cautious.</div>';
            if (missingChecks.length > 0) {
                recommendations += '<div style="margin-top: 10px; color: #ffaa00;">Missing checks:</div><ul style="margin-top: 5px; padding-left: 20px;">';
                missingChecks.forEach(check => {
                    recommendations += `<li style="margin-bottom: 5px;">${check}</li>`;
                });
                recommendations += '</ul>';
            }
        } else {
            recommendations = '<div style="color: #ff0000; font-weight: bold;">🚫 You are NOT ready to trade. Please address the following before making any trading decisions:</div>';
            recommendations += '<ul style="margin-top: 10px; padding-left: 20px;">';
            missingChecks.forEach(check => {
                recommendations += `<li style="margin-bottom: 8px; color: #ff6666;">${check}</li>`;
            });
            recommendations += '</ul>';
            recommendations += '<div style="margin-top: 15px; padding: 10px; background: rgba(255, 0, 0, 0.2); border-radius: 5px; color: #ffffff;">⚠️ Trading in this state significantly increases your risk of making emotional, poor decisions.</div>';
        }
        readinessRecommendations.innerHTML = recommendations;
    }
    
    preTradeResult.style.display = 'block';
    preTradeResult.style.borderLeftColor = score >= 80 ? '#00ff00' : score >= 60 ? '#ffd700' : '#ff0000';
}

// Cognitive Bias Detector
async function detectBiases() {
    const decisionText = document.getElementById('tradingDecision')?.value;
    const biasResult = document.getElementById('biasResult');
    const biasAnalysis = document.getElementById('biasAnalysis');
    const biasRecommendations = document.getElementById('biasRecommendations');
    
    if (!biasResult) return;
    
    if (!decisionText || !decisionText.trim()) {
        alert('Please describe your trading decision');
        return;
    }
    
    biasResult.style.display = 'block';
    biasAnalysis.innerHTML = '<em style="color: #ff6666;">🤖 AI is analyzing your decision for cognitive biases...</em>';
    biasRecommendations.innerHTML = '';
    
    try {
        const prompt = `The user described a trading decision: "${decisionText}"

You are an expert in behavioral finance and cognitive psychology. Analyze this decision and identify:
1. What cognitive biases are present (anchoring, confirmation bias, loss aversion, FOMO, overconfidence, etc.)
2. How these biases affected the decision
3. Specific recommendations to avoid these biases in the future

Format your response clearly with sections.`;

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: 'mistral-small',
                messages: [
                    { role: 'system', content: 'You are an expert in behavioral finance, cognitive psychology, and trading psychology. You help traders identify and overcome cognitive biases.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.7,
                max_tokens: 600
            })
        });

        const data = await response.json();
        
        if (data.choices && data.choices[0]) {
            const analysis = data.choices[0].message.content.trim();
            
            // Split analysis and recommendations
            const parts = analysis.split(/(?:recommendations?|suggestions?|advice)/i);
            
            if (parts.length > 1) {
                biasAnalysis.innerHTML = `<div style="color: #ffffff; line-height: 1.8;"><strong style="color: #ffd700;">🔍 Detected Biases:</strong><br>${parts[0].replace(/\n/g, '<br>')}</div>`;
                biasRecommendations.innerHTML = `<div style="color: #ffffff; line-height: 1.8; margin-top: 15px;"><strong style="color: #00ff00;">💡 Recommendations:</strong><br>${parts.slice(1).join(' ').replace(/\n/g, '<br>')}</div>`;
            } else {
                biasAnalysis.innerHTML = `<div style="color: #ffffff; line-height: 1.8;">${analysis.replace(/\n/g, '<br>')}</div>`;
            }
        }
    } catch (error) {
        console.error('AI Error:', error);
        biasAnalysis.innerHTML = '<p style="color: #ff6666;">Error connecting to AI. Please try again.</p>';
    }
}

// Trading Time Optimizer
let tradingTimeHistory = JSON.parse(localStorage.getItem('tradingTimeHistory') || '[]');

function recordTradingTime() {
    const tradeTime = document.getElementById('tradeTime')?.value;
    const tradingHours = parseInt(document.getElementById('tradingHours')?.value || 0);
    const success = document.querySelector('input[name="tradeSuccess"]:checked')?.value;
    
    if (!success) {
        alert('Please indicate if the trade was successful');
        return;
    }
    
    const entry = {
        timestamp: Date.now(),
        date: new Date().toLocaleDateString(),
        time: tradeTime,
        hours: tradingHours,
        success: success === 'yes'
    };
    
    tradingTimeHistory.push(entry);
    
    // Keep only last 30 entries
    if (tradingTimeHistory.length > 30) {
        tradingTimeHistory = tradingTimeHistory.slice(-30);
    }
    
    localStorage.setItem('tradingTimeHistory', JSON.stringify(tradingTimeHistory));
    
    analyzeTradingTime();
    drawTimeChart();
    
    alert('Trading time recorded!');
}

function analyzeTradingTime() {
    const timeOptimizerResult = document.getElementById('timeOptimizerResult');
    const optimalTime = document.getElementById('optimalTime');
    const timeRecommendations = document.getElementById('timeRecommendations');
    
    if (!timeOptimizerResult || tradingTimeHistory.length === 0) return;
    
    // Analyze success rate by time of day
    const timeStats = {
        morning: { total: 0, successful: 0 },
        afternoon: { total: 0, successful: 0 },
        evening: { total: 0, successful: 0 },
        night: { total: 0, successful: 0 }
    };
    
    tradingTimeHistory.forEach(entry => {
        if (timeStats[entry.time]) {
            timeStats[entry.time].total++;
            if (entry.success) {
                timeStats[entry.time].successful++;
            }
        }
    });
    
    // Calculate success rates
    const successRates = {};
    Object.keys(timeStats).forEach(time => {
        if (timeStats[time].total > 0) {
            successRates[time] = (timeStats[time].successful / timeStats[time].total) * 100;
        }
    });
    
    // Find optimal time
    let bestTime = '';
    let bestRate = 0;
    Object.keys(successRates).forEach(time => {
        if (successRates[time] > bestRate) {
            bestRate = successRates[time];
            bestTime = time;
        }
    });
    
    const timeLabels = {
        morning: 'Morning (6 AM - 12 PM)',
        afternoon: 'Afternoon (12 PM - 6 PM)',
        evening: 'Evening (6 PM - 12 AM)',
        night: 'Night (12 AM - 6 AM)'
    };
    
    if (optimalTime) {
        if (bestTime && bestRate > 0) {
            optimalTime.textContent = timeLabels[bestTime];
            optimalTime.style.color = '#00ff00';
        } else {
            optimalTime.textContent = 'Need more data';
            optimalTime.style.color = '#ffd700';
        }
    }
    
    // Recommendations
    if (timeRecommendations) {
        let recommendations = '';
        
        if (bestTime && bestRate > 0) {
            recommendations += `<div style="color: #00ff00; font-weight: bold; margin-bottom: 10px;">✅ Your best trading time is <strong>${timeLabels[bestTime]}</strong> with ${bestRate.toFixed(1)}% success rate.</div>`;
        }
        
        // Analyze trading hours
        const avgHours = tradingTimeHistory.reduce((sum, e) => sum + e.hours, 0) / tradingTimeHistory.length;
        if (avgHours > 6) {
            recommendations += `<div style="color: #ffaa00; margin-top: 10px;">⚠️ You average ${avgHours.toFixed(1)} hours of trading per day. Consider taking breaks to maintain focus.</div>`;
        }
        
        // Success rate by hours
        const shortTrades = tradingTimeHistory.filter(e => e.hours < 2);
        const longTrades = tradingTimeHistory.filter(e => e.hours >= 2);
        
        if (shortTrades.length > 0 && longTrades.length > 0) {
            const shortSuccess = (shortTrades.filter(e => e.success).length / shortTrades.length) * 100;
            const longSuccess = (longTrades.filter(e => e.success).length / longTrades.length) * 100;
            
            if (shortSuccess > longSuccess) {
                recommendations += `<div style="color: #00ff00; margin-top: 10px;">💡 You perform better when trading for less than 2 hours. Consider shorter trading sessions.</div>`;
            } else if (longSuccess > shortSuccess) {
                recommendations += `<div style="color: #00ff00; margin-top: 10px;">💡 You perform better with longer trading sessions. Take your time to analyze.</div>`;
            }
        }
        
        if (!recommendations) {
            recommendations = '<div style="color: #cccccc;">Record more trades to get personalized recommendations.</div>';
        }
        
        timeRecommendations.innerHTML = recommendations;
    }
    
    timeOptimizerResult.style.display = 'block';
}

function drawTimeChart() {
    const canvas = document.getElementById('timeChart');
    if (!canvas || tradingTimeHistory.length === 0) return;
    
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth;
    canvas.height = 200;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Group by time of day
    const timeStats = {
        morning: { total: 0, successful: 0 },
        afternoon: { total: 0, successful: 0 },
        evening: { total: 0, successful: 0 },
        night: { total: 0, successful: 0 }
    };
    
    tradingTimeHistory.forEach(entry => {
        if (timeStats[entry.time]) {
            timeStats[entry.time].total++;
            if (entry.success) {
                timeStats[entry.time].successful++;
            }
        }
    });
    
    const times = ['morning', 'afternoon', 'evening', 'night'];
    const labels = ['Morning', 'Afternoon', 'Evening', 'Night'];
    const padding = 40;
    const chartWidth = canvas.width - (padding * 2);
    const chartHeight = canvas.height - (padding * 2);
    const barWidth = chartWidth / times.length;
    
    // Draw bars
    times.forEach((time, index) => {
        const stats = timeStats[time];
        const successRate = stats.total > 0 ? (stats.successful / stats.total) * 100 : 0;
        const barHeight = (successRate / 100) * chartHeight;
        const x = padding + (index * barWidth) + (barWidth * 0.2);
        const y = padding + chartHeight - barHeight;
        const w = barWidth * 0.6;
        
        // Color based on success rate
        ctx.fillStyle = successRate >= 70 ? '#00ff00' : successRate >= 50 ? '#ffd700' : '#ff6666';
        ctx.fillRect(x, y, w, barHeight);
        
        // Label
        ctx.fillStyle = '#ffffff';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(labels[index], x + w/2, padding + chartHeight + 15);
        ctx.fillText(successRate.toFixed(0) + '%', x + w/2, y - 5);
    });
}

// Initialize on load
document.addEventListener('DOMContentLoaded', function() {
    setTimeout(() => {
        fetchMarketSentiment();
        drawStressChart();
        analyzeTradingTime();
        drawTimeChart();
    }, 1000);
});

// Legacy function for compatibility
async function analyzeMood() {
    await analyzeMoodEnhanced();
}

function updateRiskDisplay() {
    const riskLevel = document.getElementById('riskLevel')?.value || 50;
    const riskValue = document.getElementById('riskValue');
    if (riskValue) riskValue.textContent = riskLevel + '%';
}

let portfolioChart = null;
let currentTimeRange = '2d'; // По умолчанию 2 дня
let currentPortfolioName = null;

async function savePortfolio() {
    const portfolioNameInput = document.getElementById('portfolioName');
    const portfolioName = portfolioNameInput?.value?.trim() || prompt('Enter portfolio name:') || 'My Portfolio';
    
    if (!portfolioName) {
        alert('Please enter a portfolio name!');
        return;
    }
    
    const savedPortfolios = JSON.parse(localStorage.getItem('savedPortfolios') || '{}');
    
    // Проверяем, существует ли уже портфолио с таким именем
    if (savedPortfolios[portfolioName]) {
        if (!confirm(`Portfolio "${portfolioName}" already exists. Do you want to update it?`)) {
            return;
        }
    }
    
    // Инициализируем портфолио, если его еще нет
    if (!savedPortfolios[portfolioName]) {
        savedPortfolios[portfolioName] = {
            name: portfolioName,
            initialDeposit: portfolioValue,
            portfolioComposition: [],
            history: [] // История изменений стоимости
        };
    }
    
    // Получаем текущие данные портфолио
    const initialDeposit = portfolioValue;
    const portfolioComposition = Object.keys(selectedCoins).map(coin => ({
        symbol: coin,
        percentage: selectedCoins[coin].percentage || 0
    })).filter(coin => coin.percentage > 0);
    
    // Вычисляем текущую стоимость портфолио на основе реальных цен
    let currentPortfolioValue = initialDeposit;
    let portfolioDetails = [];
    
    if (portfolioComposition.length > 0) {
        try {
            for (const coin of portfolioComposition) {
                try {
                    const priceResponse = await fetch(`${LIVECOINWATCH_URL}/${coin.symbol}`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': LIVECOINWATCH_KEY
                        },
                        body: JSON.stringify({
                            currency: 'USD',
                            meta: true
                        })
                    });
                    
                    const priceInfo = await priceResponse.json();
                    if (priceInfo && priceInfo.rate) {
                        const coinValue = (initialDeposit * coin.percentage / 100);
                        const priceChange = priceInfo.delta?.day || 0;
                        const currentCoinValue = coinValue * (1 + priceChange / 100);
                        currentPortfolioValue += (currentCoinValue - coinValue);
                        
                        portfolioDetails.push({
                            symbol: coin.symbol,
                            percentage: coin.percentage,
                            price: priceInfo.rate.toFixed(6),
                            priceChange24h: priceChange.toFixed(2) + '%',
                            value: coinValue.toFixed(2),
                            currentValue: currentCoinValue.toFixed(2)
                        });
                    }
                } catch (e) {
                    console.log(`Could not fetch price for ${coin.symbol}`);
                }
            }
        } catch (e) {
            console.log('Error calculating portfolio value');
        }
    }
    
    if (portfolioComposition.length === 0) {
        alert('Please select at least one coin for your portfolio!');
        return;
    }
    
    // Вычисляем прибыль/убыток
    const profitLoss = currentPortfolioValue - initialDeposit;
    const profitLossPercent = initialDeposit > 0 ? ((profitLoss / initialDeposit) * 100).toFixed(2) : 0;
    
    const now = new Date();
    const timestamp = now.toISOString();
    const dateLabel = now.toLocaleString('en-US', { 
        month: 'short', 
        day: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit' 
    });
    
    // Обновляем состав портфолио
    savedPortfolios[portfolioName].portfolioComposition = portfolioComposition;
    
    // Добавляем новую точку в историю
    savedPortfolios[portfolioName].history.push({
        timestamp: timestamp,
        dateLabel: dateLabel,
        value: parseFloat(currentPortfolioValue.toFixed(2)),
        profitLoss: parseFloat(profitLoss.toFixed(2)),
        profitLossPercent: parseFloat(profitLossPercent)
    });
    
    // Сохраняем
    localStorage.setItem('savedPortfolios', JSON.stringify(savedPortfolios));
    
    // Обновляем список портфолио
    updatePortfolioSelector();
    
    // Показываем график
    loadPortfolioGraph(portfolioName);
    
    // Очищаем поле ввода
    if (portfolioNameInput) portfolioNameInput.value = '';
    
    // Показываем подтверждение
    alert(`✅ Portfolio "${portfolioName}" saved!\n\nInitial: $${initialDeposit.toFixed(2)}\nCurrent: $${currentPortfolioValue.toFixed(2)}\n${profitLoss >= 0 ? 'Profit' : 'Loss'}: ${profitLoss >= 0 ? '+' : ''}$${profitLoss.toFixed(2)} (${profitLossPercent >= 0 ? '+' : ''}${profitLossPercent}%)`);
}

function updatePortfolioSelector() {
    const selector = document.getElementById('savedPortfolioSelect');
    if (!selector) return;
    
    const savedPortfolios = JSON.parse(localStorage.getItem('savedPortfolios') || '{}');
    const portfolioNames = Object.keys(savedPortfolios);
    
    selector.innerHTML = '<option value="">Select a saved portfolio...</option>';
    
    portfolioNames.forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        selector.appendChild(option);
    });
}

async function loadPortfolioGraph(portfolioName) {
    if (!portfolioName) {
        const container = document.getElementById('portfolioGraphContainer');
        if (container) container.style.display = 'none';
        return;
    }
    
    const savedPortfolios = JSON.parse(localStorage.getItem('savedPortfolios') || '{}');
    const portfolio = savedPortfolios[portfolioName];
    
    if (!portfolio || !portfolio.history || portfolio.history.length === 0) {
        alert('No history data for this portfolio yet. Save it first to start tracking!');
        return;
    }
    
    // Вычисляем текущую стоимость портфолио
    const initialDeposit = portfolio.initialDeposit;
    const portfolioComposition = portfolio.portfolioComposition;
    let currentPortfolioValue = initialDeposit;
    
    if (portfolioComposition && portfolioComposition.length > 0) {
        try {
            for (const coin of portfolioComposition) {
                try {
                    const priceResponse = await fetch(`${LIVECOINWATCH_URL}/${coin.symbol}`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': LIVECOINWATCH_KEY
                        },
                        body: JSON.stringify({
                            currency: 'USD',
                            meta: true
                        })
                    });
                    
                    const priceInfo = await priceResponse.json();
                    if (priceInfo && priceInfo.rate) {
                        const coinValue = (initialDeposit * coin.percentage / 100);
                        const priceChange = priceInfo.delta?.day || 0;
                        const currentCoinValue = coinValue * (1 + priceChange / 100);
                        currentPortfolioValue += (currentCoinValue - coinValue);
                    }
                } catch (e) {
                    console.log(`Could not fetch price for ${coin.symbol}`);
                }
            }
        } catch (e) {
            console.log('Error calculating current portfolio value');
        }
    }
    
    // Добавляем текущую точку, если она отличается от последней
    const now = new Date();
    const lastEntry = portfolio.history[portfolio.history.length - 1];
    const timeDiff = now - new Date(lastEntry.timestamp);
    
    // Обновляем только если прошло больше 5 минут
    if (timeDiff > 5 * 60 * 1000) {
        const dateLabel = now.toLocaleString('en-US', { 
            month: 'short', 
            day: 'numeric', 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        
        portfolio.history.push({
            timestamp: now.toISOString(),
            dateLabel: dateLabel,
            value: parseFloat(currentPortfolioValue.toFixed(2)),
            profitLoss: parseFloat((currentPortfolioValue - initialDeposit).toFixed(2)),
            profitLossPercent: parseFloat(((currentPortfolioValue - initialDeposit) / initialDeposit * 100).toFixed(2))
        });
        
        savedPortfolios[portfolioName] = portfolio;
        localStorage.setItem('savedPortfolios', JSON.stringify(savedPortfolios));
    }
    
    // Сохраняем текущее имя портфолио
    currentPortfolioName = portfolioName;
    
    // Фильтруем историю по выбранному временному интервалу
    const filteredHistory = filterHistoryByTimeRange(portfolio.history, currentTimeRange);
    
    // Подготавливаем данные для графика
    const labels = filteredHistory.map(h => h.dateLabel);
    const values = filteredHistory.map(h => h.value);
    
    // Показываем контейнер графика
    const container = document.getElementById('portfolioGraphContainer');
    if (container) container.style.display = 'block';
    
    // Создаем или обновляем график
    const canvas = document.getElementById('portfolioGraph');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    
    if (portfolioChart) {
        portfolioChart.destroy();
    }
    
    portfolioChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Portfolio Value ($)',
                data: values,
                borderColor: '#ff0000',
                backgroundColor: 'rgba(255, 0, 0, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointRadius: 4,
                pointBackgroundColor: '#ff0000',
                pointBorderColor: '#ffffff',
                pointBorderWidth: 2,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: '#ff6666',
                pointHoverBorderColor: '#ffffff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: '#ffffff',
                        font: {
                            size: 14,
                            weight: 'bold'
                        }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    titleColor: '#ffffff',
                    bodyColor: '#ffffff',
                    borderColor: '#ff0000',
                    borderWidth: 2,
                    callbacks: {
                        label: function(context) {
                            const index = context.dataIndex;
                            const entry = filteredHistory[index];
                            if (!entry) return '';
                            return [
                                `Value: $${entry.value.toFixed(2)}`,
                                `Profit/Loss: ${entry.profitLoss >= 0 ? '+' : ''}$${entry.profitLoss.toFixed(2)}`,
                                `Change: ${entry.profitLossPercent >= 0 ? '+' : ''}${entry.profitLossPercent.toFixed(2)}%`
                            ];
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: '#ffffff',
                        font: {
                            size: 11
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                },
                y: {
                    ticks: {
                        color: '#ffffff',
                        font: {
                            size: 11
                        },
                        callback: function(value) {
                            return '$' + value.toFixed(0);
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                }
            }
        }
    });
    
    // Проверяем, нужен ли ползунок для прокрутки
    updateGraphScrollSlider(filteredHistory.length);
}

// Фильтрует историю по выбранному временному интервалу
function filterHistoryByTimeRange(history, timeRange) {
    if (!history || history.length === 0) return [];
    
    const now = new Date();
    let timeLimit;
    
    switch(timeRange) {
        case '30m':
            timeLimit = new Date(now.getTime() - 30 * 60 * 1000); // 30 минут
            break;
        case '2h':
            timeLimit = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 часа
            break;
        case '8h':
            timeLimit = new Date(now.getTime() - 8 * 60 * 60 * 1000); // 8 часов
            break;
        case '2d':
            timeLimit = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 дня
            break;
        default:
            timeLimit = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // По умолчанию 2 дня
    }
    
    return history.filter(entry => {
        const entryDate = new Date(entry.timestamp);
        return entryDate >= timeLimit;
    });
}

// Изменяет временной интервал графика
function changeTimeRange(range) {
    currentTimeRange = range;
    
    // Обновляем активную кнопку
    document.querySelectorAll('.time-range-btn').forEach(btn => {
        if (btn.dataset.range === range) {
            btn.classList.add('active');
            btn.style.background = 'rgba(255, 0, 0, 0.5)';
            btn.style.border = '2px solid #ff0000';
            btn.style.fontWeight = 'bold';
        } else {
            btn.classList.remove('active');
            btn.style.background = 'rgba(255, 0, 0, 0.3)';
            btn.style.border = '1px solid rgba(255, 0, 0, 0.5)';
            btn.style.fontWeight = 'normal';
        }
    });
    
    // Перезагружаем график с новым интервалом
    if (currentPortfolioName) {
        loadPortfolioGraph(currentPortfolioName);
    }
}

// Обновляет ползунок для прокрутки графика
function updateGraphScrollSlider(dataPoints) {
    const scrollContainer = document.getElementById('graphScrollContainer');
    const slider = document.getElementById('graphScrollSlider');
    
    // Если точек данных больше 20, показываем ползунок
    if (dataPoints > 20 && scrollContainer && slider) {
        scrollContainer.style.display = 'block';
        slider.max = dataPoints - 20; // Показываем по 20 точек за раз
        slider.value = Math.max(0, dataPoints - 20); // Начинаем с конца
        scrollGraph(slider.value);
    } else if (scrollContainer) {
        scrollContainer.style.display = 'none';
    }
}

// Прокручивает график
function scrollGraph(sliderValue) {
    if (!portfolioChart || !currentPortfolioName) return;
    
    const savedPortfolios = JSON.parse(localStorage.getItem('savedPortfolios') || '{}');
    const portfolio = savedPortfolios[currentPortfolioName];
    
    if (!portfolio) return;
    
    const filteredHistory = filterHistoryByTimeRange(portfolio.history, currentTimeRange);
    if (!filteredHistory || filteredHistory.length === 0) return;
    
    const startIndex = parseInt(sliderValue);
    const visiblePoints = 20; // Показываем 20 точек за раз
    const endIndex = Math.min(startIndex + visiblePoints, filteredHistory.length);
    
    const visibleHistory = filteredHistory.slice(startIndex, endIndex);
    if (visibleHistory.length === 0) return;
    
    const labels = visibleHistory.map(h => h.dateLabel);
    const values = visibleHistory.map(h => h.value);
    
    // Обновляем график
    portfolioChart.data.labels = labels;
    portfolioChart.data.datasets[0].data = values;
    portfolioChart.update('none'); // Обновляем без анимации
    
    // Обновляем метки ползунка
    const scrollStart = document.getElementById('scrollStart');
    const scrollEnd = document.getElementById('scrollEnd');
    if (scrollStart && scrollEnd && visibleHistory.length > 0) {
        scrollStart.textContent = visibleHistory[0].dateLabel;
        scrollEnd.textContent = visibleHistory[visibleHistory.length - 1].dateLabel;
    }
}

function displayLeaderboard() {
    const leaderboard = JSON.parse(localStorage.getItem('leaderboard') || '[]');
    const leaderboardContent = document.getElementById('leaderboardContent');
    
    if (!leaderboardContent) return;
    
    if (leaderboard.length === 0) {
        leaderboardContent.innerHTML = '<p style="color: #cccccc; text-align: center; padding: 20px;">No portfolios saved yet. Create your portfolio and save it to see your ranking!</p>';
        return;
    }

    leaderboardContent.innerHTML = leaderboard.map((item, index) => {
        const isProfit = parseFloat(item.profitLoss || 0) >= 0;
        const profitLossColor = isProfit ? '#51cf66' : '#ff6b6b';
        const profitLossSign = isProfit ? '+' : '';
        
        // Формируем список монет
        const coinsList = item.portfolioComposition && item.portfolioComposition.length > 0
            ? item.portfolioComposition.map(c => `${c.symbol} (${c.percentage}%)`).join(', ')
            : 'No coins selected';
        
        return `
            <div class="leaderboard-item" style="
                background: rgba(0, 0, 0, 0.5);
                padding: 15px;
                border-radius: 8px;
                margin-bottom: 12px;
                border-left: 4px solid ${index === 0 ? '#ffd700' : index === 1 ? '#c0c0c0' : index === 2 ? '#cd7f32' : 'rgba(255, 0, 0, 0.5)'};
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="
                            font-size: 1.3em;
                            font-weight: bold;
                            color: ${index === 0 ? '#ffd700' : index === 1 ? '#c0c0c0' : index === 2 ? '#cd7f32' : '#ffffff'};
                            min-width: 30px;
                        ">#${index + 1}</span>
                        <span style="color: #ffffff; font-weight: bold; font-size: 1.1em;">${item.username}</span>
        </div>
                    <div style="text-align: right;">
                        <div style="color: #ffffff; font-size: 1.2em; font-weight: bold;">
                            $${parseFloat(item.currentValue || item.score || 0).toFixed(2)}
                        </div>
                        <div style="color: ${profitLossColor}; font-size: 0.9em; font-weight: bold;">
                            ${profitLossSign}$${parseFloat(item.profitLoss || 0).toFixed(2)} 
                            (${profitLossSign}${parseFloat(item.profitLossPercent || 0).toFixed(2)}%)
                        </div>
                    </div>
                </div>
                <div style="
                    margin-top: 10px;
                    padding-top: 10px;
                    border-top: 1px solid rgba(255, 255, 255, 0.1);
                    font-size: 0.9em;
                    color: #cccccc;
                ">
                    <div style="margin-bottom: 5px;">
                        <strong style="color: #ffaaaa;">Initial Deposit:</strong> 
                        <span style="color: #ffffff;">$${parseFloat(item.initialDeposit || item.score || 0).toFixed(2)}</span>
                    </div>
                    <div style="margin-bottom: 5px;">
                        <strong style="color: #ffaaaa;">Portfolio:</strong> 
                        <span style="color: #ffffff;">${coinsList}</span>
                    </div>
                    <div style="color: #999999; font-size: 0.85em;">
                        📅 ${item.date || 'Unknown date'}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function checkPaymentStatus() {
    const paymentStatus = localStorage.getItem('moduleBPayment');
    const indicator = document.getElementById('paymentStatus');
    
    if (paymentStatus === 'paid' && indicator) {
        indicator.style.display = 'inline-block';
    }
}

// Fetch real-time price for Module C
async function getRealTimePrice(coinSymbol) {
    try {
        const response = await fetch(`${LIVECOINWATCH_URL}/${coinSymbol}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': LIVECOINWATCH_KEY
            },
            body: JSON.stringify({
                currency: 'USD',
                meta: true
            })
        });
        
        const data = await response.json();
        return data.rate || null;
    } catch (e) {
        console.log(`Could not fetch price for ${coinSymbol}`);
        return null;
    }
}

function updatePriceChangeDisplay() {
    const value = document.getElementById('priceChange')?.value || 0;
    const priceChangeValue = document.getElementById('priceChangeValue');
    if (priceChangeValue) priceChangeValue.textContent = value + '%';
}

// Load AI Scenario
async function loadAIScenario(type) {
    const scenarios = {
        'bearish': { name: 'CRASH -50% (Hardcore)', description: 'CRASH -50% - PANIC MODE', priceChange: -50 },
        'altcrash': { name: 'BULLRUN +150%', description: 'BULLRUN +150% - MAXIMIZATION', priceChange: 150 },
        'regulatory': { name: 'REGULATORY SHOCK -35%', description: 'REGULATORY SHOCK -35% - READY?', priceChange: -35 }
    };

    const scenario = scenarios[type];
    const experimentName = document.getElementById('experimentName');
    const priceChange = document.getElementById('priceChange');
    
    if (experimentName) experimentName.value = scenario.name;
    if (priceChange) {
        priceChange.value = scenario.priceChange;
        updatePriceChangeDisplay();
        updateCorrelations();
    }

    const coin = document.getElementById('experimentCoin')?.value || 'BTC';
    const currentPrice = await getRealTimePrice(coin) || 50000;
    
    const detailedScenario = await generateDetailedScenario(type, currentPrice, coin);
    const experimentScenario = document.getElementById('experimentScenario');
    if (experimentScenario) experimentScenario.value = detailedScenario;
}

async function generateDetailedScenario(type, currentPrice, coinSymbol) {
    const scenarios = {
        'bearish': { trigger: -50, prompt: `Generate CRASH -50% SCENARIO for ${coinSymbol} (current price: $${currentPrice.toFixed(2)}). Create a DETAILED survival strategy with NUMBERS.` },
        'altcrash': { trigger: 150, prompt: `Generate BULLRUN +150% SCENARIO for ${coinSymbol} (current price: $${currentPrice.toFixed(2)}). Create a DETAILED profit maximization strategy.` },
        'regulatory': { trigger: -35, prompt: `Generate REGULATORY SHOCK -35% for ${coinSymbol} (current price: $${currentPrice.toFixed(2)}). Create a strategy for protection from regulatory risk.` }
    };

    const scenario = scenarios[type];
    
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: 'mistral-small',
                messages: [
                    { role: 'system', content: 'You are a professional trader-analyst. Create detailed trading strategies with specific figures, percentages, and statistics.' },
                    { role: 'user', content: scenario.prompt }
                ],
                temperature: 0.8,
                max_tokens: 500
            })
        });

        const data = await response.json();
        
        if (data.choices && data.choices[0]) {
            return data.choices[0].message.content.trim();
        }
    } catch (error) {
        console.error('AI Error:', error);
    }

    return scenario.description;
}

// Smart Correlations
function updateCorrelations() {
    const enabled = document.getElementById('correlationsEnabled')?.checked || false;
    const coin = document.getElementById('experimentCoin')?.value || 'BTC';
    const priceChange = parseInt(document.getElementById('priceChange')?.value || 0);
    const suggestionsDiv = document.getElementById('correlationsSuggestions');

    if (!suggestionsDiv) return;

    if (!enabled || priceChange === 0) {
        suggestionsDiv.innerHTML = '';
        return;
    }

    const correlations = {
        'BTC': { 'ETH': -1.4, 'SOL': -2.25, 'BNB': -1.65, 'ADA': -1.2, 'XRP': -1.1, 'AVAX': -1.8, 'DOGE': -1.3, 'SUI': -2.0, 'TON': -1.5 },
        'ETH': { 'BTC': -0.7, 'SOL': -1.6, 'BNB': -1.2, 'ADA': -1.1, 'AVAX': -1.4, 'ARB': -1.8, 'UNI': -1.6 },
        'SOL': { 'BTC': -0.44, 'ETH': -0.625, 'BNB': -0.75, 'SUI': -1.5, 'WIF': -2.2, 'PEPE': -1.8 }
    };

    const coinCorrelations = correlations[coin] || {};
    const suggestions = Object.entries(coinCorrelations).map(([asset, multiplier]) => {
        const suggestedChange = Math.round(priceChange * multiplier);
        return `${asset}: ${suggestedChange}%`;
    }).join(' | ');

    suggestionsDiv.innerHTML = `
        <strong style="color: #00ff00;">💡 AI suggests correlations:</strong><br>
        ${suggestions}<br>
        <small style="color: #888;">Based on historical data</small>
    `;
}

function shareExperiment() {
    const name = document.getElementById('experimentName')?.value || '';
    const coin = document.getElementById('experimentCoin')?.value || '';
    const priceChange = document.getElementById('priceChange')?.value || 0;
    
    const shareText = `🧪 Experiment: ${name}\n📊 Coin: ${coin}\n📈 Change: ${priceChange}%\n🔗 Coach Crypto Experiment`;

    if (navigator.share) {
        navigator.share({ text: shareText });
    } else {
        navigator.clipboard.writeText(shareText);
        alert('Text copied to clipboard!');
    }
}

function createBotStrategy() {
    alert('🤖 "Create Bot" feature will be added in the next update!\n\nThis will allow you to export the strategy for automatic trading.');
}

async function generateStrategyFromText() {
    const text = document.getElementById('strategyText')?.value;
    const resultDiv = document.getElementById('generatedStrategyResult');

    if (!resultDiv) return;

    if (!text || !text.trim()) {
        alert('Please describe your strategy');
        return;
    }

    resultDiv.innerHTML = '<em style="color: #ff6666;">🤖 AI analyzing your text...</em>';

    try {
        const coin = document.getElementById('experimentCoin')?.value || 'BTC';
        const deposit = parseFloat(document.getElementById('userDeposit')?.value || 10000);
        const currentPrice = await getRealTimePrice(coin) || 50000;

        const prompt = `The user described a trading/investment strategy for ${deposit}$: "${text}". Current price of ${coin}: $${currentPrice.toFixed(2)}. Create a DETAILED professional strategy with specific percentages, price levels, and actions.`;

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: 'mistral-small',
                messages: [
                    { role: 'system', content: 'You are a professional crypto trader with 10+ years of experience. Your strategies are always detailed, with specific figures and calculations.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.9,
                max_tokens: 600
            })
        });

        const data = await response.json();
        
        if (data.choices && data.choices[0]) {
            resultDiv.innerHTML = `
                <div style="background: rgba(0, 0, 0, 0.7); padding: 20px; border-radius: 8px; color: #00ff00; border: 1px solid rgba(0, 255, 0, 0.3); font-size: 0.95rem; line-height: 1.6;">
                    <strong style="color: #00ff00; font-size: 1.1rem;">✅ Strategy generated:</strong><br>
                    <div style="margin-top: 15px; white-space: pre-wrap;">${data.choices[0].message.content.trim()}</div>
                </div>
            `;
        }
    } catch (error) {
        console.error('AI Error:', error);
        resultDiv.innerHTML = '<em style="color: #ff6666;">Error connecting to AI. Please try again.</em>';
    }
}

// Survival Mode - Simplified version
let survivalTimer = 60;
let survivalInterval = null;
let survivalScore = 0;
let survivalLives = 3;
let currentRound = 0;

function startSurvivalMode() {
    const survivalBox = document.getElementById('survivalModeBox');
    if (survivalBox) survivalBox.style.display = 'block';
    
    survivalTimer = 60;
    survivalScore = 0;
    survivalLives = 3;
    currentRound = 0;

    const timerDiv = document.getElementById('survivalTimer');
    const eventDiv = document.getElementById('survivalEvent');
    const resultDiv = document.getElementById('survivalResult');
    const actionsDiv = document.getElementById('survivalActions');

    if (eventDiv) {
        eventDiv.innerHTML = `
            <div style="background: rgba(255, 0, 0, 0.2); padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                <h4 style="color: #ff0000; margin-bottom: 10px;">🔥 CRYPTO SURVIVAL MODE</h4>
                <p><strong>Portfolio:</strong> $10,000.00 | BTC 60%, ETH 30%, SOL 10%</p>
            </div>
        `;
    }

    if (resultDiv) resultDiv.innerHTML = '';
    
    if (survivalInterval) clearInterval(survivalInterval);
    
    survivalInterval = setInterval(() => {
        survivalTimer--;
        if (timerDiv) timerDiv.textContent = survivalTimer + ' sec';

        if (survivalLives <= 0 || survivalTimer <= 0) {
            clearInterval(survivalInterval);
            if (resultDiv) {
                resultDiv.innerHTML = `
                    <div class="result-box">
                        <h5 style="color: #ff0000;">💀 GAME OVER</h5>
                        <p><strong>🎯 Final score:</strong> ${survivalScore} points</p>
                        <p><strong>❤️ Lives remaining:</strong> ${survivalLives}/3</p>
                    </div>
                `;
            }
        }
    }, 1000);
}

function survivalAction(action) {
    if (survivalTimer <= 0 || survivalLives <= 0) return;
    
    survivalScore += 50;
    currentRound++;
    
    alert(`✅ Action taken! +50 points`);
}

async function runExperiment() {
    const name = document.getElementById('experimentName')?.value;
    const coin = document.getElementById('experimentCoin')?.value;
    const scenario = document.getElementById('experimentScenario')?.value;
    const priceChange = document.getElementById('priceChange')?.value;

    if (!name || !scenario) {
        alert('Please fill in the experiment name and scenario description');
        return;
    }

    const resultsDiv = document.getElementById('experimentResults');
    const analysisDiv = document.getElementById('experimentAnalysis');
    const chartDiv = document.getElementById('experimentChart');

    if (resultsDiv) resultsDiv.style.display = 'block';
    if (analysisDiv) analysisDiv.innerHTML = '<em style="color: #ff6666;">🔄 Getting current coin price...</em>';

    const currentPrice = await getRealTimePrice(coin);
    const displayPrice = currentPrice || 50000;
    
    const newPrice = displayPrice * (1 + priceChange / 100);
    const userDeposit = parseFloat(document.getElementById('userDeposit')?.value || 10000);
    const portfolioLoss = Math.abs(priceChange > 0 ? 0 : priceChange * 0.01 * userDeposit);

    if (analysisDiv) {
        analysisDiv.innerHTML = `
            <h5 style="color: #ff0000; margin-bottom: 10px;">${name}</h5>
            <p><strong>Coin:</strong> ${coin}</p>
            <p><strong>Current price:</strong> <span style="color: #00ff00;">$${displayPrice.toFixed(6)}</span></p>
            <p><strong>Price change:</strong> <span style="color: ${priceChange >= 0 ? '#00ff00' : '#ff6666'}">${priceChange}%</span></p>
            <p><strong>Projected price:</strong> $${newPrice.toFixed(6)}</p>
            ${priceChange < 0 ? `<p><strong>Loss:</strong> <span style="color: #ff6666;">-$${portfolioLoss.toFixed(2)}</span></p>` : ''}
        `;
    }

    const aiAdviceDiv = document.getElementById('aiAdviceBox');
    if (aiAdviceDiv) {
        aiAdviceDiv.innerHTML = `
            <h5 style="color: #ffa500; margin-bottom: 10px;">🤖 AI advice:</h5>
            <p>${priceChange < -15 ? 'Consider selling 25% to protect capital.' : priceChange < 0 ? 'Small correction. Stick to your strategy.' : 'Positive scenario. Consider taking partial profit.'}</p>
        `;
    }

    if (chartDiv) {
        chartDiv.innerHTML = `
            <div style="text-align: center; width: 100%;">
                <p style="color: #ff6666; font-size: 1.2rem;">Price movement simulation</p>
                <div style="margin-top: 20px; color: ${priceChange >= 0 ? '#00ff00' : '#ff6666'}; font-size: 2rem;">
                    ${priceChange >= 0 ? '↗' : '↘'} ${Math.abs(priceChange)}%
                </div>
            </div>
        `;
    }
}

function saveExperiment() {
    const name = document.getElementById('experimentName')?.value;
    const coin = document.getElementById('experimentCoin')?.value;
    const priceChange = document.getElementById('priceChange')?.value;

    if (!name) {
        alert('Please run an experiment first');
        return;
    }

    const experiments = JSON.parse(localStorage.getItem('experiments') || '[]');
    experiments.push({
        name,
        coin,
        priceChange,
        date: new Date().toLocaleString()
    });
    localStorage.setItem('experiments', JSON.stringify(experiments));

    loadExperimentArchive();
    alert('Experiment saved to archive!');
}

function loadExperimentArchive() {
    const experiments = JSON.parse(localStorage.getItem('experiments') || '[]');
    const archiveDiv = document.getElementById('experimentArchive');

    if (!archiveDiv) return;

    if (experiments.length === 0) {
        archiveDiv.innerHTML = '<p style="color: #888; text-align: center;">No saved experiments yet</p>';
        return;
    }

    archiveDiv.innerHTML = experiments.map((exp, index) => `
        <div class="experiment-item" onclick="loadExperiment(${index})">
            <strong style="color: #ff0000;">${exp.name}</strong><br>
            <small style="color: #888;">${exp.coin} - ${exp.priceChange}% | ${exp.date}</small>
        </div>
    `).join('');
}

function loadExperiment(index) {
    const experiments = JSON.parse(localStorage.getItem('experiments') || '[]');
    if (experiments[index]) {
        const exp = experiments[index];
        const experimentName = document.getElementById('experimentName');
        const experimentCoin = document.getElementById('experimentCoin');
        const priceChange = document.getElementById('priceChange');
        
        if (experimentName) experimentName.value = exp.name;
        if (experimentCoin) experimentCoin.value = exp.coin;
        if (priceChange) {
            priceChange.value = exp.priceChange;
            updatePriceChangeDisplay();
            updateCorrelations();
        }
        runExperiment();
    }
}

// Module D: Strategy Constructor
function updateRiskAppetiteDisplay() {
    const value = document.getElementById('riskAppetite')?.value || 50;
    const riskAppetiteValue = document.getElementById('riskAppetiteValue');
    if (riskAppetiteValue) riskAppetiteValue.textContent = value + '%';
}

function generateStrategies() {
    const assets = Array.from(document.getElementById('preferredAssets')?.selectedOptions || []).map(o => o.value);
    const timeHorizon = document.getElementById('timeHorizon')?.value || 'months';
    const risk = parseInt(document.getElementById('riskAppetite')?.value || 50);

    if (assets.length === 0) {
        alert('Please select at least one preferred asset');
        return;
    }

    const resultDiv = document.getElementById('strategiesResult');
    const strategiesList = document.getElementById('strategiesList');
    
    if (resultDiv) resultDiv.style.display = 'block';
    if (!strategiesList) return;

    const strategies = [
        {
            name: 'Conservative Strategy',
            description: 'Low risk, stable growth',
            distribution: generateDistribution(assets, 'conservative'),
            steps: ['Dollar cost averaging', 'Focus on blue chips', 'Set stop-loss at 5%', 'Rebalance monthly']
        },
        {
            name: 'Balanced Strategy',
            description: 'Moderate risk, balanced growth',
            distribution: generateDistribution(assets, 'balanced'),
            steps: ['Mix of large and mid-cap coins', '40% core assets, 60% growth', 'Set stop-loss at 7%', 'Rebalance bi-weekly']
        },
        {
            name: 'Aggressive Strategy',
            description: 'High risk, high profit potential',
            distribution: generateDistribution(assets, 'aggressive'),
            steps: ['Higher allocation to altcoins', '20% core, 80% growth', 'Set stop-loss at 10%', 'Rebalance weekly']
        }
    ];

    strategiesList.innerHTML = strategies.map((strategy, idx) => `
        <div class="strategy-card">
            <h5>Strategy ${idx + 1}: ${strategy.name}</h5>
            <p style="color: #888; margin-bottom: 10px;">${strategy.description}</p>
            <p style="margin-bottom: 10px;"><strong>Distribution:</strong></p>
            <ul style="margin-left: 20px; margin-bottom: 10px;">
                ${strategy.distribution.map(d => `<li>${d.asset}: ${d.percent}%</li>`).join('')}
            </ul>
            <p style="margin-bottom: 5px;"><strong>Execution Steps:</strong></p>
            <ol style="margin-left: 20px;">
                ${strategy.steps.map(s => `<li>${s}</li>`).join('')}
            </ol>
        </div>
    `).join('');
}

function generateDistribution(assets, type) {
    const percentages = {
        'conservative': [60, 40],
        'balanced': [40, 35, 25],
        'aggressive': [30, 25, 20, 15, 10]
    };

    const percents = percentages[type] || percentages.balanced;
    return assets.slice(0, percents.length).map((asset, idx) => ({
        asset,
        percent: percents[idx] || (100 / assets.length)
    }));
}

function testStressScenario() {
    const risk = parseInt(document.getElementById('riskAppetite')?.value || 50);
    const resultDiv = document.getElementById('stressTestResult');
    
    if (!resultDiv) return;
    
    resultDiv.style.display = 'block';

    const crashPercent = 40;
    const portfolioImpact = risk > 70 ? crashPercent * 0.8 : risk > 40 ? crashPercent * 0.6 : crashPercent * 0.4;

    resultDiv.innerHTML = `
        <h5 style="color: #ff0000; margin-bottom: 10px;">🏴 Strategy Stress Test Results</h5>
        <p><strong>Market crash simulation:</strong> Market drop of ${crashPercent}%</p>
        <p><strong>Impact on your portfolio:</strong> <span style="color: #ff6666;">-${portfolioImpact.toFixed(1)}%</span></p>
        <p><strong>Strategy resilience:</strong> ${portfolioImpact < 25 ? '✅ Excellent' : portfolioImpact < 35 ? '⚠️ Moderate' : '❌ High risk'}</p>
    `;
}

// Update portfolio value from input
function updatePortfolioValue() {
    const portfolioInput = document.getElementById('portfolioInput');
    const portfolioValueDisplay = document.getElementById('portfolioValue');
    
    if (portfolioInput && portfolioValueDisplay) {
        portfolioInput.addEventListener('input', function() {
            const value = parseFloat(this.value) || 0;
            portfolioValue = value;
            portfolioValueDisplay.textContent = '$' + value.toLocaleString('en-US', { 
                minimumFractionDigits: 2, 
                maximumFractionDigits: 2 
            });
            
            // Recalculate profit/loss if coins are selected
            if (Object.keys(selectedCoins).length > 0) {
                updateSelectedCoinsList();
            }
        });
        
        // Initial update
        const initialValue = parseFloat(portfolioInput.value) || 10000;
        portfolioValue = initialValue;
        portfolioValueDisplay.textContent = '$' + initialValue.toLocaleString('en-US', { 
            minimumFractionDigits: 2, 
            maximumFractionDigits: 2 
        });
    }
}

// Initialize on load
// ========== NEW FEATURES FOR FREE BLOCK ==========

// 1. Live Market Heatmap
let heatmapCharts = {};
async function initMarketHeatmap() {
    const heatmapContainer = document.getElementById('marketHeatmap');
    if (!heatmapContainer) return;
    
    // Clear container first
    heatmapContainer.innerHTML = '';
    
    // Remove duplicates from availableCoins and get unique coins
    const uniqueCoins = [...new Set(availableCoins)];
    
    // Show top 30 unique coins for heatmap
    const topCoins = uniqueCoins.slice(0, 30);
    
    // Track processed coins to avoid duplicates
    const processedCoins = new Set();
    
    for (const coin of topCoins) {
        // Skip if already processed
        if (processedCoins.has(coin)) continue;
        processedCoins.add(coin);
        
        try {
            const response = await fetch(LIVECOINWATCH_URL, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': LIVECOINWATCH_KEY
                },
                body: JSON.stringify({ code: coin, currency: 'USD', meta: true })
            });
            
            if (response.ok) {
                const data = await response.json();
                const change24h = data.delta?.day || 0;
                
                // Green for positive/zero, red for negative
                const isPositive = change24h >= 0;
                const bgColor = isPositive ? 'rgba(0, 255, 0, 0.25)' : 'rgba(255, 0, 0, 0.25)';
                const borderColor = isPositive ? 'rgba(0, 255, 0, 0.7)' : 'rgba(255, 0, 0, 0.7)';
                const textColor = isPositive ? '#00ff00' : '#ff0000';
                
                const coinElement = document.createElement('div');
                coinElement.style.cssText = `
                    background: ${bgColor};
                    border: 2px solid ${borderColor};
                    border-radius: 10px;
                    padding: 15px;
                    text-align: center;
                    cursor: pointer;
                    transition: all 0.3s ease;
                    min-width: 110px;
                    min-height: 80px;
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    align-items: center;
                `;
                coinElement.innerHTML = `
                    <div style="color: #ffffff; font-weight: bold; font-size: 1rem; margin-bottom: 8px;">${coin}</div>
                    <div style="color: ${textColor}; font-size: 0.95rem; font-weight: bold;">
                        ${isPositive ? '+' : ''}${change24h.toFixed(2)}%
                    </div>
                `;
                coinElement.onclick = () => {
                    // Add coin to portfolio if not already selected
                    if (!selectedCoins[coin]) {
                        setCoinPercentage(coin, 10);
                        updateSelectedCoins();
                    }
                };
                coinElement.onmouseenter = () => {
                    coinElement.style.transform = 'scale(1.1)';
                    coinElement.style.boxShadow = '0 0 20px rgba(255, 215, 0, 0.6)';
                    coinElement.style.zIndex = '10';
                };
                coinElement.onmouseleave = () => {
                    coinElement.style.transform = 'scale(1)';
                    coinElement.style.boxShadow = 'none';
                    coinElement.style.zIndex = '1';
                };
                
                heatmapContainer.appendChild(coinElement);
            }
        } catch (error) {
            console.error(`Error fetching ${coin}:`, error);
        }
    }
}

// 2. Portfolio Health Score
function calculatePortfolioHealth() {
    const healthScoreValue = document.getElementById('healthScoreValue');
    const healthScoreLabel = document.getElementById('healthScoreLabel');
    const diversificationScore = document.getElementById('diversificationScore');
    const balanceScore = document.getElementById('balanceScore');
    const riskScore = document.getElementById('riskScore');
    
    if (!healthScoreValue) return;
    
    const coinCount = Object.keys(selectedCoins).filter(c => selectedCoins[c].percentage > 0).length;
    const totalPercent = Object.values(selectedCoins).reduce((sum, coin) => sum + (coin.percentage || 0), 0);
    
    // Diversification Score (0-100): More coins = better
    const diversification = Math.min(coinCount * 10, 100);
    
    // Balance Score (0-100): How close to 100% total
    const balance = Math.max(0, 100 - Math.abs(100 - totalPercent) * 2);
    
    // Risk Score: Based on coin types (BTC/ETH = lower risk, altcoins = higher risk)
    let riskLevel = 0;
    const lowRiskCoins = ['BTC', 'ETH', 'BNB', 'USDT', 'USDC'];
    const selectedCoinSymbols = Object.keys(selectedCoins).filter(c => selectedCoins[c].percentage > 0);
    const lowRiskCount = selectedCoinSymbols.filter(c => lowRiskCoins.includes(c)).length;
    const riskRatio = lowRiskCount / Math.max(coinCount, 1);
    riskLevel = Math.round((1 - riskRatio) * 100); // Higher = more risky
    
    // Overall Health Score (average of all metrics)
    const overallScore = Math.round((diversification * 0.4 + balance * 0.3 + (100 - riskLevel) * 0.3));
    
    // Update UI
    healthScoreValue.textContent = overallScore;
    diversificationScore.textContent = `${diversification}%`;
    balanceScore.textContent = `${balance}%`;
    riskScore.textContent = riskLevel < 30 ? 'Low' : riskLevel < 70 ? 'Medium' : 'High';
    
    // Score label
    let label = '';
    let color = '#ff0000';
    if (overallScore >= 80) {
        label = 'Excellent';
        color = '#00ff00';
    } else if (overallScore >= 60) {
        label = 'Good';
        color = '#ffd700';
    } else if (overallScore >= 40) {
        label = 'Fair';
        color = '#ffaa00';
    } else {
        label = 'Needs Improvement';
        color = '#ff6666';
    }
    
    healthScoreLabel.textContent = label;
    healthScoreLabel.style.color = color;
    healthScoreValue.style.color = color;
}

// 3. Multi-Timeframe View
let timeframeCharts = {};
function initMultiTimeframeView() {
    const timeframes = ['1h', '4h', '1d', '1w'];
    const canvasIds = ['timeframe1h', 'timeframe4h', 'timeframe1d', 'timeframe1w'];
    
    timeframes.forEach((tf, index) => {
        const canvas = document.getElementById(canvasIds[index]);
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        canvas.width = canvas.offsetWidth;
        canvas.height = 120;
        
        // Simple line chart for each timeframe
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#ffd700';
        ctx.lineWidth = 2;
        ctx.beginPath();
        
        // Generate sample data (in real app, fetch historical data)
        const points = 20;
        for (let i = 0; i < points; i++) {
            const x = (i / (points - 1)) * canvas.width;
            const y = canvas.height / 2 + Math.sin(i * 0.5) * 30;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    });
}

// 4. Portfolio Share Card
let shareCardGenerated = false;
function generateShareCard() {
    const shareCardPreview = document.getElementById('shareCardPreview');
    const downloadBtn = document.getElementById('downloadShareBtn');
    const shareSocialBtn = document.getElementById('shareSocialBtn');
    
    if (!shareCardPreview) return;
    
    const coinCount = Object.keys(selectedCoins).filter(c => selectedCoins[c].percentage > 0).length;
    const totalValue = portfolioValue;
    const profitLoss = document.getElementById('profitLossValue')?.textContent || '+$0.00';
    
    shareCardPreview.innerHTML = `
        <div style="color: #ffd700; font-size: 1.5rem; font-weight: bold; margin-bottom: 15px;">My Crypto Portfolio</div>
        <div style="color: #ffffff; font-size: 2rem; font-weight: bold; margin-bottom: 10px;">$${totalValue.toLocaleString()}</div>
        <div style="color: ${profitLoss.includes('+') ? '#00ff00' : '#ff0000'}; font-size: 1.2rem; margin-bottom: 20px;">${profitLoss}</div>
        <div style="color: #cccccc; font-size: 1rem;">${coinCount} coins selected</div>
        <div style="margin-top: 15px; font-size: 0.9rem; color: #ffd700;">Generated on ${new Date().toLocaleDateString()}</div>
    `;
    
    shareCardGenerated = true;
    if (downloadBtn) downloadBtn.style.display = 'inline-block';
    if (shareSocialBtn) shareSocialBtn.style.display = 'inline-block';
}

function downloadShareCard() {
    const shareCardPreview = document.getElementById('shareCardPreview');
    if (!shareCardPreview || !shareCardGenerated) return;
    
    // Create canvas for image
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');
    
    // Draw background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw border
    ctx.strokeStyle = '#ffd700';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, canvas.width, canvas.height);
    
    // Draw text
    ctx.fillStyle = '#ffd700';
    ctx.font = 'bold 48px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('My Crypto Portfolio', canvas.width / 2, 150);
    
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 64px Arial';
    ctx.fillText(`$${portfolioValue.toLocaleString()}`, canvas.width / 2, 250);
    
    // Download
    canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'portfolio-share-card.png';
        a.click();
        URL.revokeObjectURL(url);
    });
}

function shareToSocial() {
    const shareCardPreview = document.getElementById('shareCardPreview');
    if (!shareCardPreview || !shareCardGenerated) return;
    
    // Generate share text
    const coinCount = Object.keys(selectedCoins).filter(c => selectedCoins[c].percentage > 0).length;
    const shareText = `Check out my crypto portfolio! $${portfolioValue.toLocaleString()} with ${coinCount} coins! 🚀`;
    const shareUrl = window.location.href;
    
    // Try Web Share API
    if (navigator.share) {
        navigator.share({
            title: 'My Crypto Portfolio',
            text: shareText,
            url: shareUrl
        }).catch(err => console.log('Share cancelled'));
    } else {
        // Fallback: copy to clipboard
        navigator.clipboard.writeText(`${shareText} ${shareUrl}`).then(() => {
            alert('Portfolio link copied to clipboard!');
        });
    }
}

// Initialize new features when drawer opens
function initNewFeatures() {
    setTimeout(() => {
        initMarketHeatmap();
        calculatePortfolioHealth();
        initMultiTimeframeView();
    }, 500);
}

// Note: calculatePortfolioHealth will be called from updateSelectedCoins and other places

document.addEventListener('DOMContentLoaded', function() {
    updatePortfolioValue();
    setTimeout(() => {
        updateRiskDisplay();
        updatePortfolioSelector();
        checkPaymentStatus();
        updatePriceChangeDisplay();
        updateRiskAppetiteDisplay();
        loadExperimentArchive();
    }, 500);
});
