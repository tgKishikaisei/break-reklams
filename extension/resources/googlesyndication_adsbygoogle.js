/* Break Reklams — заглушка вместо adsbygoogle.js: страница думает, что реклама загрузилась, но показывать нечего. */
(function () {
  'use strict';
  const markSlots = () => {
    for (const ins of document.querySelectorAll('ins.adsbygoogle:not([data-adsbygoogle-status])')) {
      ins.setAttribute('data-adsbygoogle-status', 'done');
      ins.setAttribute('data-ad-status', 'unfilled');
    }
  };
  const stub = {
    loaded: true,
    push() {
      markSlots();
    },
  };
  try {
    Object.defineProperty(window, 'adsbygoogle', { configurable: true, get: () => stub, set() {} });
  } catch {
    window.adsbygoogle = stub;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', markSlots, { once: true });
  else markSlots();
})();
