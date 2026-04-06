/**
 * Плавный скролл для /monitor (колёсико + тач). Множители ~×10 к ранним значениям — нормальная скорость на телефоне.
 */
(function () {
  'use strict';
  if (!document.body.classList.contains('mon-page')) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.__MON_SCROLL_MODE__ = 'reduced';
    return;
  }

  function maxScrollY() {
    return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  }

  function initWheelSmoothFallback() {
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
    window.__MON_SCROLL_MODE__ = 'fallback';
    window.__monLenisFallback = true;
  }

  if (typeof Lenis === 'undefined') {
    initWheelSmoothFallback();
    return;
  }

  var lenis = new Lenis({
    orientation: 'vertical',
    gestureOrientation: 'vertical',
    smoothWheel: true,
    syncTouch: true,
    syncTouchLerp: 0.55,
    wheelMultiplier: 0.4,
    touchMultiplier: 1.4,
    lerp: 0.04,
    autoRaf: false,
  });

  function raf(time) {
    lenis.raf(time);
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);

  window.__monLenis = lenis;
  window.__MON_SCROLL_MODE__ = 'lenis';
})();
