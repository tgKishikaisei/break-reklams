/* Break Reklams — заглушка вместо analytics.js: ga() ничего не отправляет, но вызывает hitCallback, чтобы ссылки и формы работали. */
(function () {
  'use strict';
  const name = window.GoogleAnalyticsObject || 'ga';
  const previous = window[name];
  const queue = previous && Array.isArray(previous.q) ? previous.q.slice() : [];

  const tracker = { get() {}, set() {}, send() {} };
  const later = (fn) => setTimeout(() => {
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  }, 1);

  function run(args) {
    if (typeof args[0] === 'function') {
      const ready = args[0];
      later(() => ready(tracker));
      return;
    }
    for (const arg of args) {
      if (arg && typeof arg === 'object' && typeof arg.hitCallback === 'function') later(arg.hitCallback);
    }
  }

  const ga = function () { run(Array.from(arguments)); };
  ga.create = () => tracker;
  ga.getByName = () => tracker;
  ga.getAll = () => [tracker];
  ga.remove = function () {};
  ga.loaded = true;
  window[name] = ga;
  queue.forEach((args) => run(Array.from(args)));
})();
