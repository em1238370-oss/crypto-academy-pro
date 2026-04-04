/**
 * Плавный скролл (Lenis) для /monitor — локальный бандл, явный RAF, запас без Lenis.
 */
(function () {
  'use strict';
  if (!document.body.classList.contains('mon-page')) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (window.matchMedia('(max-width: 480px)').matches) return;

  function maxScrollY() {
    return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  }

  function initWheelSmoothFallback() {
    var targetY = window.pageYOffset || 0;
    var running = false;
    var wheelGain = 0.26;
    var smooth = 0.11;

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
    wheelMultiplier: 0.2,
    touchMultiplier: 0.72,
    lerp: 0.019,
    autoRaf: false,
  });

  function raf(time) {
    lenis.raf(time);
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);

  window.__monLenis = lenis;
})();
