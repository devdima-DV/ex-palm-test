/**
 * Magnora funnel connector — real payment + account handoff (replaces the mock
 * in skip-payment.js).
 *
 * What it does, when the funnel reaches its payment screen:
 *   1. Captures the buyer's email (+ optional phone).
 *   2. POST {API}/funnels/start  → backend generates the full reading up front and
 *      returns {session_id, claim_token}.
 *   3. POST {API}/funnels/checkout → backend creates an INACTIVE account and opens
 *      an OdysPay subscription; returns a payment_url.
 *   4. Embeds payment_url in an <iframe allow="payment"> (Apple/Google Pay work).
 *   5. On the iframe's postMessage success → shows the upsell screen; each "Add"
 *      calls POST {API}/funnels/upsell (off-session charge on the saved card).
 *   6. "Continue" → redirects to {SITE}/claim?session=…&token=… where the app
 *      polls, auto-logs-in, and shows everything delivered to the vault.
 *
 * The account is activated, the reading delivered, and the welcome + receipt
 * emails sent by the backend on the OdysPay webhook — never from here. The
 * postMessage is UX-only.
 *
 * ── Per-funnel config (set BEFORE this script loads) ──
 *   <script>window.MAGNORA = {
 *     api:    'https://api.magnora.space/api',   // backend API base
 *     site:   'https://magnora.space',           // app origin for /claim
 *     funnel: 'soulmate-sketch',                 // soulmate-sketch|palm|face|aura|marriage|ex|astrocartography|year_2026
 *     needsPhoto: false,                         // true for palm/face funnels
 *     // OPTIONAL overrides — only needed if the defaults don't capture your funnel:
 *     getAnswers: function(){ return {...} },    // {gender, birth_date, ...}
 *     getPhoto:   function(){ return File|Blob }, // required when needsPhoto
 *   };</script>
 *   <script src="/magnora-connector.js" defer></script>
 *
 * Self-contained, CSP-safe (no inline handlers / external assets).
 */
(function () {
  if (window.__MG_CONNECTOR__) return;          // multi-page funnels load this on every screen
  window.__MG_CONNECTOR__ = true;
  var M = window.MAGNORA || {};
  var CFG = {
    api: (M.api || 'https://magnora.space/api').replace(/\/+$/, ''),
    site: (M.site || 'https://magnora.space').replace(/\/+$/, ''),
    funnel: M.funnel || 'soulmate-sketch',
    needsPhoto: !!M.needsPhoto,
    metaPixelId: (new URLSearchParams(location.search).get('pix')) || M.metaPixelId || '',  // per-campaign pixel: ?pix= overrides the config default
    // Pay-screen detection — same heuristic family as skip-payment.js.
    isPayScreen: M.isPayScreen || function () {
      // Primary: detect the paywall screen by URL (multi-page funnels name it
      // offer/paywall/payment/trial…). Configurable via MAGNORA.payScreenRe.
      var re = M.payScreenRe || /(offer|paywall|payment|trial[a-z]*|checkout|get-?report|prepaywall)/i;
      if (re.test(location.pathname)) return true;
      if (document.getElementById('magnora-payment-modal')) return true;
      var els = document.querySelectorAll('button, a, [role="button"]');
      for (var i = 0; i < els.length; i++) {
        var t = (els[i].textContent || '').trim().toLowerCase();
        if (/get my (results|sketch|reading)|obtener mis resultados|نتائجي|unlock|reveal my/.test(t)) return true;
      }
      return false;
    },
  };

  // QA bypass: ?successpay=1 simulates a successful payment — skips the real
  // OdysPay checkout and jumps straight to the post-payment upsell/claim flow.
  // No backend call and no Purchase tracking, so test hits don't pollute the pixel.
  var SUCCESSPAY = (new URLSearchParams(location.search).get('successpay') === '1');

  var L = (document.documentElement.getAttribute('lang') || location.pathname.split('/')[1] || 'en').slice(0, 2);
  if (['en', 'es', 'ar', 'ro', 'fr', 'de', 'ja'].indexOf(L) < 0) L = 'en';
  var RTL = L === 'ar';

  var T = {
    en: { cont: 'Continue to payment',
          waiting: 'Preparing your reading…', upTitle: 'Add more before you go', add: 'Add', added: 'Added',
          done: 'Get my result ✦', err: 'Something went wrong. Please try again.',
          dsTitle: 'Wait — here’s a one-time discount', dsSub: 'Unlock your reading now at a special price.',
          dsYes: 'Claim my discount', dsNo: 'No thanks, close' },
    es: { cont: 'Continuar al pago',
          waiting: 'Preparando tu lectura…', upTitle: 'Añade más antes de irte', add: 'Añadir', added: 'Añadido',
          done: 'Ver mi resultado ✦', err: 'Algo salió mal. Inténtalo de nuevo.',
          dsTitle: 'Espera — un descuento único', dsSub: 'Desbloquea tu lectura ahora a un precio especial.',
          dsYes: 'Quiero mi descuento', dsNo: 'No, gracias, cerrar' },
    ar: { cont: 'متابعة للدفع',
          waiting: 'نُحضّر قراءتك…', upTitle: 'أضف المزيد قبل المغادرة', add: 'أضف', added: 'أُضيف',
          done: 'احصل على نتيجتي ✦', err: 'حدث خطأ ما. حاول مرة أخرى.',
          dsTitle: 'انتظر — خصم لمرة واحدة', dsSub: 'افتح قراءتك الآن بسعر خاص.',
          dsYes: 'احصل على الخصم', dsNo: 'لا شكرًا، إغلاق' },
    ro: { cont: 'Continuă spre plată',
          waiting: 'Îți pregătim interpretarea…', upTitle: 'Adaugă mai multe înainte să pleci', add: 'Adaugă', added: 'Adăugat',
          done: 'Vezi rezultatul meu ✦', err: 'Ceva nu a mers bine. Te rugăm să încerci din nou.',
          dsTitle: 'Stai — o reducere unică', dsSub: 'Deblochează-ți interpretarea acum la un preț special.',
          dsYes: 'Revendică reducerea', dsNo: 'Nu, mulțumesc, închide' },
    fr: { cont: 'Continuer vers le paiement',
          waiting: 'Préparation de votre lecture…', upTitle: 'Ajoutez-en plus avant de partir', add: 'Ajouter', added: 'Ajouté',
          done: 'Voir mon résultat ✦', err: 'Une erreur est survenue. Veuillez réessayer.',
          dsTitle: 'Attendez — une réduction unique', dsSub: 'Débloquez votre lecture maintenant à un prix spécial.',
          dsYes: 'Obtenir ma réduction', dsNo: 'Non merci, fermer' },
    de: { cont: 'Weiter zur Zahlung',
          waiting: 'Deine Analyse wird vorbereitet…', upTitle: 'Füge mehr hinzu, bevor du gehst', add: 'Hinzufügen', added: 'Hinzugefügt',
          done: 'Mein Ergebnis ansehen ✦', err: 'Etwas ist schiefgelaufen. Bitte versuche es erneut.',
          dsTitle: 'Warte — ein einmaliger Rabatt', dsSub: 'Schalte deine Analyse jetzt zum Sonderpreis frei.',
          dsYes: 'Rabatt sichern', dsNo: 'Nein danke, schließen' },
    ja: { cont: 'お支払いに進む',
          waiting: '鑑定結果を準備しています…', upTitle: 'ご購入前にもう少し追加', add: '追加', added: '追加済み',
          done: '結果を見る ✦', err: '問題が発生しました。もう一度お試しください。',
          dsTitle: 'お待ちください — 一回限りの割引', dsSub: '今だけ特別価格で鑑定結果をアンロック。',
          dsYes: '割引を受け取る', dsNo: 'いいえ、閉じる' },
  }[L];

  // Prices come from the backend (admin-managed). These are display fallbacks only,
  // used until /funnels/pricing responds; the actual charge is always server-side.
  var UPSELLS = [
    { id: 'numerology', price: 3.99, title: 'Numerology Analysis' },
    { id: 'tarot',      price: 3.99, title: 'Tarot Reading' },
    { id: 'palm',       price: 3.99, title: 'Palm Reading' },
    { id: 'spirit',     price: 1.49, title: 'Spirit Animal' },
    { id: 'aura',       price: 1.49, title: 'Aura Colour' },
    { id: 'love',       price: 1.49, title: 'Love Match' },
    { id: 'dream',      price: 1.49, title: 'Dream Decoder' },
    { id: 'lucky',      price: 1.49, title: 'Lucky Day Finder' },
  ];
  var PRICING = null;   // filled from /funnels/pricing on boot

  // ── State (persisted so a reload mid-payment survives) ──
  var SS = window.sessionStorage;
  var session = { id: SS.getItem('mg_session'), token: SS.getItem('mg_token') };
  function saveSession(id, tok) { session.id = id; session.token = tok; try { SS.setItem('mg_session', id); SS.setItem('mg_token', tok); } catch (e) {} }

  // ── Answer capture ──
  // Default: accumulate every option the user taps (question text → answer text)
  // plus any obvious birthday/gender hints. Persisted to sessionStorage so it
  // survives page navigation in multi-page funnels. Override via MAGNORA.getAnswers().
  var captured = (function () { try { return JSON.parse(SS.getItem('mg_captured') || '{}'); } catch (e) { return {}; } })();
  function capture(ev) {
    var t = ev.target.closest && ev.target.closest('button,[role="button"],.option,[data-option]');
    if (!t) return;
    var txt = (t.textContent || '').trim();
    if (!txt || txt.length > 80) return;
    var q = '';
    var head = document.querySelector('h1,h2,[class*="question"],[class*="title"]');
    if (head) q = (head.textContent || '').trim().slice(0, 90);
    if (q) captured[q] = txt;
    var low = txt.toLowerCase();
    if (low === 'male' || low === 'female') captured.gender = low;
    try { SS.setItem('mg_captured', JSON.stringify(captured)); } catch (e) {}
  }
  function answers() {
    if (typeof M.getAnswers === 'function') { try { return M.getAnswers() || {}; } catch (e) {} }
    return captured;
  }

  // ── Tiny DOM helpers ──
  function css() {
    if (document.getElementById('mg-cn-css')) return;
    var s = document.createElement('style'); s.id = 'mg-cn-css';
    // Light theme — matches the funnel paywall (white card, dark text, purple CTA) so the
    // payment window feels native to the funnel, not a foreign dark popup.
    s.textContent =
      '#mg-cn{position:fixed;inset:0;z-index:2147483600;background:rgba(20,16,40,.55);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px;font-family:"Open Sans",system-ui,-apple-system,sans-serif}' +
      // prewarm: overlay is in the DOM (iframe fully loads) but hidden & inert; un-hidden instantly on click
      '#mg-cn.mg-prewarm-hidden{visibility:hidden;opacity:0;pointer-events:none}' +
      '#mg-cn .box{background:#fff;border:1px solid #ece8f3;border-radius:20px;max-width:440px;width:100%;max-height:92vh;overflow:auto;color:#1c1c1c;padding:24px;box-shadow:0 24px 80px rgba(20,16,40,.28)}' +
      // Pay modal: white top bar + close, OdysPay iframe below (80vh), rounded box.
      // Width 520px = the reference Magnora layout (soulmate-sketch etc.): OdysPay renders its
      // WIDE desktop card (full card number, all brand icons, comfortable fields). On desktop
      // this leaves thin dark page-bg bands beside the card (same as every reference funnel);
      // on phones the viewport caps it and OdysPay fills with its mobile layout.
      '#mg-cn .box.mg-pay{max-width:520px;height:82vh;max-height:760px;padding:0;overflow:hidden;display:flex;flex-direction:column;position:relative;background:#fff}' +
      // iframe lives in a wrap and is nudged up 36px so OdysPay's dark top page-padding is
      // cropped and its form sits flush under the bar (no dark seam between bar and form).
      '#mg-cn .mg-pay-wrap{position:relative;flex:1 1 auto;min-height:0;overflow:hidden}' +
      '#mg-cn .box.mg-pay iframe{position:absolute;left:0;top:-36px;width:100%;height:calc(100% + 36px);border:0;display:block;background:#fff}' +
      '#mg-cn .mg-pay-bar{display:flex;align-items:center;justify-content:flex-end;flex:0 0 auto;height:46px;padding:0 12px;background:#fff;border-bottom:1px solid #efecf6}' +
      '#mg-cn .mg-pay-x{border:0;width:34px;height:34px;border-radius:50%;padding:0;font-size:15px;line-height:1;cursor:pointer;background:#1c1430;color:#fff}' +
      // loader over the iframe (below the bar) until OdysPay paints; removed on iframe load
      '#mg-cn .mg-pay-load{position:absolute;left:0;right:0;top:46px;bottom:0;z-index:2;display:flex;align-items:center;justify-content:center;background:#fff}' +
      // Phones: OdysPay renders its full-width MOBILE layout regardless of width, so widen the
      // modal to nearly fill the screen (form fills the wider iframe). The 316px cap is only
      // needed on DESKTOP (to force the mobile layout instead of their narrow centred card).
      '@media (max-width:540px){#mg-cn{padding:9px}#mg-cn .box.mg-pay{max-width:520px;height:86vh;max-height:none}}' +
      '#mg-cn h2{font:700 21px/1.3 "Open Sans",system-ui,sans-serif;margin:0 0 6px;color:#1c1c1c}' +
      '#mg-cn p.sub{margin:0 0 16px;color:#6b6575;font-size:13.5px}' +
      '#mg-cn input{width:100%;box-sizing:border-box;background:#fff;border:1px solid #d8d1e4;border-radius:12px;padding:14px;color:#1c1c1c;font-size:15px;margin-bottom:10px}' +
      '#mg-cn .cta{width:100%;border:0;border-radius:26px;padding:15px;font:700 16px "Open Sans",system-ui;background:linear-gradient(135deg,#7b61ff,#5b3fe0);color:#fff;cursor:pointer;margin-top:6px}' +
      '#mg-cn .cta[disabled]{opacity:.6}' +
      '#mg-cn iframe{width:100%;height:600px;border:0;border-radius:14px;background:#fff}' +
      '#mg-cn .row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid #efecf6}' +
      '#mg-cn .row b{font-weight:700;color:#5b3fe0}' +
      '#mg-cn .addb{border:1px solid #c9bef5;background:transparent;color:#5b3fe0;border-radius:18px;padding:8px 16px;font:600 13px "Open Sans",system-ui;cursor:pointer}' +
      '#mg-cn .addb[disabled]{opacity:1;border-color:#1ca14e;color:#1ca14e}' +
      '#mg-cn .err{color:#ef5350;font-size:13px;margin:8px 0 0;min-height:16px}' +
      '#mg-cn .spin{width:42px;height:42px;border:3px solid #ece8f3;border-top-color:#5b3fe0;border-radius:50%;animation:mgspin 1s linear infinite;margin:18px auto}' +
      '@keyframes mgspin{to{transform:rotate(360deg)}}' +
      // ── downsell: premium dark cosmic Magnora card (overrides the light .box) ──
      '#mg-cn .box.mg-ds{background:radial-gradient(125% 95% at 50% -12%,#271d4c 0%,#16121f 48%,#0b0912 100%);border:1px solid rgba(150,120,230,.30);border-radius:26px;max-width:392px;padding:38px 26px 24px;color:#F3EEE4;text-align:center;position:relative;overflow:hidden;box-shadow:0 34px 100px rgba(18,8,48,.62),inset 0 1px 0 rgba(255,255,255,.06)}' +
      '#mg-cn .mg-ds-glow{position:absolute;top:-70px;left:50%;transform:translateX(-50%);width:240px;height:240px;border-radius:50%;background:radial-gradient(circle,rgba(124,92,255,.55),rgba(124,92,255,0) 66%);pointer-events:none}' +
      '#mg-cn .mg-ds-star{position:relative;font-size:20px;color:#E9C36B;letter-spacing:.35em;margin-bottom:8px}' +
      '#mg-cn .mg-ds-title{position:relative;font-family:"Cormorant Garamond","Cormorant",Georgia,serif;font-weight:600;font-size:30px;line-height:1.14;margin:0 0 9px;color:#F7F2EA}' +
      '#mg-cn .mg-ds-sub{position:relative;font-size:14px;line-height:1.55;color:#B7B0C8;margin:0 auto 20px;max-width:300px}' +
      '#mg-cn .mg-ds-price{position:relative;display:flex;align-items:baseline;justify-content:center;gap:12px;margin:0 0 22px}' +
      '#mg-cn .mg-ds-now{font-family:"Cormorant Garamond","Cormorant",Georgia,serif;font-weight:700;font-size:46px;line-height:1;background:linear-gradient(180deg,#FFE7A6,#F3AE1C);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}' +
      '#mg-cn .mg-ds-was{font-size:18px;color:#78708C;text-decoration:line-through}' +
      '#mg-cn .mg-ds-yes{position:relative;width:100%;border:0;border-radius:16px;padding:16px;font:700 16px "Open Sans",system-ui,sans-serif;color:#fff;cursor:pointer;background:linear-gradient(135deg,#8E6DFF,#5B3FE0);box-shadow:0 14px 38px -12px rgba(124,92,255,.85),inset 0 1px 0 rgba(255,255,255,.28);transition:transform .12s ease}' +
      '#mg-cn .mg-ds-yes:active{transform:translateY(1px)}' +
      '#mg-cn .mg-ds-no{width:100%;margin-top:8px;border:0;background:transparent;color:#8F88A0;font:600 13.5px "Open Sans",system-ui,sans-serif;cursor:pointer;padding:11px}' +
      '#mg-cn .mg-ds-no:hover{color:#B7B0C8}';
    document.head.appendChild(s);
  }
  function overlay() {
    css(); closeOverlay();
    var ov = document.createElement('div'); ov.id = 'mg-cn'; if (RTL) ov.dir = 'rtl';
    var box = document.createElement('div'); box.className = 'box';
    ov.appendChild(box); document.body.appendChild(ov);
    return box;
  }
  function closeOverlay() { var o = document.getElementById('mg-cn'); if (o) o.remove(); }

  // ── Analytics — Yandex goals (rich funnel) + Meta Pixel/CAPI (standard ladder) ──
  function ymId() {
    try { if (window.ym && window.ym.a && window.ym.a[0]) return window.ym.a[0][0]; } catch (e) {}
    return null;
  }
  function getCookie(n) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  // Install the Meta Pixel base code once, if this funnel has a pixel and none is
  // present yet (funnels that already ship fbq keep their own).
  function installPixel() {
    if (!CFG.metaPixelId || typeof window.fbq === 'function') return;
    /* eslint-disable */
    !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments) }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s) }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    try { fbq('init', CFG.metaPixelId); fbq('track', 'PageView'); } catch (e) {}
  }

  // Map connector stages → standard Meta events + their funnel value ladder.
  var META_MAP = { lead: ['Lead', 3.0], register: ['CompleteRegistration', 0.5],
                   initiate: ['InitiateCheckout', 10.0], purchase: ['Purchase', 20.0],
                   view_content: ['ViewContent', 0.1], add_to_cart: ['AddToCart', 0.3] };

  // ── Dedup that survives refresh/back (spec §6). Conversion events fire once per
  // funnel session; upsell Purchase dedups per upsell id. ──
  var DEDUP_EVENTS = { lead: 1, initiate: 1, purchase: 1, view_content: 1, add_to_cart: 1, register: 1 };
  function dedupKey(stage, params) {
    if (stage === 'upsell') return 'fb_purchase_' + ((params && params.id) || 'x') + '_sent';
    return DEDUP_EVENTS[stage] ? ('fb_' + stage + '_sent') : '';
  }
  function alreadySent(k) { try { return SS.getItem(k) === '1'; } catch (e) { return false; } }
  function markSent(k) { try { SS.setItem(k, '1'); } catch (e) {} }

  var META_PREFIX = M.metaPrefix || ('mg_' + CFG.funnel);
  var TEST_EVENT_CODE = M.testEventCode || (new URLSearchParams(location.search).get('test_event_code')) || '';

  // Fire ONE Meta event to both Browser Pixel and CAPI with a shared event_id (Meta dedups).
  // customData = product params (getEventParams) + variant/screen_id/step_index + explicit params.
  function meta(stage, params) {
    if (!CFG.metaPixelId) return;
    params = params || {};
    var cur = (PRICING && PRICING.currency) || 'USD';
    var ev, val;
    if (stage === 'upsell') { ev = 'Purchase'; val = params.value || 0; }
    else { var m = META_MAP[stage]; if (!m) return; ev = m[0]; val = (params.value != null ? params.value : m[1]); }
    var eid = META_PREFIX + '_' + ev.toLowerCase() + '_' + Date.now() + '_' + Math.floor(Math.random() * 1e5);
    var cd = {};
    if (typeof M.getEventParams === 'function') { try { var prod = M.getEventParams() || {}; for (var k in prod) cd[k] = prod[k]; } catch (e) {} }
    cd.variant = CFG.funnel;
    cd.screen_id = params.screen_id || stage;
    for (var p in params) { if (p !== 'value') cd[p] = params[p]; }
    try { if (typeof window.fbq === 'function') fbq('track', ev, { value: val, currency: cur }, { eventID: eid }); } catch (e) {}
    try {
      fetch(CFG.api + '/capi-sender', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pixelId: CFG.metaPixelId, eventName: ev, eventId: eid, value: val, currency: cur,
          fbp: getCookie('_fbp'), fbc: getCookie('_fbc'), eventUrl: location.href, userAgent: navigator.userAgent,
          testEventCode: TEST_EVENT_CODE, customData: cd }),
      }).catch(function () {});
    } catch (e) {}
  }

  function track(stage, params) {
    params = params || {};
    var key = dedupKey(stage, params);
    if (key) { if (alreadySent(key)) return; markSent(key); }      // once per funnel session
    var amount = params.value || 0;
    try {
      meta(stage, params);                                          // Meta (mapped stages only)
      var id = ymId();                                             // Yandex goal (all stages)
      if (id && typeof window.ym === 'function') window.ym(id, 'reachGoal', 'mg_' + stage, params);
      window.dataLayer = window.dataLayer || [];                   // GTM
      window.dataLayer.push({ event: 'mg_' + stage, mg_value: amount, mg_id: params.id || null });
    } catch (e) { /* analytics must never break checkout */ }
  }

  // ── Network ──
  function post(path, body, isForm) {
    return fetch(CFG.api + path, {
      method: 'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? body : JSON.stringify(body),
    }).then(function (r) { if (!r.ok) throw new Error(path + ' ' + r.status); return r.json(); });
  }

  // (No email modal — the funnel already collected the email; see getEmail.)

  var buyer = { email: '', price: null, variant: 'full' };   // remembered so the downsell can re-checkout

  // ── Step 2+3: start (generate) → checkout (account + OdysPay) → payment_url ──
  // Pure data path (no UI). Reused by prewarm, the instant open, and the downsell.
  function doStartCheckout(email, price, variant) {
    var startP = session.id
      ? Promise.resolve({ session_id: session.id, claim_token: session.token })
      : (function () {
          var fd = new FormData();
          fd.append('funnel', CFG.funnel);
          fd.append('answers', JSON.stringify(answers()));
          var photo = (CFG.needsPhoto && typeof M.getPhoto === 'function') ? M.getPhoto() : null;
          if (photo) fd.append('image', photo, 'scan.jpg');
          return post('/funnels/start', fd, true);
        })();
    return startP
      .then(function (s) {
        saveSession(s.session_id, s.claim_token);
        var body = { session_id: s.session_id, claim_token: s.claim_token, email: email, variant: variant || 'full',
                     ui_mode: 'elements' };                // ask OdysPay for Stripe Elements creds (own form)
        if (price) body.price = price;                    // charge the user's selected price
        return post('/funnels/checkout', body);
      })
      // Normalise into one checkout object. Elements creds present → native form; else → iframe.
      .then(function (co) {
        return {
          payment_url: co.payment_url || co.iframe_url || null,
          client_secret: co.stripe_client_secret || null,
          pub_key: co.stripe_publishable_key || null,
          ui_mode: co.stripe_ui_mode || null,
          price: (price == null ? null : price),
        };
      });
  }
  // Downsell re-checkout: its own spinner card → OdysPay iframe.
  function startAndCheckout(email, price, variant) {
    buyer.email = email; buyer.price = price; buyer.variant = variant || 'full';
    var box = overlay();
    box.innerHTML = '<div class="spin"></div><p class="sub" style="text-align:center">' + T.waiting + '</p>';
    doStartCheckout(email, price, variant)
      .then(function (ck) { showPayment(ck); })
      .catch(function () {
        box.innerHTML = '<h2 style="text-align:center">Magnora</h2><p class="err" id="e" style="text-align:center"></p><button class="cta" id="rt"></button>';
        box.querySelector('#e').textContent = T.err;
        var rt = box.querySelector('#rt'); rt.textContent = T.cont;
        rt.addEventListener('click', function () { startAndCheckout(email, price, variant); });
      });
  }

  // ── Step 4: embed the OdysPay payment form (with exit-intent downsell) ──
  var downsellShown = false;
  function payCloseHandler() {
    // No exit-intent downsell on a small trial (≤ $5) — re-offering a higher
    // "discount" price there makes no sense.
    var isTrial = (buyer.price != null && buyer.price <= 5);
    if (!downsellShown && !isTrial) { downsellShown = true; showDownsell(); }   // exit-intent → discount
    else { track('payment_closed'); closeOverlay(); }                            // abandoned
  }
  // White top bar with the close button (reference Magnora modal).
  function addPayBar(box) {
    var bar = document.createElement('div'); bar.className = 'mg-pay-bar';
    var close = document.createElement('button');
    close.className = 'mg-pay-x'; close.textContent = '✕'; close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', payCloseHandler);
    bar.appendChild(close);
    box.appendChild(bar);
  }
  // Loader over the iframe (below the bar); hidden a beat AFTER the iframe `load` (bridging
  // OdysPay's own init spinner) so the buyer never sees two spinners. Capped at 8s.
  function addPayLoader(box) {
    var load = document.createElement('div'); load.className = 'mg-pay-load'; load.innerHTML = '<div class="spin"></div>';
    box.appendChild(load);
    var hidden = false;
    var hide = function () { if (hidden) return; hidden = true; if (load && load.parentNode) load.parentNode.removeChild(load); };
    return { load: load, onIframe: function (f) { f.addEventListener('load', function () { setTimeout(hide, 900); }); setTimeout(hide, 8000); } };
  }
  function buildPayBox(box, url) {
    box.className = 'box mg-pay';
    addPayBar(box);                                // white bar + close (reference)
    var wrap = document.createElement('div'); wrap.className = 'mg-pay-wrap';
    var f = document.createElement('iframe');
    f.setAttribute('allow', 'payment');           // REQUIRED for Apple/Google Pay
    var L = addPayLoader(box);
    L.onIframe(f);
    f.src = url;
    wrap.appendChild(f);
    box.insertBefore(wrap, L.load);                // order: bar, wrap(iframe), loader
    return f;
  }

  // ── Custom native card form via Stripe Elements (OdysPay checkout_ui_mode=elements) ──
  // When /funnels/checkout returns Stripe Elements creds we render OUR OWN Magnora-styled form
  // (no hosted iframe, no dark bands) and confirm via Stripe. If anything is missing or fails,
  // we fall back to the hosted iframe so payment always works.
  var _stripeJsP = null;
  function ensureStripeJs() {
    if (window.Stripe) return Promise.resolve(window.Stripe);
    if (_stripeJsP) return _stripeJsP;
    _stripeJsP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'https://js.stripe.com/dahlia/stripe.js'; s.async = true;   // OdysPay REQUIRES the dahlia build
      s.onload = function () { window.Stripe ? res(window.Stripe) : rej(new Error('no Stripe')); };
      s.onerror = function () { rej(new Error('stripe.js failed')); };
      document.head.appendChild(s);
    });
    return _stripeJsP;
  }
  // Stripe Appearance API — LIGHT/clean checkout (reference: soulmate.magnora.space): white
  // fields, Magnora purple accent, card brand icons shown by the Payment Element itself.
  var MG_APPEARANCE = {
    theme: 'stripe',
    variables: {
      colorPrimary: '#5b3fe0', colorText: '#1c1c1c', colorTextSecondary: '#6b6575',
      colorTextPlaceholder: '#9a93a8', colorDanger: '#e5484d', colorBackground: '#ffffff',
      fontFamily: '"Open Sans", system-ui, sans-serif', borderRadius: '12px', spacingUnit: '4px',
    },
    rules: {
      '.Input': { border: '1px solid #dcd7e6', boxShadow: 'none' },
      '.Input:focus': { border: '1px solid #7b61ff', boxShadow: '0 0 0 3px rgba(123,97,255,0.15)' },
      '.Label': { color: '#6b6575', fontWeight: '600' },
      '.Tab--selected, .Block': { borderColor: '#7b61ff' },
    },
  };
  function ensureElCss() {
    if (document.getElementById('mg-el-css')) return;
    var s = document.createElement('style'); s.id = 'mg-el-css';
    s.textContent =
      '#mg-cn .box.mg-el{position:relative;max-width:440px;width:100%;max-height:94vh;overflow:auto;padding:22px 20px 18px;border-radius:20px;color:#1c1c1c;font-family:"Open Sans",system-ui,sans-serif;background:#fff;box-shadow:0 30px 90px rgba(20,16,40,.35)}' +
      '#mg-cn .mg-el-x{position:absolute;top:16px;right:16px;border:0;width:34px;height:34px;border-radius:50%;background:#1c1430;color:#fff;font-size:14px;line-height:1;cursor:pointer;z-index:4}' +
      '#mg-cn .mg-el-title{text-align:center;font:800 24px/1.25 "Open Sans",system-ui,-apple-system,sans-serif;color:#111;margin:4px 30px 18px}' +
      '#mg-cn .mg-el-express{margin-bottom:12px;min-height:1px}#mg-cn .mg-el-express:empty{display:none;margin:0}' +
      '#mg-cn .mg-el-charge{text-align:center;color:#6b6575;font-size:14px;margin:0 0 16px}#mg-cn .mg-el-charge b{color:#1c1c1c;font-weight:700}' +
      '#mg-cn .mg-el-pe{margin-bottom:2px}' +
      '#mg-cn .mg-el-err{color:#e5484d;font-size:12.5px;min-height:16px;margin:8px 2px 0}' +
      '#mg-cn .mg-el-pay{margin-top:16px;width:100%;height:54px;border:0;border-radius:14px;cursor:pointer;font:700 16px "Open Sans",system-ui,-apple-system,sans-serif;color:#fff;display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,#7b61ff,#5b3fe0);box-shadow:0 10px 26px rgba(91,63,224,.4)}' +
      '#mg-cn .mg-el-pay:disabled{cursor:default;opacity:.7}' +
      '#mg-cn .mg-el-pay:active{transform:translateY(1px)}' +
      '#mg-cn .mg-el-stripe{display:flex;align-items:center;justify-content:center;gap:5px;color:#9a93a8;font-size:11.5px;margin:12px 0 2px}#mg-cn .mg-el-stripe b{color:#6b6575}' +
      '#mg-cn .mg-el-load{position:absolute;inset:0;background:rgba(255,255,255,.92);display:flex;align-items:center;justify-content:center;border-radius:20px;z-index:3}' +
      // Bottom-sheet on phones (reference): full-width, anchored to the bottom, only the top
      // corners rounded. The overlay is set to align-items:flex-end inline in buildElementsForm
      // (survives revealPrewarm clearing the class).
      '@media (max-width:540px){#mg-cn .box.mg-el{max-width:none;width:100%;border-radius:22px 22px 0 0;max-height:94vh;padding:20px 16px calc(18px + env(safe-area-inset-bottom))}#mg-cn .mg-el-load{border-radius:22px 22px 0 0}}';
    document.head.appendChild(s);
  }
  function elAmount(v) { var n = (v == null ? null : Number(v)); return (n != null && isFinite(n)) ? ('$' + n.toFixed(2)) : ''; }
  // Build the Magnora shell, then mount Stripe's PaymentElement + ExpressCheckoutElement into it.
  function buildElementsForm(box, checkout) {
    ensureElCss();
    box.className = 'box mg-el'; box.innerHTML = '';
    var amtStr = elAmount(checkout && checkout.price != null ? checkout.price : buyer.price);
    box.innerHTML =
      '<button class="mg-el-x" aria-label="Close">✕</button>' +
      '<h2 class="mg-el-title">Choose payment method</h2>' +
      '<div id="mg-express" class="mg-el-express"></div>' +
      (amtStr ? '<p class="mg-el-charge">You will be charged only <b>' + amtStr + '</b></p>' : '') +
      '<div id="mg-pe" class="mg-el-pe"></div>' +
      '<div class="mg-el-err" id="mg-el-err"></div>' +
      '<button class="mg-el-pay" id="mg-el-pay">' + (amtStr ? ('Pay ' + amtStr) : 'Pay') + '</button>' +
      '<div class="mg-el-stripe">🔒 Powered by <b>Stripe</b></div>' +
      '<div class="mg-el-load" id="mg-el-load"><div class="spin"></div></div>';
    // Bottom-sheet anchoring on phones — set inline on the overlay so it survives revealPrewarm
    // (which clears the overlay's className). No-op on desktop (stays a centered card).
    try {
      var _ov = box.parentNode;
      if (_ov && _ov.id === 'mg-cn' && window.matchMedia && window.matchMedia('(max-width:540px)').matches) {
        _ov.style.alignItems = 'flex-end'; _ov.style.padding = '0';
      }
    } catch (e) {}
    var closeBtn = box.querySelector('.mg-el-x'); if (closeBtn) closeBtn.addEventListener('click', payCloseHandler);
    var payBtn = box.querySelector('#mg-el-pay');
    var errEl = box.querySelector('#mg-el-err');
    var loadEl = box.querySelector('#mg-el-load');
    function showErr(m) { if (errEl) errEl.textContent = m || ''; }
    function busy(b) { if (payBtn) payBtn.disabled = !!b; }
    function dropLoader() { if (loadEl && loadEl.parentNode) loadEl.parentNode.removeChild(loadEl); }
    var RU = CFG.site + '/claim?session=' + encodeURIComponent(session.id || '') + '&token=' + encodeURIComponent(session.token || '');
    function onPaid() {                              // mirror the iframe postMessage success path
      if (buyer.variant === 'discount') track('downsell_accept', { value: buyer.price });
      track('purchase', { value: buyer.price, screen_id: 'payment_modal' });
      postPaid();
    }
    ensureStripeJs().then(function (Stripe) {
      // Force English regardless of the buyer's device language. locale goes on the Stripe
      // CONSTRUCTOR (verified) — NOT in elementsOptions, where it throws "not an accepted parameter".
      var stripe = Stripe(checkout.pub_key, { locale: 'en' });
      var sdk = stripe.initCheckoutElementsSdk({ clientSecret: checkout.client_secret, elementsOptions: { appearance: MG_APPEARANCE } });
      return sdk.loadActions().then(function (loaded) {
        if (!loaded || loaded.type !== 'success') throw new Error((loaded && loaded.error && loaded.error.message) || 'load failed');
        var actions = loaded.actions;
        function doConfirm(ev) {
          busy(true); showErr('');
          var opts = { returnUrl: RU }; if (ev) opts.expressCheckoutConfirmEvent = ev;
          actions.confirm(opts).then(function (r) {
            if (r && r.error) { showErr(r.error.message || 'Payment failed'); busy(false); return; }
            onPaid();                                // resolved without a redirect → success inline
          }).catch(function (err) { showErr(String(err && err.message || err)); busy(false); });
        }
        try { sdk.createPaymentElement().mount(box.querySelector('#mg-pe')); } catch (e) {}
        try {
          var ece = sdk.createExpressCheckoutElement(); ece.mount(box.querySelector('#mg-express'));
          ece.on('confirm', function (ev) { doConfirm(ev); });
          // Hide the express row when no wallet is available (desktop) so there's no empty bar;
          // on iPhone/Android it shows Apple Pay / Google Pay.
          ece.on('ready', function (e) {
            try {
              var m = e && e.availablePaymentMethods;
              var any = m && (m.applePay || m.googlePay || m.link || m.paypal || (typeof m === 'object' && Object.keys(m).length));
              if (!any) { var xe = box.querySelector('#mg-express'); if (xe) xe.style.display = 'none'; }
            } catch (x) {}
          });
        } catch (e) { var xe = box.querySelector('#mg-express'); if (xe) xe.style.display = 'none'; }
        if (payBtn) payBtn.addEventListener('click', function () { doConfirm(null); });
        dropLoader();
      });
    }).catch(function () {
      // Elements unavailable/failed → seamless fallback to the hosted iframe.
      dropLoader();
      box.className = 'box mg-pay'; box.innerHTML = '';
      buildPayBox(box, checkout && checkout.payment_url);
    });
  }
  // Dispatch: native Elements form if OdysPay returned creds, else the hosted iframe.
  function renderPay(box, checkout) {
    if (checkout && checkout.client_secret && checkout.pub_key) { buildElementsForm(box, checkout); return; }
    box.className = 'box mg-pay'; box.innerHTML = '';
    buildPayBox(box, checkout && checkout.payment_url);
  }
  // Open the pay modal IMMEDIATELY on click with a single loader, then drop the OdysPay
  // iframe in once the payment_url is ready — reusing the in-flight prewarm checkout if it
  // matches (no second spinner). Used when the form wasn't fully preloaded yet at click.
  function openPayNow(email, price, variant) {
    buyer.email = email; buyer.price = (price == null ? null : price); buyer.variant = variant || 'full';
    var box = overlay(); box.className = 'box mg-pay';       // open immediately
    box.innerHTML = '<div class="mg-pay-load"><div class="spin"></div></div>';   // brief loader until checkout resolves
    track('payment_attempt');                                // form shown due to the button click
    var ckP;
    if (prewarm.status === 'loading' && prewarm.promise && prewarm.price === (price == null ? null : price)) {
      prewarm.claimed = true; ckP = prewarm.promise;         // reuse the checkout already in flight
    } else { ckP = doStartCheckout(email, price, variant); }
    ckP.then(function (ck) {
      if (ck && ck.price == null) ck.price = (price == null ? null : price);
      renderPay(box, ck);                                     // native Elements form, or iframe fallback
    }).catch(function () {
      box.className = 'box';                                  // back to the normal padded card for the error
      box.innerHTML = '<h2 style="text-align:center">Magnora</h2><p class="err" style="text-align:center">' + T.err + '</p><button class="cta" id="rt">' + T.cont + '</button>';
      box.querySelector('#rt').addEventListener('click', function () { openPayNow(email, price, variant); });
    });
  }
  function showPayment(checkout) {
    track('payment_attempt');                   // Yandex-only goal (NOT Meta) — buyer reached the pay form
    renderPay(overlay(), checkout);
  }

  // ── Prewarm the OdysPay FORM before the click (fully preloaded) ──
  // On paywall show we run start+checkout AND build the payment overlay HIDDEN, so the
  // OdysPay iframe fully loads in the background. On click we only un-hide it (the iframe
  // is never reparented — that would reload it), so the form appears in well under a second
  // even on a cold cache. Trade-off (chosen deliberately): OdysPay's own form-load beacon
  // fires at prewarm, not on the click. Our own payment_attempt goal still fires on the
  // click reveal (revealPrewarm), so funnel analytics stay click-accurate.
  var prewarm = { status: 'idle', price: null, variant: 'full', checkout: null, overlay: null, promise: null, claimed: false };
  // ── Prewarm ONLY the reading generation (price-independent) ──
  // /funnels/start is the slow call (~20-40s: the backend generates the whole reading) and
  // needs NO price and NO OdysPay checkout — so it's safe to run early (as soon as the quiz
  // data + palm photo are ready), long before the paywall. It just caches session.id, which
  // the click-time checkout (openPayNow → doStartCheckout) then reuses → that checkout is fast.
  // Crucially this creates NO OdysPay transaction — the checkout (the only trx-creating step)
  // runs ONCE, on the pay-button click, so there is exactly one pending per buyer, at form show.
  // Warm the TLS handshakes to the payment hosts while the buyer is still in the quiz — so
  // the OdysPay iframe (created on the pay click) paints fast WITHOUT any early request that
  // would create a pending. Origins are fixed (odyssey-pay.com / Stripe), so no payment_url
  // is needed. Idempotent (guarded by data-mg-pc).
  var _pcDone = false;
  function preconnect() {
    if (_pcDone) return; _pcDone = true;
    try { ensureStripeJs(); } catch (e) {}          // start loading the Elements SDK early (dahlia build)
    try {
      ['https://odyssey-pay.com', 'https://js.stripe.com', 'https://api.stripe.com'].forEach(function (href) {
        ['preconnect', 'dns-prefetch'].forEach(function (rel) {
          var l = document.createElement('link');
          l.rel = rel; l.href = href; l.crossOrigin = 'anonymous';
          l.setAttribute('data-mg-pc', href);
          document.head.appendChild(l);
        });
      });
    } catch (e) {}
  }
  var startWarm = { running: false, done: false };
  function prewarmStart() {
    if (startWarm.running || startWarm.done || session.id) return;
    if (CFG.needsPhoto && !(typeof M.getPhoto === 'function' && M.getPhoto())) return;  // wait for the scan
    startWarm.running = true;
    var fd = new FormData();
    fd.append('funnel', CFG.funnel);
    fd.append('answers', JSON.stringify(answers()));
    var photo = (CFG.needsPhoto && typeof M.getPhoto === 'function') ? M.getPhoto() : null;
    if (photo) fd.append('image', photo, 'scan.jpg');
    post('/funnels/start', fd, true)
      .then(function (s) { saveSession(s.session_id, s.claim_token); startWarm.done = true; })
      .catch(function () { startWarm.running = false; });   // the paywall path retries via doStartCheckout
  }
  function prewarmCheckout(email, price, variant) {
    if (SUCCESSPAY) return;                                   // QA bypass — no real form to warm
    if (!email || !EMRE.test(email)) return;                 // checkout needs a valid email
    if (prewarm.status === 'loading' || prewarm.status === 'ready') return;   // once only
    prewarm.status = 'loading'; prewarm.price = (price == null ? null : price); prewarm.variant = variant || 'full'; prewarm.claimed = false;
    prewarm.promise = doStartCheckout(email, price, variant);
    prewarm.promise
      .then(function (ck) {
        prewarm.checkout = ck;
        if (prewarm.claimed) { prewarm.status = 'consumed'; return; }                 // a fast click already grabbed the checkout → it fills its own modal
        if (document.getElementById('mg-cn')) { prewarm.status = 'idle'; return; }    // a real overlay opened meanwhile → abort quietly
        css();
        var ov = document.createElement('div'); ov.id = 'mg-cn'; ov.className = 'mg-prewarm-hidden'; if (RTL) ov.dir = 'rtl';
        var box = document.createElement('div'); ov.appendChild(box); document.body.appendChild(ov);
        renderPay(box, ck);                         // form (Elements) or iframe loads NOW, in the background (hidden)
        prewarm.overlay = ov; prewarm.status = 'ready';
      })
      .catch(function () { prewarm.status = 'failed'; prewarm.checkout = null; prewarm.overlay = null; });
  }
  // Reveal the preloaded form on the pay-button click: un-hide the already-loaded overlay
  // (instant) and fire payment_attempt HERE, on the click-driven display.
  function revealPrewarm(email, price) {
    buyer.email = email; buyer.price = (price == null ? null : price); buyer.variant = 'full';
    var ov = prewarm.overlay; prewarm.overlay = null; prewarm.status = 'consumed';
    if (ov) ov.className = '';                       // drop mg-prewarm-hidden → instantly visible
    track('payment_attempt');                        // funnel goal: form shown due to the button click
  }

  // ── Exit-intent downsell — re-checkout at the discounted price ──
  // Load the serif (Cormorant Garamond) once, so the downsell headline matches the
  // funnel's cosmic display type even if the paywall hasn't loaded it yet.
  function ensureSerif() {
    if (document.getElementById('mg-ds-font')) return;
    var l = document.createElement('link'); l.id = 'mg-ds-font'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&display=swap';
    document.head.appendChild(l);
  }
  function showDownsell() {
    track('downsell_shown');
    ensureSerif();
    var box = overlay(); box.className = 'box mg-ds';
    var now = (PRICING && PRICING.downsell_price != null) ? Number(PRICING.downsell_price)
            : (buyer.price != null ? Math.max(0, buyer.price * 0.5) : null);
    var was = (PRICING && PRICING.full_price != null) ? Number(PRICING.full_price)
            : (buyer.price != null ? buyer.price : null);
    var priceLine = (now != null)
      ? '<div class="mg-ds-price"><span class="mg-ds-now">$' + now.toFixed(2) + '</span>'
        + (was != null && was > now ? '<span class="mg-ds-was">$' + was.toFixed(2) + '</span>' : '') + '</div>'
      : '';
    box.innerHTML =
      '<div class="mg-ds-glow"></div>' +
      '<div class="mg-ds-star">✦</div>' +
      '<h2 class="mg-ds-title">' + T.dsTitle + '</h2>' +
      '<p class="mg-ds-sub">' + T.dsSub + '</p>' + priceLine +
      '<button class="mg-ds-yes" id="mg-ds-yes">' + T.dsYes + '</button>' +
      '<button class="mg-ds-no" id="mg-ds-no">' + T.dsNo + '</button>';
    box.querySelector('#mg-ds-yes').addEventListener('click', function () {
      // The conversion goal fires on real payment success, not on this click.
      startAndCheckout(buyer.email, null, 'discount');   // backend applies the downsell price
    });
    box.querySelector('#mg-ds-no').addEventListener('click', function () { track('payment_closed'); closeOverlay(); });
  }

  // postMessage from the OdysPay iframe (UX signal only — access comes from the webhook).
  var paidOk = false;
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== 'odyspay' || d.type !== 'payment_result') return;
    // Purchase fires HERE — on real payment success (covers both the main checkout
    // and the downsell re-checkout, since both reach this same iframe result).
    if (d.outcome === 'success') {
      paidOk = true;
      if (buyer.variant === 'discount') track('downsell_accept', { value: buyer.price });  // downsell actually paid (Yandex)
      track('purchase', { value: buyer.price, screen_id: 'payment_modal' });   // Meta Purchase + Yandex mg_purchase — on the payment fact
      postPaid();
    }
    else if (d.outcome === 'decline') track('payment_failed');
    else if (d.outcome === 'pending') track('payment_pending');
  });

  // ── Step 5: upsells (off-session retries) ──
  // ── Seam for the funnel's OWN post-payment UI (React MgModals) ──
  // If MAGNORA.onPaid is defined (funnel draws its own upsell modal), hand the
  // payment machinery to it via this api; otherwise fall back to the built-in
  // overlay (unchanged prod behaviour).
  function mgHookApi() {
    return {
      // one add-on = one independent off-session charge (backend owns the price)
      upsell: function (id, price) {
        return post('/funnels/upsell', { session_id: session.id, claim_token: session.token, upsell_id: id })
          .then(function () { track('upsell', { id: id, value: price || 0, screen_id: 'payment_modal', payment_method: 'card' }); });
      },
      claim: function () { location.href = CFG.site + '/claim?session=' + encodeURIComponent(session.id) + '&token=' + encodeURIComponent(session.token); },
      close: closeOverlay,
      track: track,
    };
  }
  function postPaid() {
    if (typeof M.onPaid === 'function') { try { M.onPaid(mgHookApi()); return; } catch (e) {} }
    showUpsells();
  }

  function showUpsells() {
    var box = overlay();               // 'purchase' is tracked in the postMessage handler
    var html = '<h2>' + T.upTitle + '</h2><p class="sub"></p><div id="mg-list"></div>' +
               '<button class="cta" id="mg-done"></button>';
    box.innerHTML = html;
    box.querySelector('#mg-done').textContent = T.done;
    var list = box.querySelector('#mg-list');
    UPSELLS.forEach(function (u) {
      var row = document.createElement('div'); row.className = 'row';
      row.innerHTML = '<span>' + (u.title || u.id) + ' &middot; <b>$' + Number(u.price).toFixed(2) + '</b></span>';
      var b = document.createElement('button'); b.className = 'addb'; b.textContent = T.add;
      b.addEventListener('click', function () {
        b.disabled = true; b.textContent = '…';
        post('/funnels/upsell', { session_id: session.id, claim_token: session.token, upsell_id: u.id })
          .then(function () { b.textContent = T.added; track('upsell', { id: u.id, value: u.price, screen_id: 'payment_modal', payment_method: 'card' }); })
          .catch(function () { b.disabled = false; b.textContent = T.add; });
      });
      row.appendChild(b); list.appendChild(row);
    });
    box.querySelector('#mg-done').addEventListener('click', function () {
      location.href = CFG.site + '/claim?session=' + encodeURIComponent(session.id) + '&token=' + encodeURIComponent(session.token);
    });
  }

  // ── Email already collected by the funnel — find it, NEVER ask again ──
  var EMRE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  function getEmail() {
    if (typeof M.getEmail === 'function') { try { var e = M.getEmail(); if (e && EMRE.test(e)) return e.trim(); } catch (x) {} }
    // Known keys first, then a full scan of session/local storage (incl. JSON blobs)
    var keys = ['mg_email', 'userEmail', 'email', 'user_email'];
    function scan(store) {
      try {
        for (var i = 0; i < keys.length; i++) { var v = store.getItem(keys[i]); if (v && EMRE.test(v.trim())) return v.trim(); }
        for (var j = 0; j < store.length; j++) {
          var val = store.getItem(store.key(j)); if (!val) continue;
          if (EMRE.test(val.trim())) return val.trim();
          if (val.indexOf('@') > 0) { try { var o = JSON.parse(val); if (o && typeof o === 'object') for (var p in o) if (typeof o[p] === 'string' && EMRE.test(o[p].trim())) return o[p].trim(); } catch (e) {} }
        }
      } catch (e) {}
      return '';
    }
    return scan(SS) || (function () { try { return scan(window.localStorage); } catch (e) { return ''; } })() || (captured && captured.email) || '';
  }

  // ── Price the user actually selected on the paywall (not a fixed value) ──
  // Best-effort: read the price from the selected/active plan option near the CTA.
  function getSelectedPrice(ctaEl) {
    var PRE = /(?:\$|€|£)?\s*([0-9]{1,3}(?:[.,][0-9]{2}))/;
    function priceIn(el) { if (!el) return null; var m = (el.textContent || '').match(PRE); return m ? parseFloat(m[1].replace(',', '.')) : null; }
    // The trial tier the buyer chose on the funnel's price-choice screen (most reliable).
    try { var tr = parseFloat(SS.getItem('mg_trial_num') || SS.getItem('__mg_trial_num')); if (tr > 0) return tr; } catch (e) {}
    try {
      // 1) an explicitly selected/checked plan option
      var sel = document.querySelector('input:checked, [aria-checked="true"], [data-selected="true"], [class*="selected" i], [class*="active" i][class*="plan" i], [class*="active" i][class*="option" i]');
      var p = priceIn(sel) || priceIn(sel && sel.closest && sel.closest('label,[class*="plan" i],[class*="option" i],[class*="card" i]'));
      if (p) return p;
      // 2) price shown right by the CTA (order summary / total)
      p = priceIn(ctaEl && ctaEl.closest && ctaEl.closest('[class*="pay" i],[class*="checkout" i],[class*="offer" i],form,section,div'));
      if (p) return p;
    } catch (e) {}
    return null;   // → backend falls back to the funnel's admin price
  }

  // Intercept the funnel's own pay button → open OdysPay directly (no email modal,
  // no separate screen). Triggered purely by the button TEXT, so it works on
  // hash-named screens (astrocarto) where the URL can't reveal the paywall.
  // Delegated + capture so it pre-empts the funnel's fake-door handler.
  var _ctaBound = false, _leadFired = false;
  function bindPayCtas() {
    if (_ctaBound) return; _ctaBound = true;
    var re = M.payCtaRe || /(get my|unlock|reveal|see (my|your)|get (your )?(results|report|reading|prediction|plan)|start (your )?(plan|trial)|subscribe|continue to pay|complete (my )?order|\bpay\b|checkout|get started)/i;
    document.addEventListener('click', function (e) {
      try {
        var _ov = document.getElementById('mg-cn');
        if (_ov && _ov.className.indexOf('mg-prewarm-hidden') < 0) return;   // a VISIBLE overlay is already open (hidden prewarm one is fine)
        var t = e.target.closest && e.target.closest('button,a,[role="button"],[data-testid]');
        if (!t) return;
        var txt = (t.textContent || '').trim().toLowerCase();
        if (!txt || txt.length > 60 || !re.test(txt)) return;
        e.preventDefault(); e.stopPropagation();
        if (!_leadFired) { _leadFired = true; track('lead', { screen_id: 'paywall' }); }
        track('initiate', { screen_id: 'paywall', plan_id: (typeof M.getPrice === 'function' ? M.getPrice() : null) });
        // No email modal — use what the funnel already collected; charge the
        // price the user selected on this paywall.
        // Prefer the funnel's explicit selected price (MAGNORA.getPrice) over DOM
        // scraping — the paywall terms text contains other amounts (e.g. $19.99).
        var _sel = (typeof M.getPrice === 'function') ? M.getPrice() : null;
        var _price = (_sel != null ? _sel : getSelectedPrice(t));
        if (SUCCESSPAY) {                                    // ?successpay=1 QA bypass — fake a paid result
          buyer.email = getEmail(); buyer.price = _price; buyer.variant = 'full';
          postPaid(); return;
        }
        // If the form was preloaded (hidden) for this same price, reveal it INSTANTLY.
        // Otherwise open the pay modal IMMEDIATELY with a single loader and fill the form
        // when the checkout resolves (reusing the in-flight prewarm) — no double spinner.
        if (prewarm.status === 'ready' && prewarm.overlay && prewarm.price === (_price == null ? null : _price)) {
          revealPrewarm(getEmail(), _price); return;
        }
        openPayNow(getEmail(), _price);
      } catch (x) {}
    }, true);
    // Predictive preload (instant.page pattern): the instant the buyer reaches for the pay
    // button — hover on desktop, finger-down on mobile — arm the hidden form preload. This
    // fires before the dwell timer and well before the `click`, so on desktop the form is
    // fully loaded by the time they click (0 ms reveal). Same once-guard → still one pending,
    // and only for buyers who actually engage the button.
    ['pointerdown', 'touchstart', 'mouseover'].forEach(function (evt) {
      document.addEventListener(evt, function (e) {
        try {
          if (prewarm.status !== 'idle') return;
          var t = e.target && e.target.closest && e.target.closest('button,a,[role="button"],[data-testid]');
          if (!t) return;
          var txt = (t.textContent || '').trim().toLowerCase();
          if (!txt || txt.length > 60 || !re.test(txt)) return;
          armPrewarm();
        } catch (x) {}
      }, true);
    });
  }

  // ── Arm the hidden form preload → truly instant reveal on click, EXACTLY ONE pending ──
  // The OdysPay form == the /funnels/checkout == the pending (their hosted page creates the
  // Stripe intent up front; we can't defer it). So an instant form necessarily needs the
  // checkout done before the click. We arm it the MOMENT the buyer has CHOSEN their price:
  // getPrice() becomes non-null on the trialChoice screen — ONE screen before the paywall —
  // and nothing sets a price earlier, so this is a clean "purchase-intent" signal (a full
  // screen of lead time, not a paywall-view flash). The status guard fires it ONCE; the click
  // then REVEALS the already-loaded form (~0 ms) and never runs a second checkout. Because the
  // chosen price IS the price the paywall charges, prewarm.price === the click's price → the
  // reveal matches, no second trx.
  function armPrewarm() {
    if (prewarm.status !== 'idle') return;              // once — idempotent, one pending max
    try {
      var em = getEmail(); if (!em) return;             // checkout needs the collected email
      var pr = (typeof M.getPrice === 'function' ? M.getPrice() : null);
      if (pr == null) return;                           // price not chosen yet (trialPrice unset) → wait
      prewarmCheckout(em, pr, 'full');                  // builds the hidden, fully-loaded form
    } catch (e) {}
  }

  // Fire Lead when a recognisable paywall screen is shown (best-effort analytics).
  function tick() {
    // Warm the payment hosts' TLS early (no request, no pending) so the form paints fast.
    preconnect();
    // Prewarm ONLY the slow reading generation (price-independent, creates NO pending) so the
    // checkout that follows is fast. Caches session.id.
    prewarmStart();
    // Arm the hidden form preload the MOMENT the buyer has chosen their price — getPrice()
    // turns non-null on the trialChoice screen, ONE screen before the paywall. That full screen
    // of lead (transition + paywall render + reading time) lets the ~2s checkout+iframe finish
    // BEFORE they can click → instant reveal, NO loader. armPrewarm self-guards (once).
    armPrewarm();

    var on = false; try { on = CFG.isPayScreen(); } catch (e) {}
    if (!on) return;
    if (!_leadFired) { _leadFired = true; track('lead', { screen_id: 'paywall' }); }
  }
  function loadPricing() {
    fetch(CFG.api + '/funnels/pricing?funnel=' + encodeURIComponent(CFG.funnel))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) {
        if (!p) return;
        PRICING = p;
        if (p.upsells && p.upsells.length) UPSELLS = p.upsells;   // admin-managed list
      })
      .catch(function () { /* keep display fallbacks */ });
  }
  // Public hooks so the funnel can fire the quiz-step events at the exact screen
  // (ViewContent = 3rd meaningful step, AddToCart = summary/plan preview):
  //   window.MAGNORA.fireViewContent();  window.MAGNORA.fireAddToCart();
  M.fireViewContent = function (p) { track('view_content', p); };
  M.fireAddToCart = function (p) { track('add_to_cart', p); };
  M.track = track;
  // Explicit prewarm hook: the funnel can call MAGNORA.prewarm() the instant the scan +
  // answers are ready to kick off the slow reading generation early (price-independent, no
  // checkout/transaction). The price-dependent checkout still runs once, on the paywall.
  // Auto-prewarm in tick() already covers this, so the hook is optional/for early triggers.
  M.prewarm = function () { try { prewarmStart(); } catch (e) {} };

  function start() {
    // Payment interception FIRST and isolated — it must bind even if anything else
    // (pixel install, pricing fetch, observers) throws on a given funnel.
    try { bindPayCtas(); } catch (e) {}
    try { installPixel(); } catch (e) {}
    try { loadPricing(); } catch (e) {}
    try { document.addEventListener('click', capture, true); } catch (e) {}
    try { new MutationObserver(tick).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    try { setInterval(tick, 700); tick(); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
