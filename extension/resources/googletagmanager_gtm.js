/* Break Reklams — заглушка вместо gtm.js / gtag.js: данные никуда не уходят, но eventCallback вызывается, чтобы сайт не «зависал». */
(function () {
  'use strict';
  const later = (fn) => setTimeout(() => {
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  }, 1);

  function handle(item) {
    if (!item || typeof item !== 'object') return;
    // dataLayer.push({ event: '…', eventCallback: fn })
    if (typeof item.eventCallback === 'function') later(item.eventCallback);
    // gtag('event', 'name', { event_callback: fn }) → dataLayer.push(arguments)
    if (typeof item.length === 'number' && item[0] === 'event' && item[2] && typeof item[2].event_callback === 'function') {
      later(item[2].event_callback);
    }
  }

  const names = new Set(['dataLayer']);
  try {
    const src = document.currentScript && document.currentScript.src;
    const custom = src && new URL(src).searchParams.get('l');
    if (custom) names.add(custom);
  } catch {
    // адрес скрипта недоступен — остаёмся с dataLayer
  }

  for (const name of names) {
    if (window[name] === undefined) window[name] = [];
    const layer = window[name];
    if (!Array.isArray(layer) || layer.__brPatched) continue;
    layer.forEach(handle);
    const push = layer.push;
    layer.push = function (...items) {
      items.forEach(handle);
      return push.apply(this, items);
    };
    Object.defineProperty(layer, '__brPatched', { value: true });
  }
  window.google_tag_manager = window.google_tag_manager || {};
})();
