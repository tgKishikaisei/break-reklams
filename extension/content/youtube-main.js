/**
 * Break Reklams — YouTube, MAIN-мир (document_start).
 * Вырезает рекламные блоки из ответов плеера до того, как их увидит YouTube:
 * ytInitialPlayerResponse, JSON.parse и Response.json() для /youtubei/v1/player.
 */
(() => {
  'use strict';
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];

  const prune = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 3) return;
    if (Array.isArray(obj)) {
      if (obj.length <= 16) for (const item of obj) prune(item, depth + 1);
      return;
    }
    for (const key of AD_KEYS) if (key in obj) delete obj[key];
    if (obj.playerResponse) prune(obj.playerResponse, depth + 1);
  };

  // 1. Первичный ответ плеера, встроенный в HTML страницы
  let initialResponse;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      enumerable: true,
      get: () => initialResponse,
      set: (value) => {
        prune(value);
        initialResponse = value;
      },
    });
  } catch {
    // свойство уже определено страницей
  }

  // 2. Всё, что разбирается через JSON.parse (в т. ч. response.text() → JSON.parse)
  const nativeParse = JSON.parse;
  JSON.parse = new Proxy(nativeParse, {
    apply(target, self, args) {
      const result = Reflect.apply(target, self, args);
      try {
        prune(result);
      } catch {
        // не мешаем странице
      }
      return result;
    },
  });

  // 3. fetch(...).then(r => r.json())
  const nativeJson = Response.prototype.json;
  Response.prototype.json = new Proxy(nativeJson, {
    apply(target, self, args) {
      return Reflect.apply(target, self, args).then((result) => {
        try {
          prune(result);
        } catch {
          // не мешаем странице
        }
        return result;
      });
    },
  });
})();
