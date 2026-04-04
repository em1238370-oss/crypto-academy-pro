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

  var easeOutSoft = function (t) { return 1 - Math.pow(1 - t, 3); };
  var lenis = new Lenis({
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

  window.__monLenis = lenis;
})();
