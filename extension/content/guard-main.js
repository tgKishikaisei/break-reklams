/**
 * Break Reklams — защита от всплывающей рекламы (MAIN-мир, все фреймы, document_start).
 *  • window.open на известные поп-андер сети → отказ;
 *  • window.open из-за клика по невидимому слою на всю страницу («кликджекинг») → отказ и слой удаляется;
 *  • клик по прозрачной ссылке-оверлею с target=_blank на чужой сайт → отменяется.
 */
(() => {
  'use strict';
  // Никаких меток в window: сайт не должен по ним узнать о блокировщике.
  const POPUP_HOSTS = [
    'popads.net', 'popcash.net', 'propellerads.com', 'adsterra.com', 'exoclick.com', 'juicyads.com',
    'clickadu.com', 'hilltopads.net', 'adcash.com', 'onclickads.net', 'galaksion.com', 'tsyndicate.com',
    'trafficjunky.net', 'a-ads.com',
  ];

  const isAdUrl = (url) => {
    try {
      const host = new URL(url, location.href).hostname;
      return POPUP_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
      return false;
    }
  };

  /** Невидимый слой на пол-экрана и больше. */
  const isInvisibleOverlay = (el) => {
    if (!(el instanceof Element)) return false;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 0.4 * innerWidth * innerHeight) return false;
    if (parseFloat(cs.opacity) < 0.1) return true;
    return cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.backgroundImage === 'none'
      && !(el.textContent || '').trim() && !el.querySelector('img, video, canvas, svg, iframe');
  };

  const findOverlay = (el) => {
    for (let n = el, depth = 0; n instanceof Element && depth < 4; n = n.parentElement, depth++) {
      if (isInvisibleOverlay(n)) return n;
    }
    return null;
  };

  let lastDown = null;
  addEventListener('pointerdown', (e) => { lastDown = { el: e.target, time: performance.now() }; }, true);

  addEventListener('click', (e) => {
    const link = e.target instanceof Element ? e.target.closest('a[target="_blank"], a[target="_new"]') : null;
    if (!link || !isInvisibleOverlay(link)) return;
    try {
      if (new URL(link.href, location.href).origin === location.origin) return;
    } catch {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    link.remove();
  }, true);

  const nativeOpen = window.open;
  const guardedOpen = new Proxy(nativeOpen, {
    apply(target, self, args) {
      const url = args.length && args[0] != null ? String(args[0]) : '';
      if (url && isAdUrl(url)) return null;
      if (lastDown && performance.now() - lastDown.time < 1500) {
        const overlay = findOverlay(lastDown.el);
        if (overlay) {
          lastDown = null;
          overlay.remove();
          return null;
        }
      }
      return Reflect.apply(target, self, args);
    },
  });
  try {
    Object.defineProperty(window, 'open', { value: guardedOpen, writable: true, configurable: true, enumerable: true });
  } catch {
    window.open = guardedOpen;
  }
})();
