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

  var lenis = new Lenis({
    duration: 1.35,
    easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
    orientation: 'vertical',
    gestureOrientation: 'vertical',
    smoothWheel: true,
    wheelMultiplier: 0.78,
    touchMultiplier: 1.2,
    autoRaf: true,
  });

  window.__monLenis = lenis;
})();
