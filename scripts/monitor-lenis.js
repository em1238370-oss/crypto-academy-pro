/**
 * Плавный скролл для /monitor (колёсико + тач).
 * На ≤640px: syncTouch, touchMultiplier 1.1 (медленнее 1.6), lerp ~0.125 и мягкая инерция — плавно и спокойно.
 */
(function () {
  'use strict';
  if (!document.body.classList.contains('mon-page')) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.__MON_SCROLL_MODE__ = 'reduced';
    return;
  }

  var isNarrowPhone =
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches;
  var touchMultiplier = isNarrowPhone ? 1.1 : 1.6;
  /* Чуть ниже lerp на десктопе — более «шёлковая» инерция (§5 плавный скролл) */
  var lenisLerp = isNarrowPhone ? 0.125 : 0.065;
  var lenisSyncTouchLerp = isNarrowPhone ? 0.11 : 0.38;
  var lenisTouchInertia = isNarrowPhone ? 1.42 : 1.58;

  function maxScrollY() {
    return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  }

  function initWheelSmoothFallback() {
    var targetY = window.pageYOffset || 0;
    var running = false;
    var wheelGain = 0.65;
    var smooth = 0.19;

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

  var lenisOpts = {
    orientation: 'vertical',
    gestureOrientation: 'vertical',
    smoothWheel: true,
    syncTouch: isNarrowPhone,
    wheelMultiplier: 0.52,
    touchMultiplier: touchMultiplier,
    lerp: lenisLerp,
    autoRaf: false,
  };
  if (isNarrowPhone) {
    lenisOpts.syncTouchLerp = lenisSyncTouchLerp;
    lenisOpts.touchInertiaExponent = lenisTouchInertia;
  }
  var lenis = new Lenis(lenisOpts);

  function raf(time) {
    lenis.raf(time);
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);

  window.__monLenis = lenis;
  window.__MON_SCROLL_MODE__ = 'lenis';
})();
