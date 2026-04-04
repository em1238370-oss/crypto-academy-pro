/**
 * Плавный скролл с инерцией (Lenis)
 * Когда пользователь быстро листает — страница плавно «догоняет» с замедлением
 */
(function() {
    'use strict';

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function initLenis() {
        if (prefersReducedMotion || typeof Lenis === 'undefined') return null;
        /* Раньше отключали до 768px — при узком окне на ПК Lenis не работал, «изменений не видно».
           Отключаем только на очень узких экранах (типичный телефон). */
        if (window.matchMedia('(max-width: 480px)').matches) return null;

        /* Режим только lerp (без duration): страница заметно медленнее «догоняет» колёсико/трекпад —
           именно ощущение «листаешь вниз — едет медленно». */
        const lenis = new Lenis({
            orientation: 'vertical',
            gestureOrientation: 'vertical',
            smoothWheel: true,
            wheelMultiplier: 0.22,
            touchMultiplier: 0.78,
            lerp: 0.022,
            autoRaf: true,
        });

        window.__KRO_LENIS__ = lenis;
        return lenis;
    }

    function initScrollReveal() {
        if (prefersReducedMotion) return;

        const sections = document.querySelectorAll(
            '.main-text-section, .trust-stats, .mission-section, .news-hero, .news-today, .news-trust-stats, .signal-noise, .before-react, .news-sources-section, .editor-lens, .news-row'
        );

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('scroll-revealed');
                }
            });
        }, {
            threshold: 0.15,
            rootMargin: '0px 0px -40px 0px'
        });

        sections.forEach(section => {
            section.classList.add('scroll-reveal');
            observer.observe(section);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            initLenis();
            initScrollReveal();
        });
    } else {
        initLenis();
        initScrollReveal();
    }
})();
