/**
 * Плавный скролл: Lenis с локального бандла + гарантированный RAF.
 * Если Lenis не загрузился — запасной wheel-сглаживатель (тот же эффект «едет медленно»).
 */
(function () {
    'use strict';

    var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var narrowPhone = window.matchMedia('(max-width: 480px)').matches;

    function maxScrollY() {
        return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    }

    /** Запас, если нет Lenis: перехват wheel + инерция к targetY */
    function initWheelSmoothFallback() {
        if (prefersReducedMotion || narrowPhone) return;
        var targetY = window.pageYOffset || 0;
        var running = false;
        /* ~5× медленнее: меньший шаг от колёса + дольше «догон» к цели */
        var wheelGain = 0.052;
        var smooth = 0.022;

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
        window.__KRO_SCROLL_FALLBACK__ = true;
    }

    function initLenis() {
        if (prefersReducedMotion) return null;
        if (narrowPhone) return null;
        if (typeof Lenis === 'undefined') {
            initWheelSmoothFallback();
            return null;
        }

        /* ~5× медленнее листание вверх/вниз: слабее импульс колёса + плавнее догон */
        var lenis = new Lenis({
            orientation: 'vertical',
            gestureOrientation: 'vertical',
            smoothWheel: true,
            wheelMultiplier: 0.04,
            touchMultiplier: 0.14,
            lerp: 0.004,
            autoRaf: false,
        });

        function raf(time) {
            lenis.raf(time);
            requestAnimationFrame(raf);
        }
        requestAnimationFrame(raf);

        window.__KRO_LENIS__ = lenis;
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
