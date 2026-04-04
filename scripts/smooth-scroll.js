/**
 * Плавный скролл с инерцией (Lenis)
 * Когда пользователь быстро листает — страница плавно «догоняет» с замедлением
 */
(function() {
    'use strict';

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function initLenis() {
        if (prefersReducedMotion || typeof Lenis === 'undefined') return null;
        // На мобильной — только нативный скролл, чтобы можно было сразу листать вниз без нажатия на кнопку
        if (window.matchMedia('(max-width: 768px)').matches) return null;

        // Нежный, чуть более медленный скролл вниз/вверх (колёсико и трекпад)
        const easeOutSoft = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic — мягче экспоненты по умолчанию
        const lenis = new Lenis({
            duration: 2.05,
            easing: easeOutSoft,
            orientation: 'vertical',
            gestureOrientation: 'vertical',
            smoothWheel: true,
            wheelMultiplier: 0.58,
            touchMultiplier: 1.05,
            lerp: 0.085,
            autoRaf: true,
        });

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
