/**
 * Плавный скролл (Lenis) только для страницы монитора.
 * См. анализ medvedevart §6: Lenis опционально; на мобильной и при reduce — нативный скролл.
 */
(function () {
  'use strict';
  if (!document.body.classList.contains('mon-page')) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (window.matchMedia('(max-width: 768px)').matches) return;
  if (typeof Lenis === 'undefined') return;

  var easeOutSoft = function (t) { return 1 - Math.pow(1 - t, 4); };
  var lenis = new Lenis({
    duration: 2.85,
    easing: easeOutSoft,
    orientation: 'vertical',
    gestureOrientation: 'vertical',
    smoothWheel: true,
    wheelMultiplier: 0.42,
    touchMultiplier: 0.92,
    lerp: 0.065,
    autoRaf: true,
  });

  window.__monLenis = lenis;
})();
