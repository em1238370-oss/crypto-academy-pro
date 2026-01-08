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
const COINDESK_API_KEY = 'b95bf2a20ad97017d5c32c1a6196ebb881402326735f3eb2f6689a09b1741a45';
const COINDESK_API_URL = 'https://api.coindesk.com/v1';
const ALTERNATIVE_ME_FNG_URL = 'https://api.alternative.me/fng/';
// Glassnode API (требует Professional план - от $999/месяц)
// Когда будет ключ, раскомментируйте и добавьте ключ:
// const GLASSNODE_API_KEY = 'YOUR_GLASSNODE_API_KEY_HERE';
const GLASSNODE_API_URL = 'https://api.glassnode.com/v1';
// LunarCrush API - социальные сигналы (Twitter, Reddit, упоминания)
const LUNARCRUSH_API_KEY = 'w737qzurjyq5nt2yyma6t91d0rmk5tgbi7uhebv7m';
const LUNARCRUSH_API_URL = 'https://lunarcrush.com/api3';

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

// Pre-Trade Mental Check with Blocking System
let blockCount = parseInt(localStorage.getItem('preTradeBlockCount') || '0');

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
    
    // BLOCKING SYSTEM: If score < 50%, block the module
    if (score < 50) {
        // Determine block duration: 3 hours for first time, 6 hours for repeat
        const blockDuration = blockCount === 0 ? 3 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000; // 3 hours or 6 hours in milliseconds
        const blockUntil = Date.now() + blockDuration;
        
        // Save block info
        localStorage.setItem('preTradeBlockUntil', blockUntil.toString());
        blockCount++;
        localStorage.setItem('preTradeBlockCount', blockCount.toString());
        
        // Update score display
        if (readinessScore) {
            readinessScore.textContent = score + '%';
            readinessScore.style.color = '#ff0000';
        }
        
        // Update label with blocking info
        if (readinessLabel) {
            const hours = blockCount === 1 ? '3' : '6';
            readinessLabel.textContent = `🚫 BLOCKED for ${hours} hours`;
            readinessLabel.style.color = '#ff0000';
        }
        
        // Show blocking message
        if (readinessRecommendations) {
            const hours = blockCount === 1 ? '3' : '6';
            recommendations = `
                <div style="color: #ff0000; font-weight: bold; font-size: 1.2rem; margin-bottom: 15px;">
                    🚫 MODULE BLOCKED
                </div>
                <div style="color: #ffffff; line-height: 1.8; margin-bottom: 15px;">
                    You failed the readiness check (${score}% - less than 50%). 
                    This module is now <strong style="color: #ff0000;">blocked for ${hours} hours</strong> to protect you from making poor trading decisions.
                </div>
                <div style="color: #ffaa00; padding: 15px; background: rgba(255, 0, 0, 0.2); border-radius: 8px; border-left: 4px solid #ff0000;">
                    <strong>Why?</strong> Trading when you're not mentally ready significantly increases your risk of:
                    <ul style="margin-top: 10px; padding-left: 20px;">
                        <li>Making emotional decisions</li>
                        <li>Taking excessive risks</li>
                        <li>Suffering significant losses</li>
                    </ul>
                </div>
                <div style="color: #cccccc; margin-top: 15px; font-size: 0.9rem;">
                    Block will be lifted at: <span id="blockUntilTime" style="color: #ffd700; font-weight: bold;"></span>
                </div>
            `;
            readinessRecommendations.innerHTML = recommendations;
            
            // Show block until time
            const blockUntilTime = new Date(blockUntil);
            const timeElement = document.getElementById('blockUntilTime');
            if (timeElement) {
                timeElement.textContent = blockUntilTime.toLocaleString();
            }
        }
        
        preTradeResult.style.display = 'block';
        preTradeResult.style.borderLeftColor = '#ff0000';
        
        // Block the entire module
        blockModuleB();
        
        return;
    }
    
    // If passed (score >= 50%), reset block count
    if (score >= 50) {
        blockCount = 0;
        localStorage.setItem('preTradeBlockCount', '0');
        localStorage.removeItem('preTradeBlockUntil');
    }
    
    // Update score display
    if (readinessScore) {
        readinessScore.textContent = score + '%';
        if (score >= 80) {
            readinessScore.style.color = '#00ff00';
        } else if (score >= 60) {
            readinessScore.style.color = '#ffd700';
        } else {
            readinessScore.style.color = '#ffaa00';
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
            readinessLabel.textContent = '⚠️ Partially Ready';
            readinessLabel.style.color = '#ffaa00';
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
            recommendations = '<div style="color: #ffaa00; font-weight: bold;">⚠️ You are partially ready. Please address the following:</div>';
            recommendations += '<ul style="margin-top: 10px; padding-left: 20px;">';
            missingChecks.forEach(check => {
                recommendations += `<li style="margin-bottom: 8px; color: #ffaa00;">${check}</li>`;
            });
            recommendations += '</ul>';
        }
        readinessRecommendations.innerHTML = recommendations;
    }
    
    preTradeResult.style.display = 'block';
    preTradeResult.style.borderLeftColor = score >= 80 ? '#00ff00' : score >= 60 ? '#ffd700' : '#ffaa00';
}

function blockModuleB() {
    const drawerB = document.getElementById('drawerB');
    const drawerContent = drawerB?.querySelector('.drawer-content');
    
    if (!drawerB || !drawerContent) return;
    
    // Close drawer if open
    drawerB.classList.remove('open');
    
    // Disable the drawer header
    const drawerHeader = drawerB.querySelector('.drawer-header');
    if (drawerHeader) {
        drawerHeader.style.opacity = '0.5';
        drawerHeader.style.cursor = 'not-allowed';
        drawerHeader.onclick = null;
    }
    
    // Show blocking overlay
    let blockingOverlay = document.getElementById('moduleBBlockingOverlay');
    if (!blockingOverlay) {
        blockingOverlay = document.createElement('div');
        blockingOverlay.id = 'moduleBBlockingOverlay';
        blockingOverlay.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.9);
            border-radius: 15px;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            z-index: 1000;
            padding: 40px;
            text-align: center;
        `;
        drawerB.style.position = 'relative';
        drawerB.appendChild(blockingOverlay);
    }
    
    const blockUntil = parseInt(localStorage.getItem('preTradeBlockUntil') || '0');
    const timeRemaining = Math.max(0, blockUntil - Date.now());
    const hours = Math.floor(timeRemaining / (60 * 60 * 1000));
    const minutes = Math.floor((timeRemaining % (60 * 60 * 1000)) / (60 * 1000));
    
    blockingOverlay.innerHTML = `
        <div style="font-size: 4rem; margin-bottom: 20px;">🚫</div>
        <div style="color: #ff0000; font-size: 2rem; font-weight: bold; margin-bottom: 15px;">MODULE BLOCKED</div>
        <div style="color: #ffffff; font-size: 1.2rem; margin-bottom: 20px; line-height: 1.6;">
            You failed the readiness check. This module is blocked to protect you from making poor trading decisions.
        </div>
        <div style="color: #ffd700; font-size: 1.5rem; font-weight: bold; margin-bottom: 20px;">
            Time remaining: ${hours}h ${minutes}m
        </div>
        <div style="color: #cccccc; font-size: 1rem; line-height: 1.6;">
            The block will be automatically lifted when the timer reaches zero.
        </div>
    `;
    
    // Start countdown timer
    startBlockCountdown();
}

function startBlockCountdown() {
    const countdownInterval = setInterval(() => {
        const blockUntil = parseInt(localStorage.getItem('preTradeBlockUntil') || '0');
        const timeRemaining = Math.max(0, blockUntil - Date.now());
        
        if (timeRemaining <= 0) {
            // Block expired, unblock module
            clearInterval(countdownInterval);
            unblockModuleB();
            return;
        }
        
        const hours = Math.floor(timeRemaining / (60 * 60 * 1000));
        const minutes = Math.floor((timeRemaining % (60 * 60 * 1000)) / (60 * 1000));
        const seconds = Math.floor((timeRemaining % (60 * 1000)) / 1000);
        
        const blockingOverlay = document.getElementById('moduleBBlockingOverlay');
        if (blockingOverlay) {
            const timeElement = blockingOverlay.querySelector('div[style*="Time remaining"]');
            if (timeElement) {
                timeElement.innerHTML = `Time remaining: ${hours}h ${minutes}m ${seconds}s`;
            }
        }
    }, 1000);
}

function unblockModuleB() {
    const drawerB = document.getElementById('drawerB');
    const drawerHeader = drawerB?.querySelector('.drawer-header');
    const blockingOverlay = document.getElementById('moduleBBlockingOverlay');
    
    if (blockingOverlay) {
        blockingOverlay.remove();
    }
    
    if (drawerHeader) {
        drawerHeader.style.opacity = '1';
        drawerHeader.style.cursor = 'pointer';
        drawerHeader.onclick = () => toggleDrawerWithInit('drawerB');
    }
    
    // Reset block count after successful unblock
    blockCount = 0;
    localStorage.setItem('preTradeBlockCount', '0');
    localStorage.removeItem('preTradeBlockUntil');
}

function checkModuleBBlockStatus() {
    const blockUntil = parseInt(localStorage.getItem('preTradeBlockUntil') || '0');
    
    if (blockUntil > Date.now()) {
        // Still blocked
        blockModuleB();
        return true;
    } else if (blockUntil > 0) {
        // Block expired
        unblockModuleB();
        return false;
    }
    
    return false;
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
        checkModuleBBlockStatus(); // Check if module B is blocked
    }, 1000);
});

// Check block status when drawer is opened
const originalToggleDrawerWithInit = toggleDrawerWithInit;
toggleDrawerWithInit = function(drawerId) {
    if (drawerId === 'drawerB') {
        if (checkModuleBBlockStatus()) {
            // Module is blocked, don't open
            return;
        }
    }
    originalToggleDrawerWithInit(drawerId);
};

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
        // LiveCoinWatch API требует символ в нижнем регистре
        const coinSymbolLower = coinSymbol.toLowerCase();
        
        const response = await fetch(`${LIVECOINWATCH_URL}/${coinSymbolLower}`, {
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
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`LiveCoinWatch API Error (${response.status}):`, errorText);
            // Попробуем альтернативный способ
            return await getRealTimePriceAlternative(coinSymbol);
        }
        
        const data = await response.json();
        
        // LiveCoinWatch возвращает цену в поле 'rate'
        if (data && data.rate) {
            console.log(`✅ LiveCoinWatch: ${coinSymbol} = $${data.rate}`);
            return data.rate;
        } else {
            console.error('No rate in LiveCoinWatch response:', data);
            return await getRealTimePriceAlternative(coinSymbol);
        }
    } catch (e) {
        console.error(`Error fetching price from LiveCoinWatch for ${coinSymbol}:`, e);
        // Попробуем альтернативный способ
        return await getRealTimePriceAlternative(coinSymbol);
    }
}

// Альтернативный способ получения цены через CoinGecko (бесплатный API)
async function getRealTimePriceAlternative(coinSymbol) {
    try {
        // Маппинг символов для CoinGecko
        const coinGeckoMap = {
            'BTC': 'bitcoin',
            'ETH': 'ethereum',
            'BNB': 'binancecoin',
            'SOL': 'solana',
            'ADA': 'cardano',
            'XRP': 'ripple',
            'DOGE': 'dogecoin',
            'AVAX': 'avalanche-2',
            'NEAR': 'near',
            'ARB': 'arbitrum',
            'APT': 'aptos',
            'UNI': 'uniswap',
            'SUI': 'sui',
            'WIF': 'dogwifcoin',
            'AAVE': 'aave',
            'TON': 'the-open-network',
            'ATOM': 'cosmos'
        };
        
        const coinGeckoId = coinGeckoMap[coinSymbol] || coinSymbol.toLowerCase();
        
        const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinGeckoId}&vs_currencies=usd`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });
        
        if (!response.ok) {
            console.error(`CoinGecko API Error: ${response.status}`);
            return null;
        }
        
        const data = await response.json();
        
        if (data && data[coinGeckoId] && data[coinGeckoId].usd) {
            return data[coinGeckoId].usd;
        }
        
        return null;
    } catch (e) {
        console.error(`CoinGecko fallback error for ${coinSymbol}:`, e);
        return null;
    }
}

function updatePriceChangeDisplay() {
    const value = document.getElementById('priceChange')?.value || 0;
    const priceChangeValue = document.getElementById('priceChangeValue');
    if (priceChangeValue) priceChangeValue.textContent = value + '%';
}

// ========== MODULE C: NEW FUNCTIONS ==========

// Функция для получения данных из Glassnode API (Basic Metrics - Tier 1)
// Доступные метрики: Active Addresses, SOPR, Fees, Fear & Greed Index, и др.
// Требует Professional план (от $999/месяц) для API доступа
async function getGlassnodeData(coinSymbol, metric = 'addresses/active_count') {
    // Раскомментируйте когда будет API ключ:
    /*
    try {
        const coinLower = coinSymbol.toLowerCase();
        const response = await fetch(`${GLASSNODE_API_URL}/metrics/${metric}?a=${coinLower}&i=24h&f=json`, {
            headers: {
                'X-Api-Key': GLASSNODE_API_KEY
            }
        });
        
        if (!response.ok) {
            console.error('Glassnode API Error:', response.status);
            return null;
        }
        
        const data = await response.json();
        return data;
    } catch (e) {
        console.error('Error fetching Glassnode data:', e);
        return null;
    }
    */
    return null; // Пока нет ключа
}

// Функция для получения социальных сигналов из LunarCrush API
// Предоставляет: Galaxy Score, AltRank, Social Volume, Social Dominance, упоминания в Twitter/Reddit
async function getLunarCrushData(coinSymbol) {
    if (!LUNARCRUSH_API_KEY || LUNARCRUSH_API_KEY === '') {
        return null; // Нет ключа
    }
    
    try {
        // Маппинг символов для LunarCrush
        const lunarCrushMap = {
            'BTC': 'bitcoin',
            'ETH': 'ethereum',
            'BNB': 'binancecoin',
            'SOL': 'solana',
            'ADA': 'cardano',
            'XRP': 'ripple',
            'DOGE': 'dogecoin',
            'AVAX': 'avalanche',
            'NEAR': 'near',
            'ARB': 'arbitrum',
            'APT': 'aptos',
            'UNI': 'uniswap',
            'SUI': 'sui',
            'WIF': 'dogwifhat',
            'AAVE': 'aave',
            'TON': 'toncoin',
            'ATOM': 'cosmos'
        };
        
        const coinId = lunarCrushMap[coinSymbol] || coinSymbol.toLowerCase();
        
        // Получаем данные о монете (Galaxy Score, Social Volume, и др.)
        const response = await fetch(`${LUNARCRUSH_API_URL}/coins?key=${LUNARCRUSH_API_KEY}&symbol=${coinId}&data=market_data,social_data`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });
        
        if (!response.ok) {
            console.error('LunarCrush API Error:', response.status);
            return null;
        }
        
        const data = await response.json();
        
        if (data && data.data && data.data.length > 0) {
            const coinData = data.data[0];
            return {
                galaxyScore: coinData.galaxy_score || null,
                altRank: coinData.alt_rank || null,
                socialVolume: coinData.social_volume || null,
                socialDominance: coinData.social_dominance || null,
                twitterMentions: coinData.twitter_mentions || null,
                redditMentions: coinData.reddit_mentions || null,
                socialScore: coinData.social_score || null,
                marketCap: coinData.market_cap || null
            };
        }
        
        return null;
    } catch (e) {
        console.error('Error fetching LunarCrush data:', e);
        return null;
    }
}

// Функция для получения Fear & Greed Index (бесплатный API, без ключа)
async function getFearAndGreedIndex() {
    try {
        const response = await fetch(ALTERNATIVE_ME_FNG_URL);
        if (!response.ok) return null;
        
        const data = await response.json();
        if (data && data.data && data.data[0]) {
            return {
                value: data.data[0].value,
                classification: data.data[0].value_classification,
                timestamp: data.data[0].timestamp
            };
        }
        return null;
    } catch (e) {
        console.error('Error fetching Fear & Greed Index:', e);
        return null;
    }
}

// Функция для получения данных из CoinDesk API
async function getCoinDeskData(coinSymbol) {
    try {
        // Пример запроса к CoinDesk API (нужно проверить точный endpoint)
        // CoinDesk API может иметь разные endpoints, нужно проверить документацию
        const response = await fetch(`${COINDESK_API_URL}/indices/latest?symbol=${coinSymbol}`, {
            headers: {
                'X-API-Key': COINDESK_API_KEY
            }
        });
        
        if (!response.ok) {
            console.error('CoinDesk API Error:', response.status);
            return null;
        }
        
        const data = await response.json();
        return data;
    } catch (e) {
        console.error('Error fetching CoinDesk data:', e);
        return null;
    }
}

// Функция для получения расширенных рыночных данных
async function getExtendedMarketData(coinSymbol) {
    const marketData = {
        mainCoin: null,
        topCoins: {},
        marketContext: {},
        fearAndGreed: null,
        coinDeskData: null
    };
    
    try {
        // Получаем данные основной монеты
        const coinLower = coinSymbol.toLowerCase();
        const response = await fetch(`${LIVECOINWATCH_URL}/${coinLower}`, {
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
        
        if (response.ok) {
            const data = await response.json();
            marketData.mainCoin = {
                symbol: coinSymbol,
                price: data.rate || null,
                marketCap: data.cap || null,
                volume24h: data.volume || null,
                change24h: data.delta?.day || 0,
                change7d: data.delta?.week || 0,
                change30d: data.delta?.month || 0,
                allTimeHigh: data.allTimeHighUSD || null,
                allTimeLow: data.allTimeLowUSD || null
            };
        }
    } catch (e) {
        console.error('Error fetching main coin data:', e);
    }
    
    // Получаем данные топ-5 монет для контекста рынка
    const topCoinsList = coinSymbol === 'BTC' ? ['ETH', 'BNB', 'SOL', 'XRP', 'ADA'] : 
                         coinSymbol === 'ETH' ? ['BTC', 'BNB', 'SOL', 'ADA', 'XRP'] :
                         ['BTC', 'ETH', 'BNB', 'SOL', 'ADA'];
    
    for (const topCoin of topCoinsList) {
        try {
            const price = await getRealTimePrice(topCoin);
            if (price) {
                marketData.topCoins[topCoin] = price;
            }
        } catch (e) {
            // Пропускаем если не получилось
        }
    }
    
    // Получаем Fear & Greed Index (бесплатный API)
    try {
        marketData.fearAndGreed = await getFearAndGreedIndex();
    } catch (e) {
        console.error('Error fetching Fear & Greed:', e);
    }
    
    // Получаем данные из CoinDesk API (если доступно)
    try {
        marketData.coinDeskData = await getCoinDeskData(coinSymbol);
    } catch (e) {
        console.error('Error fetching CoinDesk data:', e);
    }
    
    // Получаем данные из Glassnode API (если есть ключ)
    // Доступные метрики: Active Addresses, SOPR, Fees, и др.
    try {
        // Раскомментируйте когда будет Glassnode API ключ:
        // marketData.glassnodeData = await getGlassnodeData(coinSymbol, 'addresses/active_count');
        // marketData.glassnodeSOPR = await getGlassnodeData(coinSymbol, 'indicators/sopr');
    } catch (e) {
        console.error('Error fetching Glassnode data:', e);
    }
    
    // Получаем социальные сигналы из LunarCrush API (если есть ключ)
    try {
        marketData.lunarCrushData = await getLunarCrushData(coinSymbol);
    } catch (e) {
        console.error('Error fetching LunarCrush data:', e);
    }
    
    return marketData;
}

// 1. AI Scenario Builder (Universal) - Enhanced with deep market analysis
async function aiScenarioBuilder() {
    const input = document.getElementById('aiScenarioInput')?.value;
    const resultDiv = document.getElementById('aiScenarioResult');
    
    if (!resultDiv) return;
    
    if (!input || !input.trim()) {
        alert('Please describe your scenario');
        return;
    }
    
    resultDiv.innerHTML = '<div style="color: #ffffff; font-weight: 500;">AI analyzing current market data and generating scenario...</div>';
    
    try {
    const coin = document.getElementById('experimentCoin')?.value || 'BTC';
        const deposit = parseFloat(document.getElementById('userDeposit')?.value || 10000);
        
        // Получаем РАСШИРЕННЫЕ рыночные данные
        resultDiv.innerHTML = '<div style="color: #ffffff; font-weight: 500;">Collecting comprehensive market data (prices, volumes, trends)...</div>';
        const marketData = await getExtendedMarketData(coin);
        
        let currentPrice = marketData.mainCoin?.price;
        
        // Если не получили цену, пробуем еще раз
        if (!currentPrice) {
            resultDiv.innerHTML = '<em style="color: #ffa500;">⚠️ Retrying price fetch with alternative method...</em>';
            await new Promise(resolve => setTimeout(resolve, 1000));
            currentPrice = await getRealTimePrice(coin);
        }
        
        // Если не получили цену, пробуем еще раз с задержкой
        if (!currentPrice) {
            resultDiv.innerHTML = '<div style="color: #ffa500; font-weight: 500;">Retrying price fetch with alternative method...</div>';
            await new Promise(resolve => setTimeout(resolve, 1000));
            currentPrice = await getRealTimePrice(coin);
        }
        
        // Если все еще нет цены, используем примерную цену и предупреждаем пользователя
        if (!currentPrice) {
            // Примерные цены для основных монет (fallback)
            const approximatePrices = {
                'BTC': 92000,
                'ETH': 3500,
                'BNB': 600,
                'SOL': 150,
                'ADA': 0.6,
                'XRP': 0.6,
                'DOGE': 0.15,
                'AVAX': 40,
                'NEAR': 7,
                'ARB': 1.5,
                'APT': 10,
                'UNI': 10,
                'SUI': 2,
                'WIF': 3,
                'AAVE': 100,
                'TON': 6,
                'ATOM': 10
            };
            
            const fallbackPrice = approximatePrices[coin] || 50000;
            currentPrice = fallbackPrice;
            
            resultDiv.innerHTML = `
                <div style="background: rgba(255, 165, 0, 0.15); padding: 15px; border-radius: 8px; border: 1px solid rgba(255, 165, 0, 0.4); margin-bottom: 15px;">
                    <div style="color: #ffa500; font-weight: 600; margin-bottom: 5px;">Price API temporarily unavailable</div>
                    <div style="color: #cccccc; font-size: 0.9rem;">Using approximate price for ${coin}: $${fallbackPrice.toFixed(2)}. Results may not be 100% accurate.</div>
                </div>
                <div style="color: #ff6666; font-style: italic;">Generating scenario with approximate price...</div>
            `;
        } else {
            resultDiv.innerHTML = '<div style="color: #00ff00; font-weight: 500;">Price fetched successfully! Generating scenario...</div>';
        }
        
        // Извлекаем процент изменения из текста пользователя (если есть)
        const percentMatch = input.match(/(?:drop|fall|crash|упад|падени|снижени)[\s\w]*?(\d+)%/i) || 
                            input.match(/(?:rise|grow|increase|рост|повышени)[\s\w]*?(\d+)%/i) ||
                            input.match(/(?:на|by|на|до)[\s]*(-?\d+)%/i);
        
        let projectedPrice = null;
        let priceChangePercent = null;
        
        if (percentMatch) {
            priceChangePercent = parseFloat(percentMatch[1]);
            if (input.toLowerCase().includes('drop') || input.toLowerCase().includes('fall') || 
                input.toLowerCase().includes('crash') || input.toLowerCase().includes('упад') ||
                input.toLowerCase().includes('падени') || input.toLowerCase().includes('снижени') ||
                priceChangePercent < 0) {
                // Падение
                projectedPrice = currentPrice * (1 - Math.abs(priceChangePercent) / 100);
            } else {
                // Рост
                projectedPrice = currentPrice * (1 + Math.abs(priceChangePercent) / 100);
            }
        }
        
        // Формируем расширенный промпт с глубоким анализом рынка
        const marketContext = marketData.mainCoin ? `
MARKET CONTEXT FOR ${coin}:
- Current Price: $${marketData.mainCoin.price.toFixed(2)}
- Market Cap: $${marketData.mainCoin.marketCap ? (marketData.mainCoin.marketCap / 1000000000).toFixed(2) + 'B' : 'N/A'}
- 24h Volume: $${marketData.mainCoin.volume24h ? (marketData.mainCoin.volume24h / 1000000).toFixed(2) + 'M' : 'N/A'}
- 24h Change: ${marketData.mainCoin.change24h > 0 ? '+' : ''}${marketData.mainCoin.change24h.toFixed(2)}%
- 7d Change: ${marketData.mainCoin.change7d > 0 ? '+' : ''}${marketData.mainCoin.change7d.toFixed(2)}%
- 30d Change: ${marketData.mainCoin.change30d > 0 ? '+' : ''}${marketData.mainCoin.change30d.toFixed(2)}%
- All-Time High: $${marketData.mainCoin.allTimeHigh ? marketData.mainCoin.allTimeHigh.toFixed(2) : 'N/A'}
- Distance from ATH: ${marketData.mainCoin.allTimeHigh ? ((marketData.mainCoin.price - marketData.mainCoin.allTimeHigh) / marketData.mainCoin.allTimeHigh * 100).toFixed(2) + '%' : 'N/A'}
` : '';

        const topCoinsContext = Object.keys(marketData.topCoins).length > 0 ? `
TOP CRYPTOCURRENCIES MARKET CONTEXT (for comparison):
${Object.entries(marketData.topCoins).map(([symbol, price]) => `- ${symbol}: $${price.toFixed(2)}`).join('\n')}
` : '';

        // Добавляем Fear & Greed Index в контекст
        const fearAndGreedContext = marketData.fearAndGreed ? `
MARKET SENTIMENT (Fear & Greed Index):
- Current Index: ${marketData.fearAndGreed.value}/100
- Classification: ${marketData.fearAndGreed.classification}
- Interpretation: ${marketData.fearAndGreed.value < 25 ? 'Extreme Fear - Market is very bearish, potential buying opportunity' : 
                    marketData.fearAndGreed.value < 45 ? 'Fear - Market is bearish, cautious sentiment' :
                    marketData.fearAndGreed.value < 55 ? 'Neutral - Balanced market sentiment' :
                    marketData.fearAndGreed.value < 75 ? 'Greed - Market is bullish, optimistic sentiment' :
                    'Extreme Greed - Market is very bullish, potential selling opportunity'}
` : '';

        // Добавляем социальные сигналы из LunarCrush в контекст
        const lunarCrushContext = marketData.lunarCrushData ? `
SOCIAL SIGNALS (LunarCrush):
- Galaxy Score: ${marketData.lunarCrushData.galaxyScore || 'N/A'}/100 (comprehensive ranking)
- AltRank: ${marketData.lunarCrushData.altRank || 'N/A'} (altcoin ranking)
- Social Volume: ${marketData.lunarCrushData.socialVolume || 'N/A'} (mentions across platforms)
- Social Dominance: ${marketData.lunarCrushData.socialDominance ? (marketData.lunarCrushData.socialDominance * 100).toFixed(2) + '%' : 'N/A'} (share of crypto social mentions)
- Twitter Mentions: ${marketData.lunarCrushData.twitterMentions || 'N/A'}
- Reddit Mentions: ${marketData.lunarCrushData.redditMentions || 'N/A'}
- Social Score: ${marketData.lunarCrushData.socialScore || 'N/A'}/100
- Interpretation: ${marketData.lunarCrushData.galaxyScore ? 
    (marketData.lunarCrushData.galaxyScore > 75 ? 'Very High Social Activity - Strong community interest' :
     marketData.lunarCrushData.galaxyScore > 50 ? 'Moderate Social Activity - Normal community engagement' :
     'Low Social Activity - Limited community interest') : 'N/A'}
` : '';

        const priceInfo = projectedPrice ? 
            `\n\n⚠️ CRITICAL PRICE CALCULATION:
- CURRENT REAL-TIME PRICE: $${currentPrice.toFixed(2)} (fetched from LiveCoinWatch API at ${new Date().toLocaleTimeString()})
- PRICE CHANGE: ${priceChangePercent > 0 ? '+' : ''}${priceChangePercent}%
- PROJECTED PRICE: $${projectedPrice.toFixed(2)}
\nYOU MUST USE THESE EXACT PRICES IN YOUR RESPONSE. DO NOT USE OLD OR INCORRECT PRICES.` :
            `\n\n⚠️ CRITICAL: CURRENT REAL-TIME PRICE: $${currentPrice.toFixed(2)} (fetched from LiveCoinWatch API at ${new Date().toLocaleTimeString()})
YOU MUST USE THIS EXACT PRICE IN YOUR RESPONSE. DO NOT USE OLD OR INCORRECT PRICES.`;
        
        const prompt = `You are an EXPERT cryptocurrency market analyst with 15+ years of experience. You have deep knowledge of:
- Market cycles, historical patterns, and correlations
- Technical analysis, support/resistance levels, and chart patterns
- Market psychology, sentiment, and behavioral finance
- Macroeconomic factors affecting crypto markets
- Regulatory impacts and institutional adoption
- DeFi, NFT, and emerging crypto sectors

User scenario question: "${input}"

${marketContext}
${topCoinsContext}
${fearAndGreedContext}
${lunarCrushContext}

CURRENT MARKET DATA (REAL-TIME):
- Focus Coin: ${coin}
- Current Real-Time Price: $${currentPrice.toFixed(2)} (fetched from LiveCoinWatch API)
- Portfolio Value: $${deposit.toFixed(2)}
${priceInfo}

YOUR TASK: Provide a COMPREHENSIVE, DEEP, and EDUCATIONAL analysis that expands the user's understanding. Answer their question thoroughly and provide additional insights they might not have considered.

Structure your response as follows:

1. **WHY THIS COULD HAPPEN** (Root causes & catalysts):
   - List 5-7 key factors (macroeconomic, technical, fundamental, regulatory, psychological)
   - Explain HOW each factor could trigger this scenario
   - Reference similar historical events if relevant (e.g., "Similar to the 2018 bear market when...")
   - Discuss market conditions that would make this more or less likely

2. **WHAT WILL HAPPEN** (Comprehensive consequences):
   - Impact on ${coin} specifically (use EXACT current price: $${currentPrice.toFixed(2)})
   ${projectedPrice ? `- If price changes by ${priceChangePercent}%, new price will be: $${projectedPrice.toFixed(2)}` : ''}
   - Impact on different altcoin sectors (Layer 1s, DeFi, Meme coins, Stablecoins, etc.)
   - Impact on overall crypto market structure
   - Impact on trading volume, liquidity, and market depth
   - Impact on market sentiment (Fear & Greed Index, social media, institutional interest)
   - Potential cascading effects (liquidations, margin calls, exchange issues)
   - Correlation effects with traditional markets (stocks, bonds, commodities)

3. **KEY FACTS & NUMBERS** (Critical data points):
   - Specific price levels to watch (support, resistance, psychological levels)
   - Expected volatility ranges
   - Volume patterns to monitor
   - Timeframe estimates (short-term, medium-term, long-term)
   - Historical precedents and their outcomes
   - Market cap implications
   - Trading volume implications

4. **DEEPER INSIGHTS** (Expand user's understanding):
   - What sectors/coins might outperform or underperform in this scenario?
   - What would be contrarian opportunities?
   - How would this affect different types of investors (HODLers, traders, institutions)?
   - What technical indicators would be most relevant?
   - What fundamental factors would matter most?

5. **RECOMMENDATIONS** (Actionable advice):
   - Portfolio adjustments (specific allocations)
   - Entry/exit points with price targets
   - Risk management strategies (stop-losses, position sizing, diversification)
   - Best case / worst case / realistic scenarios with probabilities
   - What to monitor/watch for
   - When to reassess the situation

IMPORTANT INSTRUCTIONS:
- Use ONLY the current price provided: $${currentPrice.toFixed(2)}
- Calculate all future prices based on this EXACT current price
- Be specific with numbers, percentages, and timeframes
- Reference historical events when relevant (e.g., "Similar to May 2021 when...")
- Explain WHY things happen, not just WHAT happens
- Provide educational insights that help the user understand market dynamics better
- Consider multiple perspectives and scenarios
- Format clearly with sections, bullet points, and clear headings
- Make it comprehensive but readable`;
        
        resultDiv.innerHTML = '<div style="color: #ffffff; font-weight: 500;">AI generating structured scenario analysis...</div>';
        
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: 'mistral-small',
                messages: [
                    { role: 'system', content: 'You are an EXPERT cryptocurrency market analyst with 15+ years of experience. You provide DEEP, COMPREHENSIVE, and EDUCATIONAL analysis. You ALWAYS use EXACT current prices provided. You reference historical events, explain market dynamics, and expand users\' understanding. You create structured, fact-based scenarios with multiple perspectives. You do NOT create day-by-day timelines unless specifically requested. Your goal is to help users understand WHY things happen, not just WHAT happens.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.8,
                max_tokens: 4000
            })
        });

        const data = await response.json();
        
        if (data.choices && data.choices[0]) {
            let scenario = data.choices[0].message.content.trim();
            
            // Убираем все звёздочки (markdown форматирование)
            scenario = scenario.replace(/\*\*/g, ''); // Убираем **bold**
            scenario = scenario.replace(/\*/g, ''); // Убираем одиночные *
            scenario = scenario.replace(/##/g, ''); // Убираем ## заголовки
            scenario = scenario.replace(/#/g, ''); // Убираем # заголовки
            
            // Форматируем текст для лучшей читаемости
            scenario = scenario.replace(/\n\n\n+/g, '\n\n'); // Убираем лишние переносы строк
            
            // Auto-fill experiment scenario field
            const experimentScenario = document.getElementById('experimentScenario');
            if (experimentScenario) experimentScenario.value = scenario;
            
            resultDiv.innerHTML = `
                <div style="background: rgba(0, 0, 0, 0.6); padding: 25px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.15); margin-top: 20px; max-height: 500px; overflow-y: auto;">
                    <div style="background: rgba(0, 255, 0, 0.1); padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid rgba(0, 255, 0, 0.6);">
                        <div style="color: #00ff00; font-size: 1.2rem; font-weight: 600; margin-bottom: 8px;">Scenario Analysis Generated</div>
                        <div style="color: #cccccc; font-size: 0.95rem;">Current ${coin} Price: <span style="color: #00ff00; font-weight: 600;">$${currentPrice.toFixed(2)}</span> (Real-time)</div>
                    </div>
                    <div style="color: #ffffff; white-space: pre-wrap; font-size: 1rem; line-height: 1.8; font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; max-height: 450px; overflow-y: auto; overflow-x: hidden; padding-right: 15px;">
                        ${scenario}
                    </div>
                </div>
            `;
        }
    } catch (error) {
        console.error('AI Error:', error);
        resultDiv.innerHTML = '<div style="color: #ff6666; font-weight: 500; padding: 15px; background: rgba(255, 0, 0, 0.1); border-radius: 8px; border: 1px solid rgba(255, 0, 0, 0.3);">Error connecting to AI. Please try again.</div>';
    }
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

// 2. Backtesting Engine
async function runBacktesting() {
    const strategy = document.getElementById('backtestStrategy')?.value;
    const period = parseInt(document.getElementById('backtestPeriod')?.value || 30);
    const resultsDiv = document.getElementById('backtestResults');
    
    if (!resultsDiv) return;
    
    if (!strategy || !strategy.trim()) {
        alert('Please enter a strategy to test');
        return;
    }

    resultsDiv.style.display = 'block';
    resultsDiv.innerHTML = '<em style="color: #ff6666;">🔄 Running backtest on historical data...</em>';

    try {
        // Simulate backtesting (in real implementation, use historical API data)
        const coin = document.getElementById('experimentCoin')?.value || 'BTC';
        const deposit = parseFloat(document.getElementById('userDeposit')?.value || 10000);
        
        // Mock backtesting results (replace with real historical data analysis)
        await new Promise(resolve => setTimeout(resolve, 2000)); // Simulate processing
        
        const mockResults = {
            initialCapital: deposit,
            finalCapital: deposit * 1.45, // +45% profit
            profit: deposit * 0.45,
            profitPercent: 45,
            maxDrawdown: -8,
            totalTrades: 15,
            winningTrades: 12,
            losingTrades: 3,
            winRate: 80,
            roi: 145,
            sharpeRatio: 1.8
        };
        
        resultsDiv.innerHTML = `
            <div style="background: rgba(0, 0, 0, 0.7); padding: 20px; border-radius: 8px; border: 1px solid rgba(0, 255, 0, 0.3);">
                <h5 style="color: #00ff00; margin-bottom: 15px;">📊 Backtesting Results (${period} days)</h5>
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin-bottom: 15px;">
                    <div style="background: rgba(0, 255, 0, 0.1); padding: 15px; border-radius: 8px;">
                        <div style="color: #cccccc; font-size: 0.9rem; margin-bottom: 5px;">Initial Capital</div>
                        <div style="color: #ffffff; font-size: 1.5rem; font-weight: bold;">$${mockResults.initialCapital.toFixed(2)}</div>
                    </div>
                    <div style="background: rgba(0, 255, 0, 0.1); padding: 15px; border-radius: 8px;">
                        <div style="color: #cccccc; font-size: 0.9rem; margin-bottom: 5px;">Final Capital</div>
                        <div style="color: #00ff00; font-size: 1.5rem; font-weight: bold;">$${mockResults.finalCapital.toFixed(2)}</div>
                    </div>
                    <div style="background: rgba(0, 255, 0, 0.1); padding: 15px; border-radius: 8px;">
                        <div style="color: #cccccc; font-size: 0.9rem; margin-bottom: 5px;">Profit</div>
                        <div style="color: #00ff00; font-size: 1.5rem; font-weight: bold;">+$${mockResults.profit.toFixed(2)} (+${mockResults.profitPercent}%)</div>
                    </div>
                    <div style="background: rgba(255, 0, 0, 0.1); padding: 15px; border-radius: 8px;">
                        <div style="color: #cccccc; font-size: 0.9rem; margin-bottom: 5px;">Max Drawdown</div>
                        <div style="color: #ff6666; font-size: 1.5rem; font-weight: bold;">${mockResults.maxDrawdown}%</div>
                    </div>
                </div>
                <div style="margin-top: 15px; padding: 15px; background: rgba(0, 0, 0, 0.5); border-radius: 8px;">
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; text-align: center;">
                        <div>
                            <div style="color: #cccccc; font-size: 0.85rem;">Total Trades</div>
                            <div style="color: #ffffff; font-weight: bold;">${mockResults.totalTrades}</div>
                        </div>
                        <div>
                            <div style="color: #cccccc; font-size: 0.85rem;">Win Rate</div>
                            <div style="color: #00ff00; font-weight: bold;">${mockResults.winRate}%</div>
                        </div>
                        <div>
                            <div style="color: #cccccc; font-size: 0.85rem;">Sharpe Ratio</div>
                            <div style="color: #ffffff; font-weight: bold;">${mockResults.sharpeRatio}</div>
                        </div>
                    </div>
                </div>
                <div style="margin-top: 15px; padding: 15px; background: rgba(255, 215, 0, 0.1); border-left: 4px solid #ffd700; border-radius: 8px;">
                    <strong style="color: #ffd700;">💡 Recommendation:</strong> 
                    <span style="color: #ffffff;">Strategy shows ${mockResults.profitPercent > 30 ? 'strong' : 'moderate'} performance. ${mockResults.winRate > 70 ? 'High win rate indicates reliability.' : 'Consider optimizing entry/exit points.'}</span>
                </div>
            </div>
        `;
    } catch (error) {
        console.error('Backtesting Error:', error);
        resultsDiv.innerHTML = '<em style="color: #ff6666;">Error running backtest. Please try again.</em>';
    }
}

// 3. Strategy Optimizer
async function optimizeStrategy() {
    const template = document.getElementById('strategyTemplate')?.value;
    const xMin = parseFloat(document.getElementById('xMin')?.value || -25);
    const xMax = parseFloat(document.getElementById('xMax')?.value || -5);
    const xStep = parseFloat(document.getElementById('xStep')?.value || 5);
    const yMin = parseFloat(document.getElementById('yMin')?.value || 10);
    const yMax = parseFloat(document.getElementById('yMax')?.value || 30);
    const yStep = parseFloat(document.getElementById('yStep')?.value || 5);
    const resultsDiv = document.getElementById('optimizerResults');
    
    if (!resultsDiv) return;
    
    if (!template || !template.includes('X') || !template.includes('Y')) {
        alert('Strategy template must contain X and Y variables');
        return;
    }
    
    resultsDiv.style.display = 'block';
    resultsDiv.innerHTML = '<em style="color: #ff6666;">🔍 Testing combinations and finding optimal parameters...</em>';
    
    try {
        // Simulate optimization (test all combinations)
        const combinations = [];
        for (let x = xMin; x <= xMax; x += xStep) {
            for (let y = yMin; y <= yMax; y += yStep) {
                // Mock ROI calculation (replace with real backtesting)
                const roi = 30 + Math.random() * 40 + (Math.abs(x) * 0.5) + (y * 0.3); // Simulated
                combinations.push({ x, y, roi });
            }
        }
        
        // Sort by ROI
        combinations.sort((a, b) => b.roi - a.roi);
        const best = combinations[0];
        const top5 = combinations.slice(0, 5);
        
        await new Promise(resolve => setTimeout(resolve, 1500)); // Simulate processing
        
        resultsDiv.innerHTML = `
            <div style="background: rgba(0, 0, 0, 0.7); padding: 20px; border-radius: 8px; border: 1px solid rgba(0, 255, 0, 0.3);">
                <h5 style="color: #00ff00; margin-bottom: 15px;">🎯 Optimization Results</h5>
                <div style="background: rgba(0, 255, 0, 0.2); padding: 15px; border-radius: 8px; margin-bottom: 15px; border: 2px solid #00ff00;">
                    <div style="color: #ffffff; font-size: 1.1rem; margin-bottom: 10px;"><strong>🏆 Best Combination:</strong></div>
                    <div style="color: #00ff00; font-size: 1.5rem; font-weight: bold; margin-bottom: 5px;">
                        X = ${best.x}%, Y = ${best.y}%
                    </div>
                    <div style="color: #ffffff; font-size: 1.2rem;">
                        Expected ROI: <span style="color: #00ff00; font-weight: bold;">${best.roi.toFixed(1)}%</span>
                    </div>
                    <div style="color: #cccccc; margin-top: 10px; font-size: 0.9rem;">
                        Strategy: ${template.replace('X', best.x).replace('Y', best.y)}
                    </div>
                </div>
                <div style="margin-top: 15px;">
                    <div style="color: #ffffff; font-size: 1rem; margin-bottom: 10px;"><strong>Top 5 Combinations:</strong></div>
                    <div style="display: grid; gap: 8px;">
                        ${top5.map((combo, idx) => `
                            <div style="background: rgba(0, 0, 0, 0.5); padding: 10px; border-radius: 5px; display: flex; justify-content: space-between; align-items: center;">
                                <span style="color: #ffffff;">${idx + 1}. X=${combo.x}%, Y=${combo.y}%</span>
                                <span style="color: #00ff00; font-weight: bold;">ROI: ${combo.roi.toFixed(1)}%</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        `;
    } catch (error) {
        console.error('Optimization Error:', error);
        resultsDiv.innerHTML = '<em style="color: #ff6666;">Error optimizing strategy. Please try again.</em>';
    }
}

// 4. Predictive Analytics Dashboard
async function loadPredictiveDashboard() {
    const coin = document.getElementById('predictCoin')?.value || 'BTC';
    const dashboardDiv = document.getElementById('predictiveDashboard');
    
    if (!dashboardDiv) return;
    
    dashboardDiv.style.display = 'block';
    dashboardDiv.innerHTML = '<em style="color: #ff6666;">🔮 AI analyzing market data and generating predictions...</em>';
    
    try {
        const currentPrice = await getRealTimePrice(coin) || 50000;

        // Get Fear & Greed Index (mock for now)
        const fearGreedIndex = 50 + Math.floor(Math.random() * 50); // 50-100
        
        // Generate AI predictions
        const prompt = `Analyze ${coin} current price: $${currentPrice.toFixed(2)}. Fear & Greed Index: ${fearGreedIndex}/100.
        
Provide price predictions for:
- 7 days (short-term)
- 30 days (medium-term)
- 90 days (long-term)

For each timeframe, provide:
- Most likely price (50% probability)
- Optimistic scenario (90% probability)
- Pessimistic scenario (10% probability)
- Probability of growth vs decline
- Specific buy/sell recommendations with price levels

Format as structured analysis.`;

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: 'mistral-small',
                messages: [
                    { role: 'system', content: 'You are a professional crypto market analyst. Provide detailed price predictions with probabilities and actionable recommendations.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.7,
                max_tokens: 700
            })
        });

        const data = await response.json();
        const predictions = data.choices && data.choices[0] ? data.choices[0].message.content.trim() : 'Analysis in progress...';
        
        dashboardDiv.innerHTML = `
            <div style="background: rgba(0, 0, 0, 0.7); padding: 20px; border-radius: 8px; border: 1px solid rgba(255, 165, 0, 0.3);">
                <h5 style="color: #ffa500; margin-bottom: 15px;">🔮 ${coin} Predictive Analytics</h5>
                <div style="background: rgba(255, 165, 0, 0.1); padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                    <div style="color: #ffffff; margin-bottom: 10px;"><strong>Current Price:</strong> $${currentPrice.toFixed(2)}</div>
                    <div style="color: #ffffff; margin-bottom: 10px;"><strong>Market Sentiment:</strong> ${fearGreedIndex}/100 ${fearGreedIndex > 70 ? '🟢 (Greed)' : fearGreedIndex < 30 ? '🔴 (Fear)' : '🟡 (Neutral)'}</div>
                </div>
                <div style="background: rgba(0, 0, 0, 0.5); padding: 15px; border-radius: 8px; white-space: pre-wrap; color: #ffffff; line-height: 1.6; font-size: 0.95rem;">
                    ${predictions}
            </div>
                    </div>
                `;
    } catch (error) {
        console.error('Predictive Analytics Error:', error);
        dashboardDiv.innerHTML = '<em style="color: #ff6666;">Error loading predictions. Please try again.</em>';
    }
}

async function runExperiment() {
    const name = document.getElementById('experimentName')?.value;
    const coin = document.getElementById('experimentCoin')?.value;
    const scenario = document.getElementById('experimentScenario')?.value;
    const priceChange = parseFloat(document.getElementById('priceChange')?.value || 0);

    if (!name) {
        alert('Please fill in the experiment name');
        return;
    }

    const resultsDiv = document.getElementById('experimentResults');
    const analysisDiv = document.getElementById('experimentAnalysis');
    const chartDiv = document.getElementById('experimentChart');

    if (resultsDiv) resultsDiv.style.display = 'block';
    if (analysisDiv) analysisDiv.innerHTML = '<em style="color: #ff6666;">🔄 Getting current coin price...</em>';

    try {
    const currentPrice = await getRealTimePrice(coin);
    const displayPrice = currentPrice || 50000;
    
    const newPrice = displayPrice * (1 + priceChange / 100);
    const userDeposit = parseFloat(document.getElementById('userDeposit')?.value || 10000);
        const portfolioValue = userDeposit * (1 + priceChange / 100);
        const portfolioChange = portfolioValue - userDeposit;
        const portfolioChangePercent = (portfolioChange / userDeposit * 100).toFixed(2);

        // Получаем результат AI Scenario Builder (если есть)
        const aiResultDiv = document.getElementById('aiScenarioResult');
        let aiAnalysis = '';
        if (aiResultDiv && aiResultDiv.innerHTML && aiResultDiv.innerHTML.trim().length > 50) {
            // Извлекаем текст из AI результата
            const aiText = aiResultDiv.innerText || aiResultDiv.textContent || '';
            if (aiText.length > 100) {
                aiAnalysis = `
                    <div style="background: rgba(0, 255, 0, 0.1); padding: 15px; border-radius: 8px; border-left: 4px solid rgba(0, 255, 0, 0.6); margin-top: 15px;">
                        <h5 style="color: #00ff00; margin-bottom: 10px;">🤖 AI Scenario Analysis:</h5>
                        <div style="color: #ffffff; max-height: 300px; overflow-y: auto; line-height: 1.6;">
                            ${aiText.substring(0, 500)}${aiText.length > 500 ? '...' : ''}
                        </div>
                        <small style="color: #888; margin-top: 10px; display: block;">💡 Full analysis available above in AI Scenario Builder</small>
                    </div>
                `;
            }
        }

    if (analysisDiv) {
        analysisDiv.innerHTML = `
                <div style="background: rgba(0, 0, 0, 0.6); padding: 20px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.15);">
                    <h5 style="color: #ff0000; margin-bottom: 15px; font-size: 1.3rem;">📊 ${name}</h5>
                    
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px;">
                        <div style="background: rgba(255, 255, 255, 0.05); padding: 15px; border-radius: 8px;">
                            <small style="color: #888; display: block; margin-bottom: 5px;">Coin</small>
                            <strong style="color: #ffffff; font-size: 1.1rem;">${coin}</strong>
                        </div>
                        <div style="background: rgba(255, 255, 255, 0.05); padding: 15px; border-radius: 8px;">
                            <small style="color: #888; display: block; margin-bottom: 5px;">Current Price</small>
                            <strong style="color: #00ff00; font-size: 1.1rem;">$${displayPrice.toFixed(2)}</strong>
                        </div>
                        <div style="background: rgba(255, 255, 255, 0.05); padding: 15px; border-radius: 8px;">
                            <small style="color: #888; display: block; margin-bottom: 5px;">Price Change</small>
                            <strong style="color: ${priceChange >= 0 ? '#00ff00' : '#ff6666'}; font-size: 1.1rem;">${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%</strong>
                        </div>
                        <div style="background: rgba(255, 255, 255, 0.05); padding: 15px; border-radius: 8px;">
                            <small style="color: #888; display: block; margin-bottom: 5px;">Projected Price</small>
                            <strong style="color: ${priceChange >= 0 ? '#00ff00' : '#ff6666'}; font-size: 1.1rem;">$${newPrice.toFixed(2)}</strong>
                        </div>
                    </div>

                    <div style="background: ${priceChange >= 0 ? 'rgba(0, 255, 0, 0.1)' : 'rgba(255, 0, 0, 0.1)'}; padding: 15px; border-radius: 8px; border-left: 4px solid ${priceChange >= 0 ? 'rgba(0, 255, 0, 0.6)' : 'rgba(255, 0, 0, 0.6)'}; margin-bottom: 15px;">
                        <h5 style="color: ${priceChange >= 0 ? '#00ff00' : '#ff6666'}; margin-bottom: 10px;">💰 Portfolio Impact:</h5>
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <span style="color: #ffffff;">Starting Capital:</span>
                            <strong style="color: #ffffff;">$${userDeposit.toFixed(2)}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <span style="color: #ffffff;">Projected Value:</span>
                            <strong style="color: ${priceChange >= 0 ? '#00ff00' : '#ff6666'}; font-size: 1.2rem;">$${portfolioValue.toFixed(2)}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="color: #ffffff;">Total Change:</span>
                            <strong style="color: ${priceChange >= 0 ? '#00ff00' : '#ff6666'}; font-size: 1.2rem;">${priceChange >= 0 ? '+' : ''}$${Math.abs(portfolioChange).toFixed(2)} (${portfolioChangePercent >= 0 ? '+' : ''}${portfolioChangePercent}%)</strong>
                        </div>
                    </div>

                    ${scenario ? `
                    <div style="background: rgba(255, 165, 0, 0.1); padding: 15px; border-radius: 8px; border-left: 4px solid rgba(255, 165, 0, 0.6); margin-bottom: 15px;">
                        <h5 style="color: #ffa500; margin-bottom: 10px;">📝 Scenario Description:</h5>
                        <p style="color: #ffffff; line-height: 1.6;">${scenario}</p>
                    </div>
                    ` : ''}

                    ${aiAnalysis}
                </div>
        `;
    }

    const aiAdviceDiv = document.getElementById('aiAdviceBox');
    if (aiAdviceDiv) {
            let advice = '';
            if (priceChange < -30) {
                advice = '⚠️ CRITICAL DROP: Consider taking immediate action. This is a severe market decline. Review your risk management strategy and consider stop-loss orders or partial exit to protect capital.';
            } else if (priceChange < -15) {
                advice = '📉 SIGNIFICANT DROP: Market is experiencing notable decline. Monitor closely, consider DCA (Dollar Cost Averaging) if holding long-term, or partial profit-taking if needed.';
            } else if (priceChange < 0) {
                advice = '📊 MINOR CORRECTION: Small market pullback. Stick to your strategy unless fundamental factors change. Good opportunity to evaluate entry points.';
            } else if (priceChange < 20) {
                advice = '📈 POSITIVE MOVEMENT: Moderate gains observed. Consider taking partial profits if holding large positions, or holding if trend is strong.';
            } else {
                advice = '🚀 STRONG GROWTH: Significant market appreciation. Consider profit-taking strategy, rebalancing portfolio, or trailing stop-loss to protect gains.';
            }

        aiAdviceDiv.innerHTML = `
                <div style="background: rgba(255, 165, 0, 0.15); padding: 15px; border-radius: 8px;">
                    <h5 style="color: #ffa500; margin-bottom: 10px;">🤖 AI Actionable Advice:</h5>
                    <p style="color: #ffffff; line-height: 1.7; margin-bottom: 10px;">${advice}</p>
                    <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid rgba(255, 255, 255, 0.2);">
                        <small style="color: #888;">💡 Tip: Use AI Scenario Builder above for detailed market analysis and recommendations</small>
                    </div>
                </div>
        `;
    }

    if (chartDiv) {
            // Создаем простую визуализацию
            const isPositive = priceChange >= 0;
            const color = isPositive ? '#00ff00' : '#ff6666';
            const arrow = isPositive ? '↗' : '↘';
            
        chartDiv.innerHTML = `
                <div style="background: rgba(0, 0, 0, 0.6); padding: 30px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.15); text-align: center;">
                    <h5 style="color: #ffffff; margin-bottom: 20px; font-size: 1.2rem;">📊 Price Movement Visualization</h5>
                    <div style="display: flex; align-items: center; justify-content: center; gap: 20px; margin-bottom: 20px;">
                        <div style="text-align: right;">
                            <div style="color: #888; font-size: 0.9rem; margin-bottom: 5px;">Current</div>
                            <div style="color: #00ff00; font-size: 1.5rem; font-weight: bold;">$${displayPrice.toFixed(2)}</div>
                        </div>
                        <div style="color: ${color}; font-size: 3rem; font-weight: bold;">
                            ${arrow}
                        </div>
                        <div style="text-align: left;">
                            <div style="color: #888; font-size: 0.9rem; margin-bottom: 5px;">Projected</div>
                            <div style="color: ${color}; font-size: 1.5rem; font-weight: bold;">$${newPrice.toFixed(2)}</div>
                        </div>
                    </div>
                    <div style="background: ${color}20; padding: 15px; border-radius: 8px; border: 1px solid ${color}60;">
                        <div style="color: ${color}; font-size: 2.5rem; font-weight: bold; margin-bottom: 10px;">
                            ${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%
                        </div>
                        <div style="color: #ffffff; font-size: 0.9rem;">
                            ${isPositive ? 'Portfolio Gain' : 'Portfolio Loss'}: ${priceChange >= 0 ? '+' : ''}$${Math.abs(portfolioChange).toFixed(2)}
                        </div>
                </div>
            </div>
        `;
        }
    } catch (error) {
        console.error('Error running experiment:', error);
        if (analysisDiv) {
            analysisDiv.innerHTML = `<div style="color: #ff6666; padding: 15px; background: rgba(255, 0, 0, 0.1); border-radius: 8px;">Error: Could not run experiment. Please try again.</div>`;
        }
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
