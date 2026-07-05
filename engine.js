/*
 * Feed Doctor — Google Shopping product-feed validation engine.
 * Pure, dependency-free JS. Runs identically in the browser (client-side, data
 * never leaves the page) and in Node (for tests). No network, no state.
 *
 * It validates a parsed feed (array of row objects, keys = column names) against
 * the load-bearing subset of the Google Merchant Center product-data spec that
 * actually drives disapprovals, and returns a ranked, explained report.
 */

(function (root) {
  'use strict';

  // ---- helpers -------------------------------------------------------------

  var AVAILABILITY = ['in_stock', 'out_of_stock', 'preorder', 'backorder'];
  var CONDITION = ['new', 'refurbished', 'used'];
  // Promo-ish phrases Google rejects in titles (a representative subset).
  var PROMO_RE = /\b(free shipping|best price|lowest price|sale|% off|buy now|order now|hot deal|cheapest|\bfree\b)\b/i;
  var CURRENCY_RE = /^\s*\d+(\.\d{1,2})?\s*[A-Z]{3}\s*$|^\s*[A-Z]{3}\s*\d+(\.\d{1,2})?\s*$|^\s*[£$€]\s*\d+(\.\d{1,2})?\s*$/;

  function norm(k) { return String(k == null ? '' : k).trim().toLowerCase().replace(/[\s\-]+/g, '_'); }

  // Build a lookup that tolerates common header variants (title/Title/"Title ").
  function rowGet(row, keys, aliases) {
    for (var i = 0; i < aliases.length; i++) {
      var a = aliases[i];
      if (a in keys) {
        var v = row[keys[a]];
        if (v != null && String(v).trim() !== '') return String(v).trim();
      }
    }
    return '';
  }

  function isUrl(v) {
    if (!v) return false;
    return /^https?:\/\/[^\s]+\.[^\s]+/i.test(v);
  }

  // GTIN check-digit validation (GTIN-8/12/13/14). This is the single most
  // common hard disapproval and is fully deterministic — no LLM needed.
  function validGtin(raw) {
    if (!raw) return false;
    var d = String(raw).replace(/[\s\-]/g, '');
    if (!/^\d+$/.test(d)) return false;
    if ([8, 12, 13, 14].indexOf(d.length) === -1) return false;
    var sum = 0, digits = d.split('').map(Number), n = digits.length;
    // Weight of 3 applies to the rightmost digit before the check digit, alternating.
    for (var i = 0; i < n - 1; i++) {
      var posFromRight = (n - 1) - i; // 1-based distance from check digit
      sum += digits[i] * (posFromRight % 2 === 1 ? 3 : 1);
    }
    var check = (10 - (sum % 10)) % 10;
    return check === digits[n - 1];
  }

  // ---- rule set ------------------------------------------------------------
  // Each rule: id, severity (critical=hard disapproval | warning=likely | tip),
  // a per-row test returning null (pass) or a short human cause, and a fix hint.

  var RULES = [
    { id: 'missing_id', sev: 'critical',
      aliases: ['id', 'sku', 'item_id', 'product_id'],
      test: function (v) { return v ? null : 'Missing product id — every item needs a unique id.'; },
      fix: 'Assign a unique id/SKU to every row.' },

    { id: 'missing_title', sev: 'critical',
      aliases: ['title', 'name', 'product_title'],
      test: function (v) { return v ? null : 'Missing title — required for every product.'; },
      fix: 'Add a descriptive title (brand + product + key attribute).' },

    { id: 'title_too_long', sev: 'warning',
      aliases: ['title', 'name', 'product_title'],
      test: function (v) { return v && v.length > 150 ? 'Title is ' + v.length + ' chars — Google truncates/penalises over 150.' : null; },
      fix: 'Trim the title to <=150 characters, front-load the important words.' },

    { id: 'title_all_caps', sev: 'warning',
      aliases: ['title', 'name', 'product_title'],
      test: function (v) {
        if (!v) return null;
        var letters = v.replace(/[^A-Za-z]/g, '');
        return letters.length >= 8 && v === v.toUpperCase() ? 'Title is ALL CAPS — a common disapproval trigger.' : null;
      },
      fix: 'Use normal sentence/title case, not all caps.' },

    { id: 'title_promo', sev: 'warning',
      aliases: ['title', 'name', 'product_title'],
      test: function (v) { return v && PROMO_RE.test(v) ? 'Promotional text in title ("' + (v.match(PROMO_RE) || [''])[0] + '") — not allowed.' : null; },
      fix: 'Remove promotional phrases (Free Shipping, Sale, % off) from the title.' },

    { id: 'missing_description', sev: 'critical',
      aliases: ['description', 'desc', 'body_html'],
      test: function (v) { return v ? null : 'Missing description — required.'; },
      fix: 'Add a real product description (no promo text, <=5000 chars).' },

    { id: 'missing_link', sev: 'critical',
      aliases: ['link', 'url', 'product_url'],
      test: function (v) { return isUrl(v) ? null : (v ? 'Link is not a valid http(s) URL.' : 'Missing product link URL.'); },
      fix: 'Provide the full https:// landing-page URL for the product.' },

    { id: 'missing_image', sev: 'critical',
      aliases: ['image_link', 'image', 'image_url', 'imagelink'],
      test: function (v) { return isUrl(v) ? null : (v ? 'Image link is not a valid http(s) URL.' : 'Missing image_link — required.'); },
      fix: 'Provide a full https:// image URL.' },

    { id: 'price', sev: 'critical',
      aliases: ['price', 'cost'],
      test: function (v) {
        if (!v) return 'Missing price.';
        return CURRENCY_RE.test(v) ? null : 'Price "' + v + '" is not in an accepted format (e.g. "24.99 GBP").';
      },
      fix: 'Format price as number + ISO currency, e.g. "24.99 GBP".' },

    { id: 'availability', sev: 'critical',
      aliases: ['availability', 'stock_status', 'inventory'],
      test: function (v) {
        if (!v) return 'Missing availability.';
        return AVAILABILITY.indexOf(norm(v)) === -1 ? 'Availability "' + v + '" invalid — must be one of: ' + AVAILABILITY.join(', ') + '.' : null;
      },
      fix: 'Set availability to exactly one of: in_stock, out_of_stock, preorder, backorder.' },

    { id: 'condition', sev: 'warning',
      aliases: ['condition'],
      test: function (v) {
        if (!v) return null; // optional but recommended
        return CONDITION.indexOf(norm(v)) === -1 ? 'Condition "' + v + '" invalid — must be new, refurbished, or used.' : null;
      },
      fix: 'Set condition to new, refurbished, or used (or omit for new).' },
  ];

  // Identifier logic (GTIN/MPN/brand) is cross-field, handled separately.
  function checkIdentifiers(row, keys) {
    var idExists = norm(rowGet(row, keys, ['identifier_exists']));
    var gtin = rowGet(row, keys, ['gtin', 'ean', 'upc', 'barcode']);
    var mpn = rowGet(row, keys, ['mpn', 'manufacturer_part_number']);
    var brand = rowGet(row, keys, ['brand', 'manufacturer']);
    var out = [];

    if (gtin && !validGtin(gtin)) {
      out.push({ ruleId: 'gtin_checkdigit', sev: 'critical',
        cause: 'GTIN "' + gtin + '" fails check-digit validation — Google will reject it.',
        fix: 'Correct the GTIN, or if the product genuinely has none set identifier_exists = no (the safe fix — never invent a GTIN).' });
    }

    var hasValidId = (gtin && validGtin(gtin)) || mpn;
    if (idExists === 'no' || idExists === 'false') {
      // Explicitly no identifier — allowed, but brand still recommended.
      if (!brand) out.push({ ruleId: 'brand_missing', sev: 'warning',
        cause: 'identifier_exists = no but brand is missing — add brand where possible.',
        fix: 'Add the brand attribute even when there is no GTIN/MPN.' });
    } else if (!hasValidId) {
      out.push({ ruleId: 'no_identifier', sev: 'critical',
        cause: 'No valid GTIN or MPN, and identifier_exists is not set to "no".',
        fix: 'Add a valid GTIN or MPN and brand; or set identifier_exists = no for genuinely unbranded items.' });
    }
    if (hasValidId && !brand) {
      out.push({ ruleId: 'brand_with_id', sev: 'warning',
        cause: 'Has a GTIN/MPN but no brand — Google expects brand alongside identifiers.',
        fix: 'Add the brand attribute.' });
    }
    return out;
  }

  // ---- main ----------------------------------------------------------------

  function validate(rows) {
    if (!Array.isArray(rows)) rows = [];
    // Map normalised header -> original header, from the first row's keys.
    var keys = {};
    if (rows.length) Object.keys(rows[0]).forEach(function (k) { keys[norm(k)] = k; });

    var issues = [];          // flat list of {row, ruleId, sev, cause, fix}
    var perRule = {};         // ruleId -> count
    var rowsWithCritical = {};

    rows.forEach(function (row, idx) {
      var rowNo = idx + 1;
      RULES.forEach(function (rule) {
        var v = rowGet(row, keys, rule.aliases);
        var cause = rule.test(v);
        if (cause) {
          issues.push({ row: rowNo, ruleId: rule.id, sev: rule.sev, cause: cause, fix: rule.fix });
          perRule[rule.id] = (perRule[rule.id] || 0) + 1;
          if (rule.sev === 'critical') rowsWithCritical[rowNo] = true;
        }
      });
      checkIdentifiers(row, keys).forEach(function (it) {
        issues.push({ row: rowNo, ruleId: it.ruleId, sev: it.sev, cause: it.cause, fix: it.fix });
        perRule[it.ruleId] = (perRule[it.ruleId] || 0) + 1;
        if (it.sev === 'critical') rowsWithCritical[rowNo] = true;
      });
    });

    var criticalCount = issues.filter(function (i) { return i.sev === 'critical'; }).length;
    var warningCount = issues.filter(function (i) { return i.sev === 'warning'; }).length;
    var atRiskRows = Object.keys(rowsWithCritical).length;

    // Rank problems by how many products each affects (biggest wins first).
    var ranked = Object.keys(perRule).map(function (id) {
      var sample = issues.find(function (i) { return i.ruleId === id; });
      return { ruleId: id, count: perRule[id], sev: sample.sev, cause: sample.cause, fix: sample.fix };
    }).sort(function (a, b) {
      if (a.sev !== b.sev) return a.sev === 'critical' ? -1 : 1;
      return b.count - a.count;
    });

    return {
      totalRows: rows.length,
      atRiskRows: atRiskRows,                 // products that WILL be disapproved
      healthyRows: rows.length - atRiskRows,
      criticalCount: criticalCount,
      warningCount: warningCount,
      ranked: ranked,                          // grouped, ranked problem list (the free report)
      issues: issues                           // full per-row detail (paid tier)
    };
  }

  var api = { validate: validate, validGtin: validGtin, RULES: RULES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FeedDoctor = api;
})(typeof self !== 'undefined' ? self : this);
