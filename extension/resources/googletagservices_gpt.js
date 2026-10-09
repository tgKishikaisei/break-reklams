/* Break Reklams — заглушка вместо Google Publisher Tag (gpt.js): API есть, рекламы нет. */
(function () {
  'use strict';
  const noop = function () {};
  const noopThis = function () { return this; };
  const noopNull = function () { return null; };
  const noopArray = function () { return []; };
  const noopString = function () { return ''; };

  function Slot(path, divId) {
    this._path = path || '';
    this._div = divId || '';
  }
  for (const name of [
    'addService', 'clearCategoryExclusions', 'clearTargeting', 'defineSizeMapping', 'set', 'setCategoryExclusion',
    'setClickUrl', 'setCollapseEmptyDiv', 'setConfig', 'setForceSafeFrame', 'setSafeFrameConfig', 'setTargeting',
    'updateTargetingFromMap',
  ]) Slot.prototype[name] = noopThis;
  Object.assign(Slot.prototype, {
    get: noopNull,
    getAdUnitPath() { return this._path; },
    getAttributeKeys: noopArray,
    getCategoryExclusions: noopArray,
    getConfig: noopNull,
    getDomId() { return this._div; },
    getResponseInformation: noopNull,
    getSizes: noopArray,
    getSlotElementId() { return this._div; },
    getSlotId() { return this; },
    getTargeting: noopArray,
    getTargetingKeys: noopArray,
    getTargetingMap() { return {}; },
  });

  const pubads = {
    addEventListener: noopThis, clear: noop, clearCategoryExclusions: noopThis, clearTagForChildDirectedTreatment: noopThis,
    clearTargeting: noopThis, collapseEmptyDivs: noop, defineOutOfPagePassback: () => new Slot(), definePassback: () => new Slot(),
    disableInitialLoad: noop, display: noop, enableAsyncRendering: noop, enableLazyLoad: noop, enableSingleRequest: noop,
    enableSyncRendering: noop, enableVideoAds: noop, get: noopNull, getAttributeKeys: noopArray, getSlots: noopArray,
    getTargeting: noopArray, getTargetingKeys: noopArray, isInitialLoadDisabled: () => true, refresh: noop,
    removeEventListener: noopThis, set: noopThis, setCategoryExclusion: noopThis, setCentering: noop, setCookieOptions: noopThis,
    setForceSafeFrame: noopThis, setLocation: noopThis, setPrivacySettings: noopThis, setPublisherProvidedId: noopThis,
    setRequestNonPersonalizedAds: noopThis, setSafeFrameConfig: noopThis, setTagForChildDirectedTreatment: noopThis,
    setTargeting: noopThis, setVideoContent: noopThis, updateCorrelator: noop,
  };
  const companionAds = { addEventListener: noopThis, enableSyncLoading: noop, setRefreshUnfilledSlots: noop };
  const content = { addEventListener: noopThis, setContent: noop };

  const run = (fn) => {
    try {
      if (typeof fn === 'function') fn.call(window);
    } catch (err) {
      console.error(err);
    }
  };

  const googletag = window.googletag || {};
  const queued = Array.isArray(googletag.cmd) ? googletag.cmd.slice() : [];
  Object.assign(googletag, {
    apiReady: true,
    pubadsReady: true,
    cmd: { push(...fns) { fns.forEach(run); return 1; } },
    companionAds: () => companionAds,
    content: () => content,
    defineOutOfPageSlot: (path, divId) => new Slot(path, typeof divId === 'string' ? divId : ''),
    defineSlot: (path, _sizes, divId) => new Slot(path, divId),
    destroySlots: () => true,
    disablePublisherConsole: noop,
    display: noop,
    enableServices: noop,
    enums: { OutOfPageFormat: { TOP_ANCHOR: 2, BOTTOM_ANCHOR: 3, REWARDED: 4, INTERSTITIAL: 5, LEFT_SIDE_RAIL: 8, RIGHT_SIDE_RAIL: 9 } },
    getConfig: noopNull,
    getVersion: noopString,
    openConsole: noop,
    pubads: () => pubads,
    setAdIframeTitle: noop,
    setConfig: noop,
    sizeMapping() {
      const builder = { addSize: () => builder, build: noopNull };
      return builder;
    },
  });
  window.googletag = googletag;
  queued.forEach(run);
})();
