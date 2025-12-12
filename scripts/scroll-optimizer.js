// Критическая оптимизация производительности при скролле
(function() {
    let isScrolling = false;
    let scrollTimeout;
    let rafId = null;
    const animatedElements = document.querySelectorAll('.crypto-background-elements > *');
    const body = document.body;
    
    function pauseAllAnimations() {
        // Полностью отключаем все анимации
        animatedElements.forEach(el => {
            if (el) {
                el.style.animationPlayState = 'paused';
                el.style.willChange = 'auto';
                el.style.pointerEvents = 'none';
            }
        });
        
        // Добавляем класс для CSS оптимизации
        body.classList.add('scrolling');
    }
    
    function resumeAnimations() {
        animatedElements.forEach(el => {
            if (el) {
                el.style.animationPlayState = 'running';
                el.style.willChange = 'transform';
                el.style.pointerEvents = '';
            }
        });
        
        body.classList.remove('scrolling');
    }
    
    function handleScroll() {
        if (!isScrolling) {
            isScrolling = true;
            pauseAllAnimations();
        }
        
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(function() {
            isScrolling = false;
            resumeAnimations();
        }, 300);
    }
    
    // Используем requestAnimationFrame для плавности
    let ticking = false;
    window.addEventListener('scroll', function() {
        if (!ticking) {
            window.requestAnimationFrame(function() {
                handleScroll();
                ticking = false;
            });
            ticking = true;
        }
    }, { passive: true });
    
    // Убираем ВСЕ лишние элементы при загрузке
    function removeAllHeavyElements() {
        const elementsToRemove = document.querySelectorAll(`
            .crypto-connection,
            .blockchain-block,
            .crypto-particle,
            .crypto-glow-circle,
            .crypto-pulse-ring,
            .crypto-coin,
            .crypto-orb.orb-3
        `);
        
        elementsToRemove.forEach(el => {
            if (el) {
                el.style.display = 'none';
                el.remove();
            }
        });
        
        // Отключаем все анимации
        const allAnimated = document.querySelectorAll('.crypto-background-elements > *');
        allAnimated.forEach(el => {
            if (el && el.style) {
                el.style.animation = 'none';
                el.style.willChange = 'auto';
            }
        });
    }
    
    // Выполняем при загрузке
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', removeAllHeavyElements);
    } else {
        removeAllHeavyElements();
    }
})();

