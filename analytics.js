/*
 * Feed Doctor — lightweight, privacy-friendly analytics.
 *
 * Uses GoatCounter: cookieless, no personal data, no cross-site tracking, GDPR-friendly.
 * It ONLY counts anonymous pageviews + a few named events (buy-button clicks, feed audits).
 * It NEVER sees or sends your product feed — that is processed entirely client-side and
 * never leaves the page. This script sends nothing but a pageview ping and event names.
 *
 * ACTIVATION (owner, ~2 min): create a free account at goatcounter.com, choose the code
 * "feeddoctor" (so the dashboard is https://feeddoctor.goatcounter.com), then set CODE below
 * to "feeddoctor" and redeploy. Until CODE is set, this file is inert (no network calls).
 */
(function () {
  'use strict';

  var CODE = 'feeddoctor'; // GoatCounter code — analytics ACTIVE

  // Always define a safe no-op so page code can call window.fdTrack() unconditionally.
  window.fdTrack = window.fdTrack || function () {};

  if (!CODE) return; // inert until activated

  // Load GoatCounter's counter with our endpoint.
  var s = document.createElement('script');
  s.async = true;
  s.src = '//gc.zgo.at/count.js';
  s.setAttribute('data-goatcounter', 'https://' + CODE + '.goatcounter.com/count');
  document.head.appendChild(s);

  // Named-event helper (pageviews are automatic).
  window.fdTrack = function (name) {
    try {
      if (window.goatcounter && window.goatcounter.count) {
        window.goatcounter.count({ path: name, title: name, event: true });
      }
    } catch (e) { /* analytics must never break the app */ }
  };

  // Auto-track the money click anywhere on the site: any link to the paid product.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href*="gumroad.com/l/feeddoctor"]');
    if (a) window.fdTrack('buy_clicked');
  }, true);
})();
