/* Break Reklams — заглушка вместо FuckAdBlock / BlockAdBlock: детектор всегда отвечает «блокировщика нет». */
(function () {
  'use strict';
  function Detector() {}
  const later = (fn) => {
    if (typeof fn === 'function') setTimeout(fn, 1);
  };
  Object.assign(Detector.prototype, {
    check() { return true; },
    clearEvent() {},
    emitEvent() { return this; },
    on(detected, fn) {
      if (!detected) later(fn);
      return this;
    },
    onDetected() { return this; },
    onNotDetected(fn) {
      later(fn);
      return this;
    },
    setOption() { return this; },
    options: { set() {}, get() {} },
  });
  const instance = new Detector();
  for (const name of ['FuckAdBlock', 'BlockAdBlock', 'SniffAdBlock']) window[name] = Detector;
  for (const name of ['fuckAdBlock', 'blockAdBlock', 'sniffAdBlock']) window[name] = instance;
})();
