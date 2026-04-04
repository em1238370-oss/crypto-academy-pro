/**
 * Плавный скролл (Lenis) только для страницы монитора.
 * См. анализ medvedevart §6: Lenis опционально; на мобильной и при reduce — нативный скролл.
 */
(function () {
  'use strict';
  if (!document.body.classList.contains('mon-page')) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (window.matchMedia('(max-width: 480px)').matches) return;
  if (typeof Lenis === 'undefined') return;

  var lenis = new Lenis({
    orientation: 'vertical',
    gestureOrientation: 'vertical',
    smoothWheel: true,
    wheelMultiplier: 0.22,
    touchMultiplier: 0.78,
    lerp: 0.022,
    autoRaf: true,
  });

  window.__monLenis = lenis;
})();
