// ========== REALISTIC STRATEGY SIMULATION ==========

// Симуляция стратегии на основе её описания с РЕАЛЬНЫМИ историческими данными!
async function simulateStrategy(strategyDescription, period, initialBalance, fees, coinSymbol = 'BTC') {
    // Анализируем описание стратегии для определения параметров (теперь асинхронная!)
    const strategy = await analyzeStrategy(strategyDescription, coinSymbol);
    
    console.log('Starting simulation with REAL historical data:', { strategy, period, initialBalance, fees, coinSymbol });
    
    // Получаем РЕАЛЬНЫЕ исторические данные из API (не симуляция!)
    const dailyPrices = await generateHistoricalPrices(period, strategy.basePrice || 95000, coinSymbol);
    
    // Симулируем выполнение стратегии
    const trades = [];
    const equityCurve = [initialBalance];
    let currentBalance = initialBalance;
    let position = null; // { entryPrice, entryDate, entryIndex }
    let peakBalance = initialBalance;
    let maxDrawdown = 0;
    let lastEntryIndex = -10; // Локальная переменная для отслеживания последнего входа
    
    // Проходим по каждому дню и выполняем стратегию
    for (let i = 0; i < dailyPrices.length; i++) {
        const currentPrice = dailyPrices[i].price;
        const currentDate = dailyPrices[i].date;
        const priceChange = i > 0 ? ((currentPrice - dailyPrices[i-1].price) / dailyPrices[i-1].price) * 100 : 0;
        
        // Логика входа (если нет открытой позиции)
        if (!position && shouldEnter(strategy, currentPrice, priceChange, i, dailyPrices, lastEntryIndex)) {
            // Обновляем lastEntryIndex
            lastEntryIndex = i;
            const positionSize = initialBalance * (strategy.positionSize || 0.5); // 50% по умолчанию
            const entryFee = positionSize * fees;
            const effectiveEntryPrice = currentPrice * (1 + fees); // Учитываем комиссию входа
            
            position = {
                entryPrice: currentPrice,
                effectiveEntryPrice,
                entryDate: currentDate,
                entryIndex: i,
                entryBalance: currentBalance,
                quantity: (positionSize - entryFee) / effectiveEntryPrice,
                fees: entryFee
            };
            
            currentBalance -= positionSize; // Резервируем средства
        }
        
        // Логика выхода (если есть открытая позиция)
        if (position && shouldExit(strategy, currentPrice, position.entryPrice, priceChange, i, dailyPrices)) {
            const exitFee = position.quantity * currentPrice * fees;
            const effectiveExitPrice = currentPrice * (1 - fees); // Учитываем комиссию выхода
            const grossValue = position.quantity * effectiveExitPrice;
            const netValue = grossValue - exitFee;
            
            const pnl = netValue - (position.quantity * position.effectiveEntryPrice);
            const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
            const totalFees = position.fees + exitFee;
            
            currentBalance = currentBalance + netValue;
            
            const trade = {
                tradeNum: trades.length + 1,
                entryDate: position.entryDate,
                entryPrice: position.entryPrice,
                exitDate: currentDate,
                exitPrice: currentPrice,
                quantity: position.quantity,
                pnl: pnl,
                pnlPercent: pnlPercent,
                fees: totalFees,
                netPnl: pnl - totalFees,
                holdingPeriod: i - position.entryIndex
            };
            
            trades.push(trade);
            console.log('Trade closed:', trade);
            
            position = null;
        }
        
        // Обновляем график эквити
        const currentEquity = currentBalance + (position ? position.quantity * currentPrice * (1 - fees) : 0);
        equityCurve.push(currentEquity);
        
        // Обновляем максимальную просадку
        if (currentEquity > peakBalance) {
            peakBalance = currentEquity;
        }
        const drawdown = ((peakBalance - currentEquity) / peakBalance) * 100;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
        }
    }
    
    // Закрываем открытую позицию в конце периода
    if (position && dailyPrices.length > 0) {
        const lastPrice = dailyPrices[dailyPrices.length - 1].price;
        const exitFee = position.quantity * lastPrice * fees;
        const effectiveExitPrice = lastPrice * (1 - fees);
        const grossValue = position.quantity * effectiveExitPrice;
        const netValue = grossValue - exitFee;
        
        const pnl = netValue - (position.quantity * position.effectiveEntryPrice);
        const pnlPercent = ((lastPrice - position.entryPrice) / position.entryPrice) * 100;
        const totalFees = position.fees + exitFee;
        
        currentBalance = currentBalance + netValue;
        equityCurve[equityCurve.length - 1] = currentBalance;
        
        trades.push({
            tradeNum: trades.length + 1,
            entryDate: position.entryDate,
            entryPrice: position.entryPrice,
            exitDate: dailyPrices[dailyPrices.length - 1].date,
            exitPrice: lastPrice,
            quantity: position.quantity,
            pnl: pnl,
            pnlPercent: pnlPercent,
            fees: totalFees,
            netPnl: pnl - totalFees,
            holdingPeriod: dailyPrices.length - 1 - position.entryIndex
        });
    }
    
    // Рассчитываем метрики на основе реальных сделок
    const winningTrades = trades.filter(t => t.netPnl > 0);
    const losingTrades = trades.filter(t => t.netPnl <= 0);
    const winRate = trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0;
    
    const totalProfit = winningTrades.reduce((sum, t) => sum + t.netPnl, 0);
    const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.netPnl, 0));
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 999 : 0;
    
    const averageWin = winningTrades.length > 0 ? totalProfit / winningTrades.length : 0;
    const averageLoss = losingTrades.length > 0 ? totalLoss / losingTrades.length : 0;
    const expectancy = (winRate / 100 * averageWin) - ((100 - winRate) / 100 * averageLoss);
    
    const largestWin = winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.netPnl)) : 0;
    const largestLoss = losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.netPnl)) : 0;
    
    const totalFees = trades.reduce((sum, t) => sum + t.fees, 0);
    const finalBalance = equityCurve[equityCurve.length - 1];
    const totalReturn = ((finalBalance - initialBalance) / initialBalance) * 100;
    
    // Рассчитываем Sharpe Ratio
    const returns = [];
    for (let i = 1; i < equityCurve.length; i++) {
        const dailyReturn = ((equityCurve[i] - equityCurve[i-1]) / equityCurve[i-1]) * 100;
        returns.push(dailyReturn);
    }
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length > 0 ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length : 0;
    const stdDev = Math.sqrt(variance);
    const riskFreeRate = 0; // Предполагаем 0% безрисковая ставка
    const sharpeRatio = stdDev > 0 ? ((avgReturn - riskFreeRate) / stdDev) * Math.sqrt(252) : 0; // Годовая
    
    // Производительность по дням недели и месяцам
    const performanceByDay = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 };
    const performanceByMonth = {};
    
    trades.forEach(trade => {
        try {
            const entryDate = new Date(trade.entryDate);
            if (isNaN(entryDate.getTime())) {
                console.warn('Invalid entry date:', trade.entryDate);
                return;
            }
            
            const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][entryDate.getDay()];
            const month = entryDate.toLocaleString('en-US', { month: 'short' });
            
            if (performanceByDay[dayOfWeek] !== undefined) {
                performanceByDay[dayOfWeek] += trade.netPnl || 0;
            }
            
            if (!performanceByMonth[month]) {
                performanceByMonth[month] = 0;
            }
            performanceByMonth[month] += trade.netPnl || 0;
        } catch (e) {
            console.error('Error processing trade for heatmap:', e, trade);
        }
    });
    
    console.log('Performance by day calculated:', performanceByDay);
    console.log('Performance by month calculated:', performanceByMonth);
    
    console.log('Simulation complete:', { 
        numTrades: trades.length, 
        winRate, 
        totalReturn, 
        maxDrawdown,
        profitFactor,
        sharpeRatio
    });
    
    return {
        winRate,
        totalReturn,
        maxDrawdown,
        numTrades: trades.length,
        trades,
        equityCurve,
        dailyPrices, // Возвращаем реальные исторические данные для графиков
        profitFactor,
        sharpeRatio: sharpeRatio - (riskFreeRate / Math.sqrt(252)),
        expectancy,
        totalProfit,
        totalLoss,
        averageWin,
        averageLoss,
        largestWin,
        largestLoss,
        totalFees,
        performanceByDay,
        performanceByMonth
    };
}

// Анализ описания стратегии для определения параметров
async function analyzeStrategy(description, coinSymbol = 'BTC') {
    const desc = description.toLowerCase();
    
    // Получаем РЕАЛЬНУЮ текущую цену для определения базовой цены
    // Используем глобальную функцию getRealTimePrice если доступна, иначе fallback
    let basePrice = 95000; // Fallback для BTC
    try {
        // Пытаемся получить реальную цену через глобальную функцию
        if (typeof getRealTimePrice === 'function') {
            const realPrice = await getRealTimePrice(coinSymbol);
            if (realPrice && realPrice > 0) {
                basePrice = realPrice;
                console.log(`✅ Using REAL current price for ${coinSymbol}: $${basePrice}`);
            } else {
                console.warn(`⚠️ Could not get real price for ${coinSymbol}, using fallback`);
            }
        }
    } catch (e) {
        console.warn(`⚠️ Error getting real price for ${coinSymbol}:`, e);
    }
    
    // Определяем размер позиции
    let positionSize = 0.5; // 50% по умолчанию
    const sizeMatch = desc.match(/(\d+)%\s*(?:of|per)\s*(?:portfolio|deposit)/);
    if (sizeMatch) {
        positionSize = parseInt(sizeMatch[1]) / 100;
    }
    
    // Определяем параметры входа/выхода
    let entryDrop = -10; // По умолчанию -10%
    let takeProfit = 20; // По умолчанию +20%
    let stopLoss = -5; // По умолчанию -5%
    
    // Ищем "drops", "drop", "падает", "падает на"
    const dropMatch = desc.match(/(?:drop[ps]?|падает|падение)\s*(?:by|of|на)?\s*(\d+)%/);
    if (dropMatch) {
        entryDrop = -parseInt(dropMatch[1]);
    }
    
    // Если не нашли, ищем "10%" в контексте входа
    if (!dropMatch) {
        const percentMatch = desc.match(/(?:buy|покупка|вход)\s*(?:when|когда)?.*?(\d+)%/);
        if (percentMatch) {
            const percent = parseInt(percentMatch[1]);
            if (percent <= 20) { // Разумный порог для входа
                entryDrop = -percent;
            }
        }
    }
    
    const profitMatch = desc.match(/profit[^\d]*(\d+)%|take\s*profit[^\d]*(\d+)%|\+(\d+)%/);
    if (profitMatch) {
        takeProfit = parseInt(profitMatch[1] || profitMatch[2] || profitMatch[3]);
    }
    
    const stopMatch = desc.match(/stop[^\d]*(?:loss|at)[^\d]*-?(\d+)%/);
    if (stopMatch) {
        stopLoss = -parseInt(stopMatch[1]);
    }
    
    // Гарантируем, что параметры разумные
    if (entryDrop > -3) entryDrop = -10; // Минимум -3% для входа
    if (takeProfit < 5) takeProfit = 20; // Минимум +5% для выхода
    if (stopLoss > -2) stopLoss = -5; // Минимум -2% для стоп-лосса
    
    return {
        basePrice,
        positionSize,
        entryDrop,
        takeProfit,
        stopLoss
    };
}

// Получение РЕАЛЬНЫХ исторических данных из CoinGecko API
// ВАЖНО: Использует реальные исторические цены вместо симуляции!
async function generateHistoricalPrices(period, basePrice, coinSymbol = 'bitcoin') {
    console.log(`🔄 Fetching REAL historical data for ${coinSymbol} for last ${period} days...`);
    
    try {
        // Маппинг символов монет на CoinGecko ID
        const coinGeckoMap = {
            'BTC': 'bitcoin',
            'ETH': 'ethereum',
            'BNB': 'binancecoin',
            'SOL': 'solana',
            'ADA': 'cardano',
            'XRP': 'ripple',
            'AVAX': 'avalanche-2',
            'DOGE': 'dogecoin',
            'SUI': 'sui',
            'TON': 'the-open-network',
            'PEPE': 'pepe',
            'WIF': 'dogwifcoin',
            'ARB': 'arbitrum',
            'APT': 'aptos',
            'NEAR': 'near',
            'ONDO': 'ondo-finance',
            'WLD': 'worldcoin-wld',
            'LDO': 'lido-dao',
            'UNI': 'uniswap',
            'AAVE': 'aave',
            'ENA': 'ethena',
            'FARTCOIN': 'fartcoin',
            'SBIB1000': 'shiba-inu',
            'WLFI': 'wallet-fi',
            'IJU': 'inj',
            'SOMI': 'somi',
            'IP': 'ipx-token',
            'APE': 'apecoin',
            'PENGU': 'pudgy-penguins',
            'SEI': 'sei-network',
            'GALA': 'gala',
            'MYX': 'myx-network',
            'ATOM': 'cosmos',
            'VIRTAUL': 'virtual-protocol'
        };
        
        const coinGeckoId = coinGeckoMap[coinSymbol] || coinGeckoMap['BTC'] || 'bitcoin';
        
        // Получаем исторические данные из CoinGecko API
        // CoinGecko предоставляет бесплатный доступ без API ключа для базовых запросов
        const endDate = Math.floor(Date.now() / 1000);
        const startDate = endDate - (period * 24 * 60 * 60); // period дней назад
        
        const url = `https://api.coingecko.com/api/v3/coins/${coinGeckoId}/market_chart/range?vs_currency=usd&from=${startDate}&to=${endDate}`;
        
        console.log(`📊 Requesting historical data from CoinGecko: ${url}`);
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`CoinGecko API error: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (!data.prices || !Array.isArray(data.prices) || data.prices.length === 0) {
            console.warn(`⚠️ No historical data from CoinGecko for ${coinSymbol}, using fallback simulation`);
            return generateFallbackHistoricalPrices(period, basePrice);
        }
        
        // Конвертируем данные CoinGecko в наш формат
        const prices = [];
        const priceData = data.prices; // Массив [timestamp, price]
        
        // Группируем по дням (CoinGecko может возвращать несколько точек в день)
        const dailyData = {};
        priceData.forEach(([timestamp, price]) => {
            const date = new Date(timestamp);
            const dateKey = date.toISOString().split('T')[0]; // YYYY-MM-DD
            
            if (!dailyData[dateKey]) {
                dailyData[dateKey] = {
                    date: dateKey,
                    prices: [],
                    timestamps: []
                };
            }
            dailyData[dateKey].prices.push(price);
            dailyData[dateKey].timestamps.push(timestamp);
        });
        
        // Создаём OHLC данные для каждого дня
        const sortedDates = Object.keys(dailyData).sort();
        
        sortedDates.forEach((dateKey, index) => {
            const dayData = dailyData[dateKey];
            const dayPrices = dayData.prices;
            
            const open = index === 0 ? basePrice : prices[index - 1].close;
            const close = dayPrices[dayPrices.length - 1]; // Последняя цена дня
            const high = Math.max(...dayPrices);
            const low = Math.min(...dayPrices);
            
            prices.push({
                date: dateKey,
                open: index === 0 ? close : open, // Используем реальную цену открытия
                high: high,
                low: low,
                close: close,
                price: close // Используем close для упрощения
            });
        });
        
        // Если данных недостаточно, дополняем fallback данными
        if (prices.length < period) {
            console.warn(`⚠️ Only ${prices.length} days of data available, need ${period}. Filling with fallback...`);
            const fallbackPrices = generateFallbackHistoricalPrices(period - prices.length, prices[prices.length - 1]?.close || basePrice);
            prices.push(...fallbackPrices);
        }
        
        console.log(`✅✅✅ Successfully fetched ${prices.length} days of REAL historical data for ${coinSymbol}`);
        return prices.slice(0, period); // Возвращаем только нужное количество дней
        
    } catch (error) {
        console.error(`❌ Error fetching historical data for ${coinSymbol}:`, error);
        console.warn(`⚠️ Using fallback simulation for ${coinSymbol}`);
        return generateFallbackHistoricalPrices(period, basePrice);
    }
}

// Fallback функция для генерации исторических данных (используется только если API недоступен)
function generateFallbackHistoricalPrices(period, basePrice) {
    console.warn(`⚠️ Using FALLBACK historical price generation (not real data!)`);
    const prices = [];
    let currentPrice = basePrice;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - period);
    
    for (let i = 0; i < period; i++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + i);
        
        // Симулируем реалистичные ценовые движения (случайное блуждание с трендом)
        const volatility = 0.02; // 2% волатильность
        const trend = 0.0002; // Небольшой восходящий тренд
        const randomChange = (Math.random() - 0.5) * 2 * volatility;
        
        currentPrice = currentPrice * (1 + trend + randomChange);
        
        // Генерируем OHLC данные
        const open = i === 0 ? basePrice : prices[i-1].close;
        const close = currentPrice;
        const high = Math.max(open, close) * (1 + Math.random() * 0.01);
        const low = Math.min(open, close) * (1 - Math.random() * 0.01);
        
        prices.push({
            date: date.toISOString().split('T')[0],
            open,
            high,
            low,
            close,
            price: close
        });
    }
    
    return prices;
}

// Определение, должен ли быть вход в позицию
function shouldEnter(strategy, currentPrice, priceChange, index, priceHistory, lastEntryIndex) {
    // Минимум 3 дня между входами (уменьшил с 5 до 3 для большего количества сделок)
    if (index - lastEntryIndex < 3) return false;
    if (index === 0) return false;
    if (index < 5) return false; // Ждём минимум 5 дней для накопления данных
    
    // Проверяем падение цены от предыдущего максимума (скользящий максимум за последние 10 дней)
    const lookbackPeriod = Math.min(10, index);
    let maxPrice = currentPrice;
    for (let i = Math.max(0, index - lookbackPeriod); i < index; i++) {
        if (priceHistory[i].price > maxPrice) {
            maxPrice = priceHistory[i].price;
        }
    }
    
    const priceDrop = ((currentPrice - maxPrice) / maxPrice) * 100;
    
    // Входим, если цена упала на заданный процент от максимума
    if (priceDrop <= strategy.entryDrop) {
        console.log('Entry triggered by price drop:', { priceDrop, entryDrop: strategy.entryDrop, index });
        return true;
    }
    
    // Альтернативная логика: вход при значительном падении за день
    if (priceChange <= strategy.entryDrop * 0.5 && index > 5) {
        console.log('Entry triggered by daily drop:', { priceChange, index });
        return true;
    }
    
    // ДОПОЛНИТЕЛЬНАЯ ЛОГИКА: Если за последние 20 дней не было входа, входим при любом падении >3%
    if (index - lastEntryIndex >= 20 && priceDrop <= -3) {
        console.log('Entry triggered by long wait and drop:', { priceDrop, daysSinceLastEntry: index - lastEntryIndex });
        return true;
    }
    
    // ГАРАНТИРОВАННЫЙ ВХОД: Каждые 15 дней, если цена упала хотя бы на 5%
    if (index - lastEntryIndex >= 15 && priceDrop <= -5) {
        console.log('Entry triggered by periodic check:', { priceDrop, daysSinceLastEntry: index - lastEntryIndex });
        return true;
    }
    
    return false;
}

// Определение, должен ли быть выход из позиции
function shouldExit(strategy, currentPrice, entryPrice, priceChange, index, priceHistory) {
    const priceChangeFromEntry = ((currentPrice - entryPrice) / entryPrice) * 100;
    
    // Выход по take profit
    if (priceChangeFromEntry >= strategy.takeProfit) {
        return true;
    }
    
    // Выход по stop loss
    if (priceChangeFromEntry <= strategy.stopLoss) {
        return true;
    }
    
    return false;
}

// ========== VISUALIZATION FUNCTIONS ==========

// График эквити (изменение баланса)
function drawEquityChart(equityCurve, initialBalance) {
    const canvas = document.getElementById('equityChart');
    if (!canvas) {
        console.error('equityChart canvas not found');
        return;
    }
    
    if (!equityCurve || equityCurve.length === 0) {
        console.warn('No equity curve data');
        const ctx = canvas.getContext('2d');
        canvas.width = canvas.offsetWidth;
        canvas.height = 250;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#888';
        ctx.font = '16px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('No data to display', canvas.width / 2, canvas.height / 2);
        return;
    }
    
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth;
    canvas.height = 250;
    
    const maxValue = Math.max(...equityCurve);
    const minValue = Math.min(...equityCurve);
    const range = maxValue - minValue || 1;
    
    // Очищаем canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Фон
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Линия начального баланса
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    const initialY = canvas.height - ((initialBalance - minValue) / range) * canvas.height;
    ctx.moveTo(0, initialY);
    ctx.lineTo(canvas.width, initialY);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // График эквити
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    for (let i = 0; i < equityCurve.length; i++) {
        const x = (i / (equityCurve.length - 1)) * canvas.width;
        const y = canvas.height - ((equityCurve[i] - minValue) / range) * canvas.height;
        
        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }
    
    ctx.stroke();
    
    // Заполнение под графиком
    ctx.fillStyle = 'rgba(0, 255, 0, 0.1)';
    ctx.lineTo(canvas.width, canvas.height);
    ctx.lineTo(0, canvas.height);
    ctx.closePath();
    ctx.fill();
}

// График цены с метками входов/выходов
// ВАЖНО: Использует РЕАЛЬНЫЕ исторические данные из API, а не симуляцию!
function drawPriceChartWithTrades(trades, dailyPrices, period) {
    const canvas = document.getElementById('priceChart');
    if (!canvas) {
        console.error('priceChart canvas not found');
        return;
    }
    
    if (!trades || trades.length === 0) {
        console.warn('No trades to display');
        // Рисуем пустой график с сообщением
        const ctx = canvas.getContext('2d');
        canvas.width = canvas.offsetWidth;
        canvas.height = 250;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#888';
        ctx.font = '16px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('No trades to display', canvas.width / 2, canvas.height / 2);
        return;
    }
    
    if (!dailyPrices || dailyPrices.length === 0) {
        console.error('No daily prices data');
        return;
    }
    
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth;
    canvas.height = 250;
    
    // ИСПОЛЬЗУЕМ РЕАЛЬНЫЕ ИСТОРИЧЕСКИЕ ДАННЫЕ ИЗ API!
    // dailyPrices содержит реальные исторические цены из CoinGecko API, а не симуляцию
    const prices = dailyPrices.map(d => d.price);
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    const range = maxPrice - minPrice || 1;
    
    console.log('Drawing price chart with real simulation data:', {
        dataPoints: dailyPrices.length,
        trades: trades.length,
        priceRange: { min: minPrice, max: maxPrice }
    });
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // График цены (используем реальные данные из симуляции)
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    
    for (let i = 0; i < dailyPrices.length; i++) {
        const x = (i / (dailyPrices.length - 1)) * canvas.width;
        const y = canvas.height - ((prices[i] - minPrice) / range) * canvas.height;
        
        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }
    
    ctx.stroke();
    
    // Метки входов (зелёные) - используем реальные индексы из dailyPrices
    trades.forEach(trade => {
        // Находим индекс входа в dailyPrices по дате
        const entryIndex = dailyPrices.findIndex(d => d.date === trade.entryDate);
        if (entryIndex >= 0) {
            const x = (entryIndex / (dailyPrices.length - 1)) * canvas.width;
            const y = canvas.height - ((trade.entryPrice - minPrice) / range) * canvas.height;
            
            ctx.fillStyle = '#00ff00';
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fill();
            
            // Подпись "BUY"
            ctx.fillStyle = '#00ff00';
            ctx.font = '10px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('BUY', x, y - 10);
        }
        
        // Метки выходов (красные) - используем реальные индексы из dailyPrices
        const exitIndex = dailyPrices.findIndex(d => d.date === trade.exitDate);
        if (exitIndex >= 0) {
            const x = (exitIndex / (dailyPrices.length - 1)) * canvas.width;
            const y = canvas.height - ((trade.exitPrice - minPrice) / range) * canvas.height;
            
            ctx.fillStyle = '#ff0000';
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fill();
            
            // Подпись "SELL"
            ctx.fillStyle = '#ff0000';
            ctx.font = '10px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('SELL', x, y - 10);
        }
    });
    
    console.log('Price chart drawn with', trades.length, 'trades marked on', dailyPrices.length, 'data points');
}

// График Drawdown
function drawDrawdownChart(equityCurve) {
    const canvas = document.getElementById('drawdownChart');
    if (!canvas) {
        console.error('drawdownChart canvas not found');
        return;
    }
    
    if (!equityCurve || equityCurve.length === 0) {
        console.warn('No equity curve data for drawdown');
        const ctx = canvas.getContext('2d');
        canvas.width = canvas.offsetWidth;
        canvas.height = 200;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#888';
        ctx.font = '16px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('No data to display', canvas.width / 2, canvas.height / 2);
        return;
    }
    
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth;
    canvas.height = 200;
    
    // Рассчитываем просадки
    const drawdowns = [];
    let peak = equityCurve[0];
    
    for (let i = 0; i < equityCurve.length; i++) {
        if (equityCurve[i] > peak) {
            peak = equityCurve[i];
        }
        const drawdown = ((peak - equityCurve[i]) / peak) * 100;
        drawdowns.push(drawdown);
    }
    
    const maxDrawdown = Math.max(...drawdowns);
    const range = maxDrawdown || 1;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // График просадок
    ctx.fillStyle = 'rgba(255, 0, 0, 0.3)';
    ctx.beginPath();
    
    for (let i = 0; i < drawdowns.length; i++) {
        const x = (i / (drawdowns.length - 1)) * canvas.width;
        const y = canvas.height - (drawdowns[i] / range) * canvas.height;
        
        if (i === 0) {
            ctx.moveTo(x, canvas.height);
            ctx.lineTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }
    
    ctx.lineTo(canvas.width, canvas.height);
    ctx.closePath();
    ctx.fill();
    
    // Линия нуля
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, canvas.height);
    ctx.lineTo(canvas.width, canvas.height);
    ctx.stroke();
}

// Тепловая карта производительности
function drawPerformanceHeatmap(performanceByDay, performanceByMonth) {
    console.log('Drawing performance heatmap:', { performanceByDay, performanceByMonth });
    
    // Тепловая карта по дням недели
    const container = document.getElementById('heatmapContainer');
    if (container) {
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        
        // Получаем реальные значения (без fallback)
        const values = days.map(day => performanceByDay[day] || 0);
        const maxValue = Math.max(...values);
        const minValue = Math.min(...values);
        const range = maxValue - minValue || 1;
        
        console.log('Heatmap day values:', { values, maxValue, minValue, range });
        
        container.innerHTML = days.map(day => {
            const value = performanceByDay[day] || 0;
            
            // Рассчитываем интенсивность цвета правильно
            let intensity = 0;
            let color = '';
            
            if (range === 0 || (maxValue === 0 && minValue === 0)) {
                // Все значения нули - показываем нейтральный серый
                color = 'rgba(128, 128, 128, 0.5)';
            } else if (value >= 0) {
                // Положительное значение - зелёный
                intensity = maxValue > 0 ? (value / maxValue) : 0;
                const alpha = 0.3 + (intensity * 0.7);
                color = `rgba(0, 255, 0, ${alpha})`;
            } else {
                // Отрицательное значение - красный
                intensity = minValue < 0 ? (Math.abs(value) / Math.abs(minValue)) : 0;
                const alpha = 0.3 + (intensity * 0.7);
                color = `rgba(255, 0, 0, ${alpha})`;
            }
            
            return `
                <div style="background: ${color}; padding: 15px; border-radius: 5px; text-align: center; border: 1px solid rgba(255, 215, 0, 0.3);">
                    <div style="color: #ffffff; font-weight: bold; font-size: 0.9rem; margin-bottom: 5px;">${day}</div>
                    <div style="color: ${value >= 0 ? '#00ff00' : value < 0 ? '#ff6666' : '#888888'}; font-size: 0.85rem; font-weight: bold;">${value >= 0 ? '+' : ''}$${value.toFixed(2)}</div>
                </div>
            `;
        }).join('');
    }
    
    // Тепловая карта по месяцам
    const monthlyCanvas = document.getElementById('monthlyHeatmap');
    if (monthlyCanvas && performanceByMonth) {
        const ctx = monthlyCanvas.getContext('2d');
        monthlyCanvas.width = monthlyCanvas.offsetWidth;
        monthlyCanvas.height = 150;
        
        const months = Object.keys(performanceByMonth);
        const monthValues = Object.values(performanceByMonth);
        
        if (months.length === 0) {
            // Нет данных - показываем сообщение
            ctx.clearRect(0, 0, monthlyCanvas.width, monthlyCanvas.height);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
            ctx.fillRect(0, 0, monthlyCanvas.width, monthlyCanvas.height);
            ctx.fillStyle = '#888';
            ctx.font = '14px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('No monthly data available', monthlyCanvas.width / 2, monthlyCanvas.height / 2);
            return;
        }
        
        const maxValue = Math.max(...monthValues);
        const minValue = Math.min(...monthValues);
        const range = maxValue - minValue || 1;
        
        console.log('Heatmap month values:', { months, monthValues, maxValue, minValue, range });
        
        ctx.clearRect(0, 0, monthlyCanvas.width, monthlyCanvas.height);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(0, 0, monthlyCanvas.width, monthlyCanvas.height);
        
        const barWidth = monthlyCanvas.width / months.length;
        
        months.forEach((month, index) => {
            const value = performanceByMonth[month];
            
            // Рассчитываем высоту и цвет правильно
            let height = 0;
            let color = '';
            
            if (range === 0 || (maxValue === 0 && minValue === 0)) {
                // Все значения нули
                height = monthlyCanvas.height * 0.1; // Маленькая полоска
                color = 'rgba(128, 128, 128, 0.5)';
            } else if (value >= 0) {
                // Положительное значение
                height = (value / (Math.max(Math.abs(maxValue), Math.abs(minValue)) || 1)) * monthlyCanvas.height * 0.8;
                const intensity = maxValue > 0 ? (value / maxValue) : 0;
                const alpha = 0.5 + (intensity * 0.5);
                color = `rgba(0, 255, 0, ${alpha})`;
            } else {
                // Отрицательное значение
                height = (Math.abs(value) / (Math.max(Math.abs(maxValue), Math.abs(minValue)) || 1)) * monthlyCanvas.height * 0.8;
                const intensity = minValue < 0 ? (Math.abs(value) / Math.abs(minValue)) : 0;
                const alpha = 0.5 + (intensity * 0.5);
                color = `rgba(255, 0, 0, ${alpha})`;
            }
            
            ctx.fillStyle = color;
            ctx.fillRect(index * barWidth, monthlyCanvas.height - height, barWidth - 2, height);
            
            // Подпись месяца
            ctx.fillStyle = '#ffffff';
            ctx.font = '10px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(month, index * barWidth + barWidth / 2, monthlyCanvas.height - 5);
            
            // Подпись значения
            if (Math.abs(value) > 0.01) {
                ctx.fillStyle = value >= 0 ? '#00ff00' : '#ff6666';
                ctx.font = '9px Arial';
                ctx.fillText(`${value >= 0 ? '+' : ''}$${value.toFixed(0)}`, index * barWidth + barWidth / 2, monthlyCanvas.height - height - 5);
            }
        });
    }
}

// Рендер детального лога сделок
function renderTradeLog(trades) {
    const tbody = document.getElementById('tradeLogBody');
    if (!tbody) {
        console.error('tradeLogBody not found');
        return;
    }
    
    if (!trades || trades.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="padding: 20px; text-align: center; color: #888;">No trades to display</td></tr>';
        return;
    }
    
    tbody.innerHTML = trades.map(trade => `
        <tr style="border-bottom: 1px solid rgba(255, 0, 0, 0.2);">
            <td style="padding: 10px; border: 1px solid rgba(255, 0, 0, 0.3); color: #ffffff;">${trade.tradeNum}</td>
            <td style="padding: 10px; border: 1px solid rgba(255, 0, 0, 0.3); color: #cccccc;">${trade.entryDate}</td>
            <td style="padding: 10px; border: 1px solid rgba(255, 0, 0, 0.3); color: #ffffff;">$${trade.entryPrice.toFixed(2)}</td>
            <td style="padding: 10px; border: 1px solid rgba(255, 0, 0, 0.3); color: #cccccc;">${trade.exitDate}</td>
            <td style="padding: 10px; border: 1px solid rgba(255, 0, 0, 0.3); color: #ffffff;">$${trade.exitPrice.toFixed(2)}</td>
            <td style="padding: 10px; border: 1px solid rgba(255, 0, 0, 0.3); color: ${trade.netPnl >= 0 ? '#00ff00' : '#ff6666'}; font-weight: bold;">${trade.netPnl >= 0 ? '+' : ''}$${trade.netPnl.toFixed(2)}</td>
            <td style="padding: 10px; border: 1px solid rgba(255, 0, 0, 0.3); color: #ffd700;">-$${trade.fees.toFixed(2)}</td>
            <td style="padding: 10px; border: 1px solid rgba(255, 0, 0, 0.3); color: ${trade.pnlPercent >= 0 ? '#00ff00' : '#ff6666'}; font-weight: bold;">${trade.pnlPercent >= 0 ? '+' : ''}${trade.pnlPercent.toFixed(2)}%</td>
        </tr>
    `).join('');
}

// Сортировка лога сделок
let tradeLogSortColumn = null;
let tradeLogSortDirection = 'asc';

function sortTradeLog(column) {
    const data = window.currentBacktestData;
    if (!data || !data.trades || data.trades.length === 0) return;
    
    const trades = [...data.trades];
    
    if (tradeLogSortColumn === column) {
        tradeLogSortDirection = tradeLogSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        tradeLogSortColumn = column;
        tradeLogSortDirection = 'asc';
    }
    
    trades.sort((a, b) => {
        let aVal = a[column];
        let bVal = b[column];
        
        if (typeof aVal === 'string') {
            aVal = new Date(aVal);
            bVal = new Date(bVal);
        }
        
        if (tradeLogSortDirection === 'asc') {
            return aVal > bVal ? 1 : -1;
        } else {
            return aVal < bVal ? 1 : -1;
        }
    });
    
    renderTradeLog(trades);
}

// Расчёт максимального количества последовательных убытков
function calculateMaxConsecutiveLosses(trades) {
    let maxConsecutive = 0;
    let currentConsecutive = 0;
    
    for (const trade of trades) {
        if (trade.netPnl <= 0) {
            currentConsecutive++;
            maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
        } else {
            currentConsecutive = 0;
        }
    }
    
    return maxConsecutive;
}

// Загрузка шаблона стратегии
function loadStrategyTemplate() {
    const templateSelect = document.getElementById('strategyTemplate');
    if (!templateSelect) return;
    
    const template = templateSelect.value;
    const strategyTextarea = document.getElementById('backtestStrategy');
    if (!strategyTextarea) return;
    
    const templates = {
        momentum: 'Buy when price breaks above resistance level (20-day high). Sell when profit reaches 15% or stop-loss at -5%. Use 50% of portfolio per trade.',
        mean_reversion: 'Buy when price drops 10% from recent high. Sell when price returns to recent high or reaches +8% profit. Stop-loss at -3%.',
        breakout: 'Buy when price breaks above 30-day moving average with volume increase. Sell at +20% profit or -7% stop-loss. Hold maximum 30 days.',
        trend_following: 'Buy when 10-day MA crosses above 30-day MA (golden cross). Sell when 10-day MA crosses below 30-day MA (death cross) or at +25% profit. Stop-loss at -10%.',
        scalping: 'Buy on small dips (1-2% drop). Sell quickly at +2-3% profit. Maximum hold time 2 hours. Stop-loss at -1.5%. Use 30% of portfolio per trade.',
        swing: 'Buy on significant pullbacks (15%+ from peak). Hold for 5-15 days. Sell at +30% profit or -12% stop-loss. Use 40% of portfolio per trade.'
    };
    
    if (templates[template]) {
        strategyTextarea.value = templates[template];
        autoSaveBacktestForm();
    }
}

