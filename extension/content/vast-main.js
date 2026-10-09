/**
 * Break Reklams — реклама в видеоплеерах (MAIN-мир, все фреймы, document_start).
 * Почти все плееры (Kodik, Alloha, Collaps, Plyr/Video.js + IMA и т. д.) берут рекламные ролики
 * по стандарту VAST/VMAP — XML-ответом от рекламного сервера. Домены таких серверов постоянно
 * меняются, поэтому перехватываем сам ответ: если это VAST с рекламой, плеер получает пустой
 * VAST («рекламы нет») и сразу запускает видео.
 */
(() => {
  'use strict';
  const EMPTY_VAST = '<?xml version="1.0" encoding="UTF-8"?><VAST version="3.0"></VAST>';
  const EMPTY_VMAP = '<?xml version="1.0" encoding="UTF-8"?><vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0"></vmap:VMAP>';
  // \s в регулярках JS захватывает и BOM (U+FEFF) в начале ответа.
  const PROLOG_RE = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*/;

  /** Пустой VAST/VMAP вместо рекламного ответа; null — если это не реклама. */
  function neutralize(text) {
    if (typeof text !== 'string' || text.length < 16) return null;
    let i = 0;
    while (i < text.length && i < 64 && (text.charCodeAt(i) <= 32 || text.charCodeAt(i) === 0xfeff)) i++;
    const c = text[i];
    if (c !== '<') return null;
    const head = text.slice(0, 2048).replace(PROLOG_RE, '');
    if (/^<VAST[\s>]/i.test(head)) return /<Ad[\s>]/i.test(text) ? EMPTY_VAST : null;
    if (/^<(?:vmap:)?VMAP[\s>]/i.test(head)) return /<(?:vmap:)?AdBreak[\s>]/i.test(text) ? EMPTY_VMAP : null;
    return null;
  }

  const parseXML = (text) => new DOMParser().parseFromString(text, 'text/xml');

  // ─── XMLHttpRequest ─────────────────────────────────────────────────────────
  const proto = XMLHttpRequest.prototype;
  const nativeState = Object.getOwnPropertyDescriptor(proto, 'readyState').get;
  const nativeType = Object.getOwnPropertyDescriptor(proto, 'responseType').get;
  const textDesc = Object.getOwnPropertyDescriptor(proto, 'responseText');
  const responseDesc = Object.getOwnPropertyDescriptor(proto, 'response');
  const xmlDesc = Object.getOwnPropertyDescriptor(proto, 'responseXML');
  const verdicts = new WeakMap();

  function replacementFor(xhr) {
    if (verdicts.has(xhr)) return verdicts.get(xhr);
    if (nativeState.call(xhr) !== 4) return null;
    let out = null;
    try {
      const type = nativeType.call(xhr);
      if (type === '' || type === 'text') {
        out = neutralize(textDesc.get.call(xhr));
      } else if (type === 'document') {
        const doc = responseDesc.get.call(xhr);
        const root = doc && doc.documentElement;
        if (root && /^VAST$/i.test(root.nodeName) && doc.getElementsByTagName('Ad').length) out = EMPTY_VAST;
      }
    } catch {
      out = null;
    }
    verdicts.set(xhr, out);
    return out;
  }

  // Прокси над родными функциями: toString() у них по-прежнему «[native code]».
  const wrapGetter = (native, handler) => new Proxy(native, { apply: (target, self, args) => handler(self, () => Reflect.apply(target, self, args)) });

  Object.defineProperty(proto, 'responseText', {
    ...textDesc,
    get: wrapGetter(textDesc.get, (xhr, original) => replacementFor(xhr) ?? original()),
  });
  Object.defineProperty(proto, 'response', {
    ...responseDesc,
    get: wrapGetter(responseDesc.get, (xhr, original) => {
      const r = replacementFor(xhr);
      if (r === null) return original();
      return nativeType.call(xhr) === 'document' ? parseXML(r) : r;
    }),
  });
  Object.defineProperty(proto, 'responseXML', {
    ...xmlDesc,
    get: wrapGetter(xmlDesc.get, (xhr, original) => {
      const r = replacementFor(xhr);
      return r === null ? original() : parseXML(r);
    }),
  });
  // XHR можно переиспользовать: при новом open() забываем прошлый вердикт.
  proto.open = new Proxy(proto.open, {
    apply(target, xhr, args) {
      verdicts.delete(xhr);
      return Reflect.apply(target, xhr, args);
    },
  });

  // ─── fetch ──────────────────────────────────────────────────────────────────
  const responseProto = Response.prototype;
  responseProto.text = new Proxy(responseProto.text, {
    apply(target, self, args) {
      return Reflect.apply(target, self, args).then((text) => neutralize(text) ?? text);
    },
  });
})();
