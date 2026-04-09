/**
 * Плавный скролл: Lenis (колёсико + тач) или запасной wheel.
 * На узком экране (≤640px) touchMultiplier чуть ниже 1.4 — прокрутка немного спокойнее, без сильного «тормоза».
 */
(function () {
    'use strict';

    var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var isNarrowPhone =
        typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches;
    /** Десктоп 1.4; на телефоне 1.05 (~на четверть спокойнее тот же жест). */
    var touchMultiplier = isNarrowPhone ? 1.05 : 1.4;

    function maxScrollY() {
        return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    }

    function initWheelSmoothFallback() {
        if (prefersReducedMotion) return;
        var targetY = window.pageYOffset || 0;
        var running = false;
        var wheelGain = 0.52;
        var smooth = 0.15;

        function clamp() {
            var m = maxScrollY();
            if (targetY < 0) targetY = 0;
            if (targetY > m) targetY = m;
        }

        function tick() {
            var y = window.pageYOffset || 0;
            var d = targetY - y;
            if (Math.abs(d) < 0.45) {
                window.scrollTo(0, targetY);
                running = false;
                return;
            }
            window.scrollTo(0, y + d * smooth);
            requestAnimationFrame(tick);
        }

        function onWheel(e) {
            if (e.ctrlKey) return;
            var t = e.target;
            if (t && t.closest && t.closest('[data-lenis-prevent], [data-lenis-prevent-wheel], textarea, [contenteditable="true"]')) {
                return;
            }
            e.preventDefault();
            targetY += (e.deltaY || 0) * wheelGain;
            clamp();
            if (!running) {
                running = true;
                requestAnimationFrame(tick);
            }
        }

        window.addEventListener('wheel', onWheel, { passive: false });
        window.addEventListener(
            'scroll',
            function () {
                if (!running) targetY = window.pageYOffset || 0;
            },
            { passive: true }
        );
        window.__KRO_SCROLL_MODE__ = 'fallback';
        window.__KRO_SCROLL_FALLBACK__ = true;
    }

    function initLenis() {
        if (prefersReducedMotion) {
            window.__KRO_SCROLL_MODE__ = 'reduced';
            return null;
        }
        if (typeof Lenis === 'undefined') {
            initWheelSmoothFallback();
            return null;
        }

        var lenis = new Lenis({
            orientation: 'vertical',
            gestureOrientation: 'vertical',
            smoothWheel: true,
            syncTouch: true,
            syncTouchLerp: 0.55,
            wheelMultiplier: 0.4,
            touchMultiplier: touchMultiplier,
            lerp: 0.04,
            autoRaf: false,
        });

        function raf(time) {
            lenis.raf(time);
            requestAnimationFrame(raf);
        }
        requestAnimationFrame(raf);

        window.__KRO_LENIS__ = lenis;
        window.__KRO_SCROLL_MODE__ = 'lenis';
        return lenis;
    }

    function initScrollReveal() {
        if (prefersReducedMotion) return;

        var sections = document.querySelectorAll(
            '.main-text-section, .trust-stats, .mission-section, .news-hero, .news-today, .news-trust-stats, .signal-noise, .before-react, .news-sources-section, .editor-lens, .news-row'
        );

        var observer = new IntersectionObserver(
            function (entries) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting) entry.target.classList.add('scroll-revealed');
                });
            },
            {
                threshold: 0.15,
                rootMargin: '0px 0px -40px 0px',
            }
        );

        sections.forEach(function (section) {
            section.classList.add('scroll-reveal');
            observer.observe(section);
        });
    }

    function boot() {
        initLenis();
        initScrollReveal();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
