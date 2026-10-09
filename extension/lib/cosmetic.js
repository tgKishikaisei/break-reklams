/**
 * Break Reklams — движок косметической фильтрации (работает в service worker).
 * По имени хоста подбирает CSS для скрытия рекламы; общие «ключевые» селекторы
 * (.ad-banner, #ad_box …) отдаются лениво — только когда на странице появился такой класс/id.
 */

const STYLE_SUFFIX_RE = /^(.*?):style\((.*)\)$/;

function importantize(css) {
  return css
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (/!\s*important$/i.test(d) ? d : `${d} !important`))
    .join(';');
}

/** Превращает записи фильтров в CSS: одно правило на селектор, чтобы ошибка в одном не ломала остальные. */
export function entriesToCSS(entries) {
  const parts = [];
  for (const entry of entries) {
    const m = STYLE_SUFFIX_RE.exec(entry);
    parts.push(m ? `${m[1]}{${importantize(m[2])}}` : `${entry}{display:none!important}`);
  }
  return parts.join('\n');
}

/** true для записей, которые прячут элемент (а не меняют его стиль). */
export const isHidingEntry = (entry) => !STYLE_SUFFIX_RE.test(entry);

/**
 * Все ключи, по которым для хоста могут быть записаны фильтры:
 * `a.b.example.co.uk` → `a.b.example.co.uk`, `b.example.co.uk`, …, а также сущности вида `example.*`.
 */
export function hostCandidates(hostname) {
  const labels = hostname.split('.');
  const out = [];
  for (let i = 0; i < labels.length; i++) out.push(labels.slice(i).join('.'));
  for (let i = 0; i < labels.length - 1; i++) {
    for (let tail = 1; tail <= 2 && i + tail < labels.length; tail++) {
      out.push(`${labels.slice(i, labels.length - tail).join('.')}.*`);
    }
  }
  return out;
}

export class CosmeticEngine {
  /** @param {Array<object|null>} datasets — результаты compileCosmetic() */
  constructor(datasets) {
    this.sets = datasets.filter(Boolean).map((d) => ({
      keyed: d.generic?.keyed || {},
      broad: d.generic?.broad || [],
      specific: d.specific || {},
      exceptions: d.exceptions || {},
      noGeneric: new Set(d.noGeneric || []),
      noSpecific: new Set(d.noSpecific || []),
      noCosmetic: new Set(d.noCosmetic || []),
    }));
    this.cache = new Map();
  }

  /** Анализ хоста (кешируется): исключения, запреты и специфичные для сайта записи. */
  analyze(hostname) {
    const cached = this.cache.get(hostname);
    if (cached) return cached;

    const candidates = hostCandidates(hostname);
    const excepted = new Set();
    let noGeneric = false;
    let noSpecific = false;
    let noCosmetic = false;
    for (const s of this.sets) {
      for (const c of candidates) {
        const ex = s.exceptions[c];
        if (ex) for (const e of ex) excepted.add(e);
        if (s.noGeneric.has(c)) noGeneric = true;
        if (s.noSpecific.has(c)) noSpecific = true;
        if (s.noCosmetic.has(c)) noCosmetic = true;
      }
    }

    const specific = [];
    if (!noCosmetic && !noSpecific) {
      const seen = new Set();
      for (const s of this.sets) {
        for (const c of candidates) {
          const list = s.specific[c];
          if (!list) continue;
          for (const e of list) {
            if (!excepted.has(e) && !seen.has(e)) {
              seen.add(e);
              specific.push(e);
            }
          }
        }
      }
    }

    const result = { excepted, specific, noGeneric: noGeneric || noCosmetic, noCosmetic };
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(hostname, result);
    return result;
  }

  /** Записи, которые нужно внедрить сразу при загрузке страницы. */
  forHost(hostname) {
    const a = this.analyze(hostname);
    const entries = [...a.specific];
    if (!a.noGeneric) {
      for (const s of this.sets) for (const e of s.broad) if (!a.excepted.has(e)) entries.push(e);
    }
    return { entries, generic: !a.noGeneric };
  }

  /** Записи для классов/id, найденных на странице (`.ad-banner`, `#ad_box`). */
  forTokens(hostname, tokens) {
    const a = this.analyze(hostname);
    if (a.noGeneric) return [];
    const out = [];
    for (const token of tokens) {
      for (const s of this.sets) {
        const list = s.keyed[token];
        if (list) for (const e of list) if (!a.excepted.has(e)) out.push(e);
      }
    }
    return out;
  }
}
