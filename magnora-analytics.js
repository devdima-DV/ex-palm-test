/* Magnora funnel analytics — Meta Pixel (browser) + Conversions API (server),
 * deduplicated by a shared event_id. Self-contained, no deps, plain script tag.
 *
 * Pixel id comes from the ?pix= URL param (saved to sessionStorage with the other
 * UTM params), so each ad set can target its own pixel. Access tokens live ONLY on
 * the backend (/api/capi-sender, configured via META_PIXEL_DB). If no pix is
 * present, browser pixel + CAPI are skipped and the funnel still works.
 *
 * Public API:
 *   window.trackFBEvent(eventName, value, customData)   // fires browser + CAPI once
 *   window.getPixelId()
 * Standard value ladder (W2A-158): ViewContent .10, AddToCart .30,
 *   CompleteRegistration .50, Lead 3, InitiateCheckout 10, Purchase 20.
 */
(function () {
  'use strict';
  if (window.__MAGNORA_ANALYTICS__) return;
  window.__MAGNORA_ANALYTICS__ = true;

  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function storedUtm() {
    try { return JSON.parse(sessionStorage.getItem('__utm') || '{}'); } catch (e) { return {}; }
  }
  function getPixelId() {
    var p = new URLSearchParams(window.location.search);
    return p.get('pix') || storedUtm().pix || window.currentPixelId || '';
  }
  window.getPixelId = getPixelId;

  // Install the Meta Pixel base code once (only if a pixel is known and none yet).
  var _pixelInited = '';
  function ensurePixel() {
    var pid = getPixelId();
    if (!pid) return '';
    if (typeof window.fbq !== 'function') {
      /* eslint-disable */
      !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments) }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s) }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
      /* eslint-enable */
    }
    if (_pixelInited !== pid) {
      try { fbq('init', pid); fbq('track', 'PageView'); } catch (e) {}
      _pixelInited = pid;
    }
    return pid;
  }

  // Once-per-funnel dedup flags (survive refresh / back).
  function flagKey(eventName, customData) {
    var base = 'fb_' + eventName.toLowerCase().replace(/[^a-z]/g, '') + '_sent';
    if (eventName === 'Purchase' && customData && customData.payment_method) {
      return 'fb_purchase_' + customData.payment_method + '_sent';
    }
    return base;
  }
  function alreadySent(k) { try { return sessionStorage.getItem(k) === '1'; } catch (e) { return false; } }
  function markSent(k) { try { sessionStorage.setItem(k, '1'); } catch (e) {} }

  var CURRENCY = 'USD';

  function trackFBEvent(eventName, value, customData) {
    customData = customData || {};
    var key = flagKey(eventName, customData);
    if (alreadySent(key)) return;
    markSent(key);

    var pixelId = ensurePixel();
    var eventId = 'magnora_' + eventName.toLowerCase() + '_' + Date.now() + '_' + Math.floor(Math.random() * 1e5);
    var utm = storedUtm();
    var payload = Object.assign({ variant: (window.MAGNORA_VARIANT || ''), value: value, currency: CURRENCY }, customData, {
      utm_source: utm.utm_source || '', utm_campaign: utm.utm_campaign || '',
    });

    // Browser Pixel
    try { if (typeof window.fbq === 'function') fbq('track', eventName, { value: value, currency: CURRENCY }, { eventID: eventId }); } catch (e) {}

    // Server CAPI (same event_id → Meta dedups). Skip if no pixel.
    if (!pixelId) return;
    try {
      fetch('/api/capi-sender', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pixelId: pixelId, eventName: eventName, eventId: eventId, value: value, currency: CURRENCY,
          fbp: getCookie('_fbp'), fbc: getCookie('_fbc'),
          eventUrl: window.location.href, userAgent: navigator.userAgent,
          testEventCode: (utm.test_event_code || ''),
          customData: payload,
        }),
      }).catch(function () {});
    } catch (e) {}
  }
  window.trackFBEvent = trackFBEvent;

  // Init the pixel as early as possible so PageView fires.
  ensurePixel();
})();
