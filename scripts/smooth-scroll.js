/**
 * Плавный скролл с инерцией (Lenis)
 * Когда пользователь быстро листает — страница плавно «догоняет» с замедлением
 */
(function() {
    'use strict';

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function initLenis() {
        if (prefersReducedMotion || typeof Lenis === 'undefined') return null;

        const lenis = new Lenis({
            duration: 1.4,        // Длительность «догоняния» — чем больше, тем медленнее
            easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
            orientation: 'vertical',
            gestureOrientation: 'vertical',
            smoothWheel: true,
            wheelMultiplier: 0.8,  // Чуть приглушаем скорость колёсика
            touchMultiplier: 1.2,
            autoRaf: true,
        });

        return lenis;
    }

    function initScrollReveal() {
        if (prefersReducedMotion) return;

        const sections = document.querySelectorAll(
            '.main-text-section, .trust-stats, .mission-section, .explore-section'
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
