/* RBI Weekly Dashboard — the design-system component layer.
 *
 * Same shape Content Tracker proved: `public/app.js` keeps owning the data, the
 * charts and the templates, and this file upgrades what is already on screen.
 * Every installer is idempotent (an element is upgraded once, marked with
 * `data-ct-done`), non-fatal (a selector that matches nothing is normal — this
 * site's sections really do differ) and class-only: the CSP is
 * `style-src 'self'`, so no `style` attribute is ever written and every runtime
 * value travels as a class or a custom property set through CSSOM.
 *
 * It is loaded after app.js, so the top-level bindings app.js declares
 * (`records`, `modes`, `sw`, `swRange`, `quickCompare`, `showToast`,
 * `prefersReducedMotion`) are reachable here as identifiers — they are `let` /
 * `function` declarations in a classic script, not window properties, so they
 * are read through `typeof` guards rather than assumed.
 */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ── shared helpers ─────────────────────────────────────────────────────── */

  function mark(el, id) {
    if (!el) return el;
    var existing = (el.getAttribute('data-component') || '').split(/\s+/).filter(Boolean);
    if (existing.indexOf(id) === -1) existing.push(id);
    el.setAttribute('data-component', existing.join(' '));
    el.setAttribute('data-ct-done', '1');
    return el;
  }

  function fresh(selector, scope) {
    var out = [];
    var list = (scope || document).querySelectorAll(selector);
    for (var i = 0; i < list.length; i++) {
      if (!list[i].hasAttribute('data-ct-done')) out.push(list[i]);
    }
    return out;
  }

  function text(el) {
    return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function el(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function reduced() {
    try {
      if (typeof prefersReducedMotion === 'function') return prefersReducedMotion();
    } catch (e) { /* not defined yet */ }
    return reduce.matches;
  }

  /** Run after the browser has laid the change out. Indicators that sit inside
   *  a section the app has just shown measure zero if they are placed while
   *  that section was still `display:none`, so every measurement that follows a
   *  navigation goes through here rather than running in the click handler. */
  function afterPaint(fn) {
    if (typeof requestAnimationFrame !== 'function') { setTimeout(fn, 0); return; }
    requestAnimationFrame(function () { requestAnimationFrame(fn); });
  }

  /** The app's own data, read defensively: this file must work before it loads. */
  function data() {
    try {
      if (typeof records === 'undefined' || !records || !records.length) return [];
      return records.filter(function (r) { return r && r.date; });
    } catch (e) {
      return [];
    }
  }

  function rows() {
    var list = data().slice();
    list.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : 1; });
    return list;
  }

  /** The app's own date formatter when it is there (it is a function
   *  declaration in app.js, so it is a window property); a same-shaped fallback
   *  otherwise, so this file never renders an ISO string into the UI. */
  function fmtDate(iso) {
    try {
      if (typeof window.fmtDate === 'function') return window.fmtDate(iso);
    } catch (e) { /* */ }
    try {
      var d = new Date(iso + 'T00:00:00');
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) {
      return iso;
    }
  }

  function fmtNumber(value, digits) {
    if (value === null || value === undefined || value === '' || isNaN(Number(value))) return '—';
    return Number(value).toLocaleString('en-IN', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits || 0,
    });
  }

  function toast(title, body) {
    try {
      if (typeof showToast === 'function') return showToast(title, body);
    } catch (e) { /* */ }
    return null;
  }

  function copy(value, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(function () {});
    }
  }

  /** The week a table row stands for.
   *
   *  Not from the RBI link: its `PARAM1` date is the *publication* Friday, one
   *  week after the week being reported (the row labelled "7 Aug 2026" links to
   *  8/14/2026), so reading it compared a row against the following week. The
   *  row is matched by the label the app rendered against the records it
   *  rendered them from — the observation date, and nothing re-derived. */
  function isoFromRow(tr) {
    var label = text(tr.querySelector('.date-cell a') || tr.querySelector('.date-cell'));
    if (!label) return null;
    var list = rows();
    for (var i = 0; i < list.length; i++) {
      if (fmtDate(list[i].date) === label) return list[i].date;
    }
    // Fallback: the same label on one of the app's own date pickers.
    var select = document.getElementById('cmp-from');
    if (select) {
      for (var k = 0; k < select.options.length; k++) {
        if (text(select.options[k]) === label) return select.options[k].value;
      }
    }
    return null;
  }

  /* ── 1. Switch mode ─────────────────────────────────────────────────────── */

  function switchMode(btn) {
    mark(btn, 'switch-mode');
    btn.setAttribute('role', 'switch');
    // app.js sets aria-pressed on its own toggle; a switch exposes aria-checked,
    // and the two disagreeing is exactly what axe flags on role="switch".
    btn.removeAttribute('aria-pressed');
    var sync = function () {
      var light = document.documentElement.dataset.theme === 'light';
      btn.setAttribute('aria-checked', String(light));
      btn.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
      btn.classList.toggle('rc-switch-on', light);
    };
    sync();
    btn.addEventListener('click', function () { setTimeout(sync, 0); });
    // The theme can also change from another tab's storage event or from a
    // restored preference, so the state is re-read rather than cached.
    window.addEventListener('storage', function () { setTimeout(sync, 0); });
  }

  /* ── 2. Gooey nav ───────────────────────────────────────────────────────── */

  function gooeyNav(nav) {
    mark(nav, 'gooey-nav');
    nav.classList.add('rc-gooey');
    var blob = el('span', 'rc-gooey-blob');
    blob.setAttribute('aria-hidden', 'true');
    nav.appendChild(blob);
    var place = function () {
      var active = nav.querySelector('.nav-link.active') || nav.querySelector('.nav-link');
      if (!active) return;
      nav.style.setProperty('--blob-x', active.offsetLeft + 'px');
      nav.style.setProperty('--blob-w', active.offsetWidth + 'px');
    };
    place();
    var later = function () {
      afterPaint(place);
      setTimeout(place, 0);
    };
    window.addEventListener('resize', place);
    nav.addEventListener('click', later);
    document.addEventListener('click', later);
    window.addEventListener('hashchange', later);
  }

  /* ── 3. Glide select ──────────────────────────────────────────────────────
     The compare pickers stay native <select>s — that is the control app.js
     reads — and gain a label echo that glides to the new choice. */

  function glideSelect(sel) {
    mark(sel, 'glide-select');
    sel.classList.add('rc-glide');
    var echo = el('span', 'rc-glide-echo');
    echo.setAttribute('aria-hidden', 'true');
    echo.textContent = sel.options[sel.selectedIndex] ? text(sel.options[sel.selectedIndex]) : '';
    sel.parentNode.insertBefore(echo, sel.nextSibling);
    sel.addEventListener('change', function () {
      echo.textContent = sel.options[sel.selectedIndex] ? text(sel.options[sel.selectedIndex]) : '';
      echo.classList.remove('rc-glide-in');
      void echo.offsetWidth;
      echo.classList.add('rc-glide-in');
    });
  }

  /* ── 4. Jelly radio ───────────────────────────────────────────────────────
     The EM lookback row becomes a real radiogroup of chips. The app's buttons
     stay in the DOM (hidden) because `sw()` reads the element that was clicked,
     so a chip drives the button it stands for. */

  function jellyRadio(group) {
    var real = group.querySelectorAll('button.tab');
    if (real.length < 2 || real.length > 5) return;
    // The group keeps the done flag so the scan does not install twice; the
    // component is marked on the chips, which are the control a person sees.
    group.setAttribute('data-ct-done', '1');
    group.classList.add('rc-jelly');
    var wrap = el('div', 'rc-jelly-wrap');
    wrap.setAttribute('role', 'radiogroup');
    var label = group.getAttribute('aria-label') || 'Lookback range';
    wrap.setAttribute('aria-label', label);

    var chips = [];
    var sync = function () {
      for (var i = 0; i < chips.length; i++) {
        var on = real[i].classList.contains('on');
        chips[i].setAttribute('aria-checked', String(on));
        chips[i].classList.toggle('rc-jelly-on', on);
      }
    };
    for (var i = 0; i < real.length; i++) {
      (function (button, index) {
        var chip = el('button', 'rc-jelly-opt', text(button));
        chip.type = 'button';
        chip.setAttribute('role', 'radio');
        chip.setAttribute('aria-checked', 'false');
        chip.addEventListener('click', function () {
          button.click();
          setTimeout(sync, 0);
        });
        wrap.appendChild(chip);
        chips.push(chip);
      })(real[i], i);
    }
    group.parentNode.insertBefore(wrap, group);
    group.classList.add('rc-jelly-source');
    mark(wrap, 'jelly-radio');
    real[0].parentNode.addEventListener('click', function () { setTimeout(sync, 0); });
    // This row is the EM-peers lookback, and the app shows it only while the FX
    // chart is in that mode (`modes.fx === 'em'`, `#emRanges.is-hidden`). The
    // chips follow it: a visible control for a row that is deliberately hidden
    // would be a new control, not the site's own, and it would let a visitor
    // change a range they cannot see the result of.
    var mirror = function () {
      wrap.hidden = group.getClientRects().length === 0;
    };
    mirror();
    if (window.MutationObserver) {
      new MutationObserver(mirror).observe(group, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    sync();
  }

  /* ── 5. Rubber segment ────────────────────────────────────────────────────
     A segmented control with a sliding indicator over the table-length row. */

  function rubberSegment(group) {
    var buttons = group.querySelectorAll('button.tab');
    if (buttons.length < 2 || buttons.length > 4) return;
    mark(group, 'rubber-segment');
    group.classList.add('rc-segment');
    group.setAttribute('role', 'radiogroup');
    if (!group.getAttribute('aria-label')) group.setAttribute('aria-label', 'Table length');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('role', 'radio');
    }
    var indicator = el('span', 'rc-segment-pill');
    indicator.setAttribute('aria-hidden', 'true');
    group.appendChild(indicator);
    var place = function () {
      // Re-read the buttons every time. app.js rebuilds this row when the range
      // changes, so the NodeList captured above goes stale, and measuring a
      // detached node gives 0 for both offsetLeft and offsetWidth — which is
      // exactly how the indicator came to sit at width zero.
      var live = group.querySelectorAll('button.tab');
      var active = group.querySelector('button.tab.on') || live[0] || buttons[0];
      // Written straight onto the indicator rather than through a custom
      // property on the row: inside this row a `span` sibling is stretched by
      // the stylesheet's own rules, and the width the indicator asked for was
      // being discarded in favour of the stretched one. Inline wins over both
      // (CSSOM, so `style-src 'self'` still allows it).
      indicator.style.width = active.offsetWidth + 'px';
      indicator.style.height = active.offsetHeight + 'px';
      indicator.style.top = active.offsetTop + 'px';
      indicator.style.transform = 'translateX(' + active.offsetLeft + 'px)';
      for (var k = 0; k < live.length; k++) {
        live[k].setAttribute('aria-checked', String(live[k] === active));
      }
    };
    place();
    // afterPaint at once and a timer as well: requestAnimationFrame is throttled
    // in a background tab, and a measurement that only ever waits for a frame
    // never arrives there (it left the indicator at zero in testing).
    var later = function () {
      afterPaint(place);
      setTimeout(place, 0);
    };
    group.addEventListener('click', later);
    window.addEventListener('resize', place);
    // The row lives in a section only one of which is rendered at a time, so
    // the indicator measures zero until the Table section is shown: re-place it
    // after any navigation, not just after a click on the row itself.
    document.addEventListener('click', later);
    window.addEventListener('hashchange', later);
  }

  /* ── 6. Squish switch ─────────────────────────────────────────────────────
     A switch of its own: the week-on-week Δ chips can be hidden, and the choice
     is remembered. Nothing the app computes is recomputed — only its display. */

  function deltaSwitch(host) {
    if (host.querySelector('.rc-delta-switch')) return;
    var wrap = el('label', 'rc-delta-switch');
    wrap.setAttribute('data-component', 'squish-switch');
    wrap.setAttribute('data-ct-done', '1');
    var box = el('input', 'rc-delta-box');
    box.type = 'checkbox';
    var track = el('span', 'rc-delta-track');
    var label = el('span', 'rc-delta-label', 'Week-on-week Δ');
    wrap.appendChild(box);
    wrap.appendChild(track);
    wrap.appendChild(label);
    var stored = null;
    try { stored = localStorage.getItem('rbi-show-delta'); } catch (e) { stored = null; }
    var apply = function (on) {
      box.checked = on;
      document.documentElement.classList.toggle('rc-no-delta', !on);
      try { localStorage.setItem('rbi-show-delta', on ? '1' : '0'); } catch (e) { /* private mode */ }
    };
    apply(stored !== '0');
    box.addEventListener('change', function () {
      apply(box.checked);
      wrap.classList.remove('rc-squish');
      void wrap.offsetWidth;
      wrap.classList.add('rc-squish');
    });
    host.appendChild(wrap);
  }

  /* ── 7. Filter disclosure ─────────────────────────────────────────────────
     The date-range row folds behind a summary that counts the active filters.
     The inputs stay in the DOM (so `applyDateRange` keeps working). */

  function filterDisclosure(row) {
    mark(row, 'filter-disclosure');
    row.classList.add('rc-filters');
    var toggle = el('button', 'rc-filters-toggle');
    toggle.type = 'button';
    // Open, like the strip was before anything was added to it. Collapsing the
    // date-range inputs by default would take a control the site already showed
    // and hide it behind a disclosure, which is a change in function rather
    // than a change in style.
    toggle.setAttribute('aria-expanded', 'true');
    var label = function () {
      var from = document.getElementById('range-from');
      var to = document.getElementById('range-to');
      var count = (from && from.value ? 1 : 0) + (to && to.value ? 1 : 0);
      toggle.textContent = count ? 'Filters · ' + count + ' active' : 'Filters · date range';
    };
    label();
    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      row.classList.toggle('rc-filters-folded', open);
    });
    row.parentNode.insertBefore(toggle, row);
    row.addEventListener('change', label);
  }

  /* ── 8. Stepper ───────────────────────────────────────────────────────────
     A numeric − / + that drives the table-length buttons the app already reads,
     so the page keeps one page model. */

  function stepper(host) {
    if (host.querySelector('.rc-stepper')) return;
    mark(host, 'stepper');
    var box = el('span', 'rc-stepper');
    var steps = [['−', -1, 'Shorter range'], ['+', 1, 'Longer range']];
    var readout = el('span', 'rc-stepper-val');
    var current = function () {
      var on = host.querySelector('button.tab.on');
      return on ? text(on) : '—';
    };
    var sync = function () { readout.textContent = current(); };
    for (var i = 0; i < steps.length; i++) {
      (function (step) {
        var b = el('button', 'rc-stepper-btn', step[0]);
        b.type = 'button';
        b.setAttribute('aria-label', step[2]);
        b.addEventListener('click', function () {
          var all = [].slice.call(host.querySelectorAll('button.tab'));
          var index = all.indexOf(host.querySelector('button.tab.on'));
          if (index < 0) index = 0;
          var next = Math.max(0, Math.min(all.length - 1, index + step[1]));
          if (all[next] && next !== index) {
            all[next].click();
            setTimeout(sync, 0);
          }
        });
        box.appendChild(b);
        if (step[1] < 0) box.appendChild(readout);
      })(steps[i]);
    }
    host.appendChild(box);
    host.addEventListener('click', function () { setTimeout(sync, 0); });
    sync();
  }

  /* ── 9. Skiper68 — numeric threshold ──────────────────────────────────────
     Hides weekly rows whose reserves change is smaller than the figure typed,
     by the Δ the row already prints. Clearing it restores every row. */

  function numericThreshold(host) {
    if (host.querySelector('.rc-num')) return;
    var wrap = el('label', 'rc-num');
    wrap.setAttribute('data-component', 'skiper68');
    wrap.setAttribute('data-ct-done', '1');
    var caption = el('span', 'rc-num-label', 'Min |Δ reserves| (USD mn)');
    var input = el('input', 'rc-num-input');
    input.type = 'number';
    input.min = '0';
    input.step = '1000';
    input.inputMode = 'decimal';
    input.placeholder = 'e.g. 5000';
    input.setAttribute('aria-label', 'Minimum weekly change in foreign exchange reserves, in USD million');
    wrap.appendChild(caption);
    wrap.appendChild(input);
    host.appendChild(wrap);

    var apply = function () {
      var min = parseFloat(input.value);
      var body = document.getElementById('tbl-body');
      if (!body) return;
      var rows = body.querySelectorAll('tr');
      for (var i = 0; i < rows.length; i++) {
        if (!isFinite(min)) { rows[i].classList.remove('rc-row-hidden'); continue; }
        // The delta, not the cell's first number: each value cell holds the
        // level (7,16,907) and then the change (+9,905), and reading the first
        // number compared levels against a change threshold — which hid every
        // row on any threshold above the smallest level.
        var cell = rows[i].children[1];
        var delta = cell ? cell.querySelector('.cell-delta') : null;
        var match = delta ? text(delta).match(/-?[\d,]+(\.\d+)?/) : null;
        var value = match ? Math.abs(Number(match[0].replace(/,/g, ''))) : NaN;
        // A week with no previous week to compare against has no delta, and a
        // row that cannot be judged is kept rather than silently dropped.
        if (!delta) { rows[i].classList.remove('rc-row-hidden'); continue; }
        rows[i].classList.toggle('rc-row-hidden', !(isFinite(value) && value >= min));
      }
    };
    input.addEventListener('input', apply);
    // The table is rebuilt from data on every range or date change, which
    // replaces the rows the filter had hidden.
    var body = document.getElementById('tbl-body');
    if (body && window.MutationObserver) {
      new MutationObserver(apply).observe(body, { childList: true });
    }
  }

  /* ── 10. Inline table control ─────────────────────────────────────────────
     The table's own filter row gets the one control it was missing: set both
     dates by "weeks back" and apply them through the inputs the app reads. */

  function inlineTableControl(row) {
    if (row.querySelector('.rc-inline')) return;
    mark(row, 'inline-table-control');
    var box = el('span', 'rc-inline');
    var caption = el('label', 'rc-inline-label', 'Weeks back');
    caption.setAttribute('for', 'rc-weeks-back');
    var input = el('input', 'rc-inline-input');
    input.id = 'rc-weeks-back';
    input.type = 'number';
    input.min = '1';
    input.max = '260';
    input.step = '1';
    input.placeholder = '26';
    input.setAttribute('aria-label', 'Set the From date this many weeks before the To date');
    var apply = el('button', 'rc-inline-apply', 'Apply');
    apply.type = 'button';
    apply.addEventListener('click', function () {
      var weeks = parseInt(input.value, 10);
      var to = document.getElementById('range-to');
      var from = document.getElementById('range-from');
      if (!isFinite(weeks) || weeks < 1 || !to || !from) {
        input.setCustomValidity('Enter a number of weeks (1–260).');
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      var anchor = to.value ? new Date(to.value + 'T00:00:00') : new Date();
      if (isNaN(anchor.getTime())) anchor = new Date();
      var start = new Date(anchor.getTime() - weeks * 7 * 86400000);
      var iso = start.toISOString().slice(0, 10);
      from.value = iso;
      if (!to.value) to.value = anchor.toISOString().slice(0, 10);
      // The app listens for change on these inputs; both events are sent so the
      // same path runs whether it reads input or change.
      from.dispatchEvent(new Event('change', { bubbles: true }));
      from.dispatchEvent(new Event('input', { bubbles: true }));
    });
    box.appendChild(caption);
    box.appendChild(input);
    box.appendChild(apply);
    row.appendChild(box);
  }

  /* ── 11. Swipe row ────────────────────────────────────────────────────────
     Weekly table rows are fixed height, so they can carry a swipe action on a
     touch screen and the same action behind a keyboard toggle. */

  function swipeRow(tr) {
    if (tr.closest('thead') || tr.querySelector('.rc-swipe-action')) return;
    mark(tr, 'swipe-row');
    tr.classList.add('rc-swipe');

    // The action lives in a cell of its own: a <button> directly inside a <tr>
    // is invalid markup, and the browser would move it out during parsing.
    var actionCell = el('td', 'rc-swipe-cell');
    tr.appendChild(actionCell);
    var action = el('button', 'rc-swipe-action', 'Copy row');
    action.type = 'button';
    action.tabIndex = -1;
    action.setAttribute('aria-hidden', 'true');
    action.addEventListener('click', function (event) {
      event.stopPropagation();
      copy(text(tr), function () {
        action.textContent = 'Copied';
        setTimeout(function () { action.textContent = 'Copy row'; }, 1200);
      });
      tr.classList.remove('rc-swiped');
    });
    actionCell.appendChild(action);

    var startX = null;
    tr.addEventListener('touchstart', function (event) {
      startX = event.touches[0] ? event.touches[0].clientX : null;
    }, { passive: true });
    tr.addEventListener('touchend', function (event) {
      if (startX === null) return;
      var endX = event.changedTouches[0] ? event.changedTouches[0].clientX : startX;
      var dx = endX - startX;
      startX = null;
      if (dx < -40) tr.classList.add('rc-swiped');
      else if (dx > 40) tr.classList.remove('rc-swiped');
    }, { passive: true });

    // No tabindex on the row. This cell repeats what the row menu already
    // offers, and a tab stop per row turned a ten-row table into ten stops on
    // a control with nothing unique to say. The keyboard path to the same
    // action is the menu button in the last cell, which is a real button.
  }

  /* ── 12. Warm tooltip ─────────────────────────────────────────────────────
     Real glossary text off `data-glossary`, and the chart's own note for chart
     titles — nothing invented on screen that the markup did not already say. */

  function warmTooltip(node, message) {
    mark(node, 'warm-tooltip');
    node.classList.add('rc-has-tip');
    if (message) node.setAttribute('data-tip', message);
    if (!node.hasAttribute('data-tip')) node.setAttribute('data-tip', text(node));
    if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '0');
  }

  /* ── 13. Animated counter ─────────────────────────────────────────────────
     Counts a figure up to the value the app rendered, then restores the exact
     text — separators, decimals and the em dash included. Under reduce it does
     nothing at all. */

  /* The figure is the way to the rows behind it. Every metric card on this page
     summarises the weekly table, so the value is a real button that opens that
     section; the card's own carousel click still works around it. */
  function openWeeklyTable() {
    var link = document.querySelector('.nav-link[href="#sec-table"]');
    if (link) link.click();
    else location.hash = '#tab=table';
  }

  function counter(node) {
    var finalText = text(node);
    if (!finalText || finalText === '—') return;
    var match = finalText.match(/-?[\d,]+(\.\d+)?/);
    if (!match) return;
    mark(node, 'animated-counter');

    var figure = el('button', 'rc-figure', finalText);
    figure.type = 'button';
    figure.setAttribute('aria-label', finalText + ' — open the weekly table');
    figure.addEventListener('click', function (event) {
      event.stopPropagation();
      openWeeklyTable();
    });
    node.textContent = '';
    node.appendChild(figure);

    var target = Number(match[0].replace(/,/g, ''));
    if (reduced() || !isFinite(target) || target > 1e12) return;
    var decimals = (match[1] || '').length - (match[1] ? 1 : 0);
    var prefix = finalText.slice(0, match.index);
    var suffix = finalText.slice(match.index + match[0].length);
    var started = performance.now();
    function frame(now) {
      var t = Math.min(1, (now - started) / 600);
      var eased = 1 - Math.pow(1 - t, 3);
      var value = target * eased;
      figure.textContent = prefix + (decimals > 0 ? value.toFixed(decimals) : Math.round(value).toLocaleString('en-IN')) + suffix;
      if (t < 1) requestAnimationFrame(frame);
      else figure.textContent = finalText;
    }
    requestAnimationFrame(frame);
  }

  /* ── 14. GitHub activity (weekly Δ heatmap) ───────────────────────────────
     The contribution grid fed by this site's own metric: the week-on-week change
     in foreign-exchange reserves. Positive weeks rise through the levels, the
     footer ranks the five largest moves. Display-only, as the manifest says. */

  function activityGrid(host) {
    var list = rows();
    if (list.length < 8) return;
    mark(host, 'github-activity');
    host.classList.add('rc-activity');

    var changes = [];
    for (var i = 1; i < list.length; i++) {
      var prev = Number(list[i - 1].total_usd);
      var now = Number(list[i].total_usd);
      if (!isFinite(prev) || !isFinite(now)) continue;
      changes.push({ date: list[i].date, delta: now - prev });
    }
    if (changes.length < 6) return;
    var peak = changes.reduce(function (max, c) { return Math.max(max, Math.abs(c.delta)); }, 0) || 1;

    var drill = el('button', 'rc-drill', 'Open the weekly table →');
    drill.type = 'button';
    drill.setAttribute('aria-label', 'Open the weekly table behind this activity grid');
    drill.addEventListener('click', openWeeklyTable);
    host.appendChild(drill);

    var grid = el('div', 'rc-activity-grid');
    grid.setAttribute('role', 'img');
    grid.setAttribute('aria-label', 'Weekly change in foreign-exchange reserves, newest last');
    for (var k = 0; k < changes.length; k++) {
      var c = changes[k];
      var level = c.delta < 0 ? 'neg' : Math.min(4, Math.max(1, Math.ceil((c.delta / peak) * 4)));
      var cell = el('span', 'rc-activity-cell rc-level-' + level);
      cell.title = fmtDate(c.date) + ': ' + (c.delta >= 0 ? '+' : '') + fmtNumber(c.delta) + ' USD mn';
      grid.appendChild(cell);
    }
    host.appendChild(grid);

    var top = changes.slice().sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); }).slice(0, 5);
    host.appendChild(el('h3', 'rc-activity-sub', 'Largest weekly moves'));
    var foot = el('ol', 'rc-activity-list');
    for (var t = 0; t < top.length; t++) {
      var item = el('li', 'rc-activity-item');
      item.appendChild(el('span', 'rc-activity-name', fmtDate(top[t].date)));
      item.appendChild(el('span', 'rc-activity-count ' + (top[t].delta >= 0 ? 'rc-up' : 'rc-down'),
        (top[t].delta >= 0 ? '+' : '') + fmtNumber(top[t].delta)));
      foot.appendChild(item);
    }
    host.appendChild(foot);
  }

  /* ── 15. Analytics chart ──────────────────────────────────────────────────
     One series, drawn as inline SVG from the committed records: total reserves
     over time, with a keyboard- and pointer-readable read-out. Chart.js keeps
     every multi-series chart on the page; this is the single-series trend the
     design system asks for, and it costs no library. */

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function analyticsChart(host) {
    var list = rows();
    if (list.length < 4) return;
    mark(host, 'analytics-chart');
    host.classList.add('rc-chart');

    var points = list.map(function (r) { return { date: r.date, value: Number(r.total_usd) }; })
      .filter(function (p) { return isFinite(p.value); });
    if (points.length < 4) return;

    var width = 640;
    var height = 180;
    var pad = 8;
    var values = points.map(function (p) { return p.value; });
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = (max - min) || 1;
    var step = (width - pad * 2) / (points.length - 1);
    var coords = points.map(function (p, i) {
      return { x: pad + i * step, y: pad + (1 - (p.value - min) / span) * (height - pad * 2), point: p };
    });

    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'rc-chart-svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Foreign-exchange reserves in USD million, ' + points.length + ' weekly observations');

    var line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('class', 'rc-chart-line');
    line.setAttribute('points', coords.map(function (c) { return c.x + ',' + c.y; }).join(' '));
    svg.appendChild(line);

    var last = coords[coords.length - 1];
    var dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', 'rc-chart-dot');
    dot.setAttribute('cx', String(last.x));
    dot.setAttribute('cy', String(last.y));
    dot.setAttribute('r', '3');
    svg.appendChild(dot);

    host.appendChild(svg);

    var readout = el('p', 'rc-chart-readout');
    readout.setAttribute('aria-live', 'polite');
    var show = function (index) {
      var c = coords[Math.max(0, Math.min(coords.length - 1, index))];
      readout.textContent = fmtDate(c.point.date) + ' · ' + fmtNumber(c.point.value) + ' USD mn';
      host.style.setProperty('--rc-chart-x', c.x + 'px');
      return c;
    };
    var active = coords.length - 1;
    show(active);
    svg.addEventListener('pointermove', function (event) {
      var box = svg.getBoundingClientRect();
      if (!box.width) return;
      var ratio = (event.clientX - box.left) / box.width;
      active = Math.round(ratio * (coords.length - 1));
      show(active);
    });
    svg.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowRight') { active = Math.min(coords.length - 1, active + 1); show(active); }
      else if (event.key === 'ArrowLeft') { active = Math.max(0, active - 1); show(active); }
      else if (event.key === 'Home') { active = 0; show(active); }
      else if (event.key === 'End') { active = coords.length - 1; show(active); }
      else return;
      event.preventDefault();
    });
    host.appendChild(readout);
  }

  /* ── 16. Skiper74 — sticky observation header ─────────────────────────────
     A sticky strip whose date is the observation the page is looking at: the
     section in view names itself, and the date is the newest committed record
     (the same one the snapshot text uses). Rebuilt from documented behaviour. */

  function stickyHeader() {
    if (document.getElementById('rc-sticky')) return;
    var bar = el('div', 'rc-sticky');
    bar.id = 'rc-sticky';
    bar.setAttribute('data-component', 'skiper74');
    bar.setAttribute('role', 'status');
    var what = el('span', 'rc-sticky-what', 'Dashboard');
    var when = el('span', 'rc-sticky-when', '');
    var open = el('button', 'rc-sticky-open', 'Table →');
    open.type = 'button';
    open.setAttribute('aria-label', 'Open the weekly table');
    open.addEventListener('click', openWeeklyTable);
    bar.appendChild(what);
    bar.appendChild(when);
    bar.appendChild(open);
    var header = document.querySelector('header');
    if (header && header.parentNode) header.parentNode.insertBefore(bar, header.nextSibling);
    else document.body.insertBefore(bar, document.body.firstChild);

    var sections = [].slice.call(document.querySelectorAll('.section')).map(function (span) {
      return { el: span, name: (span.id || '').replace('sec-', '') };
    });
    var sync = function () {
      var list = rows();
      var latest = list.length ? list[list.length - 1] : null;
      when.textContent = latest ? 'week ended ' + fmtDate(latest.date) : 'awaiting data';
      // Only the rendered section counts, and it is decided on every call: a
      // hidden section reports a top of zero, so the *last* one used to win on
      // a fresh load (the bar read "PM CARES" on the dashboard), while a list
      // filtered once at build time could never name a section opened later.
      var visible = sections.filter(function (entry) { return entry.el.getClientRects().length > 0; });
      // The section whose top has most recently passed under the sticky bar is
      // the one being read; sections are in document order, so the last match
      // wins without comparing offsets.
      var current = visible[0] || null;
      for (var i = 0; i < visible.length; i++) {
        if (visible[i].el.getBoundingClientRect().top <= 140) current = visible[i];
      }
      if (current) {
        var label = current.name === 'dashboard' ? 'Dashboard'
          : current.name === 'table' ? 'Weekly table'
          : current.name === 'compare' ? 'Compare'
          : current.name === 'crude' ? 'Crude imports'
          : current.name === 'pmcares' ? 'PM CARES' : current.name;
        what.textContent = label;
      }
    };
    // The scan calls this again when the app's data lands, because the first
    // pass happens before `records` exists and would say "awaiting data" for
    // the rest of the session.
    bar.rcSync = sync;
    // A navigation swaps which section is on screen without scrolling, so the
    // label has to be refreshed after a click too, not only on scroll. The app
    // can finish the swap a frame or two after the handler returns, so it is
    // read once after paint and once more shortly after.
    document.addEventListener('click', function () {
      afterPaint(sync);
      setTimeout(sync, 160);
    });
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; sync(); });
    }, { passive: true });
    window.addEventListener('resize', sync);
    sync();
  }

  /* ── 17. Transaction list ─────────────────────────────────────────────────
     A compact card of the newest weeks; a row expands to the week's own figures
     from the same record the charts use. Display-only per the manifest, so the
     rows are readable without being controls. */

  function transactionList(host) {
    var list = rows();
    if (list.length < 3) return;
    mark(host, 'transaction-list');
    host.classList.add('rc-txlist');
    var recent = list.slice(-6).reverse();
    for (var i = 0; i < recent.length; i++) {
      (function (record, index) {
        var prev = list[list.length - 2 - index];
        var delta = prev ? Number(record.total_usd) - Number(prev.total_usd) : NaN;
        var card = el('div', 'rc-txitem');
        var head = el('div', 'rc-tx-row');
        head.appendChild(el('span', 'rc-tx-date', fmtDate(record.date)));
        var value = el('span', 'rc-tx-value', fmtNumber(record.total_usd));
        value.title = 'Forex reserves, USD million';
        head.appendChild(value);
        card.appendChild(head);
        var detail = el('div', 'rc-tx-detail');
        detail.textContent = 'Gold ' + fmtNumber(record.gold_usd) + ' · USD/INR ' + fmtNumber(record.usd_inr, 2)
          + (isFinite(delta) ? ' · Δ ' + (delta >= 0 ? '+' : '') + fmtNumber(delta) : '');
        card.appendChild(detail);
        var open = el('button', 'rc-tx-open', 'Open in the weekly table');
        open.type = 'button';
        open.setAttribute('aria-label', 'Open the week of ' + fmtDate(record.date) + ' in the weekly table');
        open.addEventListener('click', openWeeklyTable);
        card.appendChild(open);
        host.appendChild(card);
      })(recent[i], i);
    }
  }

  /* ── 18. Fund widget ──────────────────────────────────────────────────────
     A vertical carousel over the metric cards the app already painted: the
     highlighted figure moves, and every item keeps the value the app rendered.
     Drag is replaced by ↑/↓ and two buttons, which is the keyboard path the
     component is required to have. */

  function fundWidget(host) {
    var cards = host.querySelectorAll('.mc');
    if (cards.length < 3 || host.hasAttribute('data-ct-widget')) return;
    host.setAttribute('data-ct-widget', '1');
    mark(host, 'fund-widget');
    host.classList.add('rc-fund');
    var bar = el('div', 'rc-fund-bar');
    var prev = el('button', 'rc-fund-btn', '↑');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous metric');
    var next = el('button', 'rc-fund-btn', '↓');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next metric');
    var index = 0;
    var select = function (nextIndex, focus) {
      var list = host.querySelectorAll('.mc');
      if (!list.length) return;
      index = (nextIndex + list.length) % list.length;
      for (var i = 0; i < list.length; i++) {
        list[i].classList.toggle('rc-fund-current', i === index);
        list[i].setAttribute('aria-current', String(i === index));
      }
      if (focus) {
        host.setAttribute('tabindex', '-1');
        host.focus({ preventScroll: false });
      }
    };
    prev.addEventListener('click', function () { select(index - 1, true); });
    next.addEventListener('click', function () { select(index + 1, true); });
    var first = null;
    for (var i = 0; i < cards.length; i++) {
      (function (card, at) {
        card.classList.add('rc-fund-item');
        card.addEventListener('click', function () { select(at, false); });
        if (at === 0) first = card;
      })(cards[i], i);
    }
    host.setAttribute('tabindex', '0');
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', 'Latest weekly figures');
    host.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') { select(index + 1, false); event.preventDefault(); }
      else if (event.key === 'ArrowUp') { select(index - 1, false); event.preventDefault(); }
      else if (event.key === 'Home') { select(0, false); event.preventDefault(); }
      else if (event.key === 'End') { select(cards.length - 1, false); event.preventDefault(); }
    });
    bar.appendChild(prev);
    bar.appendChild(next);
    if (first) host.insertBefore(bar, first);
    else host.appendChild(bar);
    select(0, false);
  }

  /* ── 19. Expandable profile card ──────────────────────────────────────────
     The reserves card carries a real dialog: the split behind the headline
     figure (FCA, gold, SDR, IMF reserve position) for the newest week. Built on
     the shared dialog contract — role=dialog, aria-modal, Escape, focus trap
     and focus return — with no runtime <style> and no inline style. */

  function expandableCard(card) {
    if (card.querySelector('.rc-card-open')) return;
    var label = card.querySelector('.mc-label');
    if (!label) return;
    mark(card, 'expandable-profile-card');
    var trigger = el('button', 'rc-card-open', 'Details');
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'dialog');
    card.appendChild(trigger);

    var modal = null;
    var lastFocus = null;

    var close = function () {
      if (!modal) return;
      modal.classList.remove('rc-open');
      document.documentElement.classList.remove('rc-scroll-lock');
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    };

    var open = function () {
      var list = rows();
      var latest = list.length ? list[list.length - 1] : null;
      if (!latest) return;
      if (!modal) {
        modal = el('div', 'rc-dialog');
        modal.setAttribute('data-ct-done', '1');
        var panel = el('div', 'rc-dialog-panel');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', text(label) + ' — latest week');
        var closeBtn = el('button', 'rc-dialog-close', 'Close');
        closeBtn.type = 'button';
        panel.appendChild(closeBtn);
        var body = el('div', 'rc-dialog-body');
        panel.appendChild(body);
        modal.appendChild(panel);
        card.appendChild(modal);
        closeBtn.addEventListener('click', close);
        modal.addEventListener('click', function (event) { if (event.target === modal) close(); });
        document.addEventListener('keydown', function (event) {
          if (event.key === 'Escape' && modal.classList.contains('rc-open')) close();
          if (event.key !== 'Tab' || !modal.classList.contains('rc-open')) return;
          var focusable = panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
          if (!focusable.length) return;
          var firstEl = focusable[0];
          var lastEl = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === firstEl) { lastEl.focus(); event.preventDefault(); }
          else if (!event.shiftKey && document.activeElement === lastEl) { firstEl.focus(); event.preventDefault(); }
        });
        modal.dataset.ready = '1';
      }
      var body = modal.querySelector('.rc-dialog-body');
      var lines = [
        ['Week ended', fmtDate(latest.date)],
        ['Foreign-currency assets', fmtNumber(latest.fca_usd) + ' USD mn'],
        ['Gold', fmtNumber(latest.gold_usd) + ' USD mn'],
        ['SDRs', fmtNumber(latest.sdr_usd) + ' USD mn'],
        ['IMF reserve position', fmtNumber(latest.imf_reserve_usd) + ' USD mn'],
        ['Total reserves', fmtNumber(latest.total_usd) + ' USD mn'],
        ['USD/INR (weekly)', fmtNumber(latest.usd_inr, 2)],
      ];
      body.innerHTML = '<h3 class="rc-dialog-title">' + escapeText(text(label)) + '</h3>' +
        '<dl class="rc-dialog-list">' + lines.map(function (pair) {
          return '<div class="rc-dialog-row"><dt>' + escapeText(pair[0]) + '</dt><dd>' + escapeText(pair[1]) + '</dd></div>';
        }).join('') + '</dl>' +
        '<p class="rc-dialog-note">Values as reported in the committed RBI WSS snapshot. Gold is the valuation held by RBI; it moves with both tonnage and price.</p>';
      lastFocus = document.activeElement;
      modal.classList.add('rc-open');
      document.documentElement.classList.add('rc-scroll-lock');
      // Focus goes to the Close button. The earlier version also toggled
      // `aria-hidden` on the panel, and after the first close the panel stayed
      // hidden: a dialog that was on screen was announced as hidden and focus
      // was refused, so nothing inside it could be reached. Hiding is the
      // `display:none` of the closed state, which is enough.
      var focusTarget = modal.querySelector('.rc-dialog-close');
      if (focusTarget) {
        focusTarget.focus();
        setTimeout(function () {
          if (document.activeElement !== focusTarget) focusTarget.focus();
        }, 0);
      }
    };

    trigger.addEventListener('click', open);
  }

  function escapeText(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ── 20. Inline disclosure menu ───────────────────────────────────────────
     Per-row actions on a weekly row: copy the row, or put that Friday into the
     compare picker — both real, and neither writes to the store. */

  function rowMenu(tr) {
    if (tr.closest('thead') || tr.hasAttribute('data-rc-menu')) return;
    tr.setAttribute('data-rc-menu', '1');
    var dateCell = tr.querySelector('.date-cell');
    if (!dateCell) return;
    mark(tr, 'inline-disclosure-menu');
    // The date link, not the cell: the newest row also carries a LATEST badge,
    // which made the control read "Actions for 9 Oct 2026latest".
    var name = text(dateCell.querySelector('a') || dateCell);
    var btn = el('button', 'rc-rowmenu-btn', '⋮');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Actions for ' + name);
    var menu = el('div', 'rc-rowmenu');
    menu.hidden = true;
    menu.innerHTML =
      '<button type="button" class="rc-rowmenu-item" data-rc-act="copy">Copy row</button>' +
      '<button type="button" class="rc-rowmenu-item" data-rc-act="compare">Compare with latest</button>';
    var cell = el('td', 'rc-rowmenu-cell');
    cell.appendChild(btn);
    cell.appendChild(menu);
    tr.appendChild(cell);
    var compareItem = menu.querySelector('[data-rc-act="compare"]');
    // On the newest row there is no later week to compare against, so the item
    // is disabled rather than quietly comparing the week with itself. It is
    // decided when the menu opens, because the table's range can change.
    var syncItems = function () {
      if (!compareItem) return;
      var list = rows();
      var latest = list.length ? list[list.length - 1].date : null;
      var self = latest && isoFromRow(tr) === latest;
      compareItem.disabled = !!self;
      compareItem.title = self ? 'This is already the latest week' : '';
    };
    btn.addEventListener('click', function (event) {
      event.stopPropagation();
      syncItems();
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
    });
    menu.addEventListener('click', function (event) {
      var action = event.target.getAttribute('data-rc-act');
      if (event.target.disabled) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
      if (action === 'copy') {
        event.preventDefault();
        copy(text(tr), function () { event.target.textContent = 'Copied'; });
      } else if (action === 'compare') {
        event.preventDefault();
        // From = this row's Friday, To = the newest one the picker offers.
        var iso = isoFromRow(tr);
        var from = document.getElementById('cmp-from');
        var to = document.getElementById('cmp-to');
        if (iso && from && to) {
          // The pickers list the newest week first, so the latest is options[0];
          // reading the last option compared the row against the oldest week in
          // the file instead.
          var newest = to.options.length ? to.options[0].value : to.value;
          from.value = iso;
          to.value = newest;
          from.dispatchEvent(new Event('change', { bubbles: true }));
          to.dispatchEvent(new Event('change', { bubbles: true }));
          try {
            var compareLink = document.querySelector('.nav-link[href="#sec-compare"]');
            if (compareLink) compareLink.click();
            else if (typeof showSection === 'function') showSection('compare', null, { focus: false });
          } catch (e) { /* navigation is a nicety; the picker is already set */ }
          toast('Compare ready', name + ' against the latest week.');
        }
      }
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('click', function (event) {
      if (!cell.contains(event.target)) {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ── 21. Time undo action ─────────────────────────────────────────────────
     Swapping the compare weeks applies immediately; the bar that follows is the
     undo window, not a delay, and Undo puts both selectors back. */

  function undoableSwap() {
    var swap = document.getElementById('cmp-swap');
    if (!swap || swap.hasAttribute('data-rc-undo')) return;
    swap.setAttribute('data-rc-undo', '1');
    mark(swap, 'time-undo-action');
    swap.addEventListener('click', function () {
      var from = document.getElementById('cmp-from');
      var to = document.getElementById('cmp-to');
      if (!from || !to) return;
      var was = { from: from.value, to: to.value };
      setTimeout(function () {
        var now = { from: from.value, to: to.value };
        if (now.from === was.from && now.to === was.to) return;
        offerUndo(was.from + ' → ' + was.to, function () {
          from.value = was.from;
          to.value = was.to;
          from.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }, 0);
    });
  }

  function offerUndo(label, restore) {
    var old = document.getElementById('rc-undo');
    if (old) old.remove();
    var bar = el('div', 'rc-undo');
    bar.id = 'rc-undo';
    bar.setAttribute('role', 'status');
    bar.appendChild(el('span', 'rc-undo-label', 'Comparing ' + label + '.'));
    var btn = el('button', 'rc-undo-btn', 'Undo');
    btn.type = 'button';
    bar.appendChild(btn);
    document.body.appendChild(bar);
    var timer = setTimeout(function () { bar.remove(); }, 6000);
    btn.addEventListener('click', function () {
      clearTimeout(timer);
      restore();
      bar.remove();
    });
  }

  /* ── 22. Fluid tabs ───────────────────────────────────────────────────────
     The compare view's two existing surfaces become real tabs: the metric cards
     and the side-by-side table, with roving tabindex and arrow keys. */

  function fluidTabs(host) {
    if (host.dataset.rcTabs === '1' && host.querySelector('.rc-tablist')) return;
    var grid = host.querySelector('#cmp-grid');
    var table = host.querySelector('.tbl-wrap');
    if (!grid || !table) return;

    var bar = el('div', 'rc-tablist');
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Comparison view');
    var panels = [];
    var tabs = [];
    var pairs = [['Cards', grid], ['Table', table]];

    for (var i = 0; i < pairs.length; i++) {
      (function (pair, index) {
        var panel = el('div', 'rc-tabpanel');
        panel.id = 'rc-cmp-panel-' + index;
        panel.setAttribute('role', 'tabpanel');
        panel.tabIndex = 0;
        panel.hidden = index !== 0;
        pair[1].parentNode.insertBefore(panel, pair[1]);
        panel.appendChild(pair[1]);
        panels.push(panel);

        var tab = el('button', 'rc-tab', pair[0]);
        tab.type = 'button';
        tab.id = 'rc-cmp-tab-' + index;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', panel.id);
        tab.setAttribute('aria-selected', String(index === 0));
        tab.tabIndex = index === 0 ? 0 : -1;
        panel.setAttribute('aria-labelledby', tab.id);
        bar.appendChild(tab);
        tabs.push(tab);
      })(pairs[i], i);
    }
    host.insertBefore(bar, panels[0]);
    var select = function (index, focus) {
      for (var k = 0; k < tabs.length; k++) {
        var on = k === index;
        tabs[k].setAttribute('aria-selected', String(on));
        tabs[k].classList.toggle('rc-tab-on', on);
        tabs[k].tabIndex = on ? 0 : -1;
        panels[k].hidden = !on;
      }
      if (focus) tabs[index].focus();
    };
    select(0, false);
    bar.addEventListener('click', function (event) {
      var tab = event.target.closest ? event.target.closest('.rc-tab') : null;
      if (tab) select(tabs.indexOf(tab), false);
    });
    bar.addEventListener('keydown', function (event) {
      var keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
      if (keys.indexOf(event.key) === -1) return;
      var index = tabs.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      var next = event.key === 'Home' ? 0
        : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      select(next, true);
    });
    host.dataset.rcTabs = '1';
    mark(host, 'fluid-tabs');
  }

  /* ── 23. Scroll island ────────────────────────────────────────────────────
     A floating index of the page's own sections with a progress ring. */

  function scrollIsland() {
    if (document.getElementById('rc-island')) return;
    var island = el('div', 'rc-island');
    island.id = 'rc-island';
    island.setAttribute('data-component', 'scroll-island');
    var ring = el('span', 'rc-island-ring');
    ring.setAttribute('aria-hidden', 'true');
    island.appendChild(ring);
    var list = el('nav', 'rc-island-list');
    list.setAttribute('aria-label', 'Sections');
    var sections = [].slice.call(document.querySelectorAll('.section'));
    sections.forEach(function (span) {
      var id = (span.id || '').replace('sec-', '');
      var b = el('button', 'rc-island-link', id === 'dashboard' ? 'Dashboard' : id === 'pmcares' ? 'PM CARES' : id.charAt(0).toUpperCase() + id.slice(1));
      b.type = 'button';
      b.dataset.rcSection = id;
      b.addEventListener('click', function () {
        // The nav link is clicked, rather than calling showSection directly with
        // a null element: the app marks the active link from the element it was
        // handed, and passing nothing left the nav with no current section. The
        // old lookup also searched for an `onclick` attribute the markup no
        // longer carries (the links are `href="#sec-…"` plus data-click).
        var link = document.querySelector('.nav-link[href="#sec-' + id + '"]');
        if (link) link.click();
        else if (typeof showSection === 'function') showSection(id, null, { focus: false });
        window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
        // The highlight follows the section being read, and that only refreshes
        // on scroll — so a jump to the top has to refresh it too.
        sync();
        setTimeout(sync, 160);
      });
      list.appendChild(b);
    });
    island.appendChild(list);
    document.body.appendChild(island);
    var sync = function () {
      var doc = document.documentElement;
      var progress = doc.scrollHeight > doc.clientHeight
        ? doc.scrollTop / (doc.scrollHeight - doc.clientHeight) : 0;
      island.style.setProperty('--rc-progress', String(Math.max(0, Math.min(1, progress))));
      island.classList.toggle('rc-island-visible', doc.scrollTop > 320);
      var active = document.querySelector('.nav-link.active');
      var id = active ? (active.getAttribute('href') || '').replace('#sec-', '') : '';
      var links = island.querySelectorAll('.rc-island-link');
      for (var i = 0; i < links.length; i++) {
        links[i].classList.toggle('rc-island-on', !!id && links[i].dataset.rcSection === id);
      }
    };
    window.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    sync();
  }

  /* ── 24. Dynamic button ───────────────────────────────────────────────────
     State-changing buttons resize to their label and crossfade. Reimplemented
     from the documented behaviour (the upstream source is unlicensed). */

  function dynamicButton(btn) {
    if (btn.hasAttribute('data-rc-dynamic')) return;
    btn.setAttribute('data-rc-dynamic', '1');
    mark(btn, 'dynamic-button');
    btn.classList.add('rc-dyn');
    var label = btn.querySelector('span.rc-dyn-label');
    if (!label) {
      label = el('span', 'rc-dyn-label', text(btn));
      btn.textContent = '';
      btn.appendChild(label);
    }
    btn.addEventListener('click', function () {
      btn.classList.remove('rc-dyn-busy');
      void btn.offsetWidth;
      btn.classList.add('rc-dyn-busy');
    });
  }

  /* ── 25. Feedback ─────────────────────────────────────────────────────────
     The form is markup and app.js posts it; the layer only marks it and keeps
     the submit button's own state handling in the dynamic button. */

  function feedbackBox(node) {
    mark(node, 'feedback');
    node.setAttribute('data-ct-done', '1');
    var submit = node.querySelector('.feedback-submit');
    if (submit) dynamicButton(submit);
  }

  /* ── Scan ─────────────────────────────────────────────────────────────────
     Runs once at load and then follows the app's own re-renders: the tables, the
     metric cards and the compare grid are all replaced by app.js as data and
     ranges change. */

  function scan() {
    try {
      var theme = document.getElementById('theme-toggle');
      if (theme && !theme.hasAttribute('data-ct-done')) switchMode(theme);

      var nav = document.querySelector('.nav-links');
      if (nav && !nav.hasAttribute('data-ct-done')) gooeyNav(nav);

      fresh('.cmp-select').forEach(glideSelect);

      // Metric cards: the counter animates the value, the widget gives the grid
      // a keyboard path and the card a dialog. app.js rewrites these values as
      // later data lands, which removed the button; a marked node with no
      // figure is upgraded again rather than treated as done.
      document.querySelectorAll('#metrics .mc-val, #metric-extras .mex-val').forEach(function (node) {
        if (!node.querySelector('.rc-figure')) counter(node);
      });
      var metrics = document.getElementById('metrics');
      if (metrics) fundWidget(metrics);

      var em = document.getElementById('emRanges');
      if (em && !em.hasAttribute('data-ct-done')) jellyRadio(em);

      var len = document.querySelector('.tab-row[aria-label="Table length"]');
      if (len) {
        if (!len.hasAttribute('data-ct-done')) rubberSegment(len);
        if (!len.hasAttribute('data-rc-stepper')) {
          len.setAttribute('data-rc-stepper', '1');
          stepper(len);
        }
      }

      var rangeRow = document.querySelector('#sec-table .range-row');
      if (rangeRow) {
        if (!rangeRow.hasAttribute('data-ct-done')) filterDisclosure(rangeRow);
        inlineTableControl(rangeRow);
        numericThreshold(rangeRow);
      }

      var header = document.querySelector('#sec-table .tbl-header');
      if (header && !header.hasAttribute('data-ct-delta')) {
        header.setAttribute('data-ct-delta', '1');
        deltaSwitch(header);
      }

      document.querySelectorAll('#tbl-body tr').forEach(function (tr) {
        swipeRow(tr);
        rowMenu(tr);
      });

      document.querySelectorAll('[data-glossary]').forEach(function (node) {
        if (!node.hasAttribute('data-ct-done')) warmTooltip(node, node.getAttribute('data-glossary'));
      });
      document.querySelectorAll('.chart-hdr').forEach(function (hdr) {
        var title = hdr.querySelector('.chart-title');
        var note = hdr.querySelector('.chart-note');
        if (title && note && !title.hasAttribute('data-ct-done')) warmTooltip(title, text(note));
      });

      // The data sections are added once, then filled on whichever scan the data
      // has arrived on. Creating the holder first and filling it once is what
      // left these three empty in a real browser: the first scan runs before
      // `records` is populated, and the guard on the holder's id meant no later
      // scan ever tried again. Filling is now keyed on the holder being empty.
      var activity = document.getElementById('rc-activity');
      if (!activity) {
        var dash = document.getElementById('sec-dashboard');
        var anchorNode = document.getElementById('rc-weekly-trend') || document.getElementById('metrics');
        if (dash && anchorNode && rows().length >= 8) {
          activity = el('section', 'rc-activity-holder');
          activity.id = 'rc-activity';
          activity.setAttribute('aria-labelledby', 'rc-activity-title');
          activity.innerHTML = '<h2 id="rc-activity-title">Reserves change by week</h2>' +
            '<p class="rc-activity-note">Each cell is one weekly observation: green is a rise in reserves, red a fall, and the stronger the tint the larger the change. Newest is last.</p>';
          anchorNode.parentNode.insertBefore(activity, anchorNode.nextSibling);
        }
      }
      if (activity && !activity.querySelector('.rc-activity-grid')) activityGrid(activity);

      var chartSlot = document.getElementById('rc-weekly-trend');
      if (!chartSlot && rows().length >= 4) {
        var section = document.getElementById('sec-dashboard');
        if (section) {
          chartSlot = el('section', 'rc-chart-holder');
          chartSlot.id = 'rc-weekly-trend';
          chartSlot.innerHTML = '<h2>Reserves: single-series trend</h2>' +
            '<p class="rc-chart-note">Total foreign-exchange reserves, USD million, every committed weekly observation. The multi-series charts on this page stay as they are.</p>';
          section.appendChild(chartSlot);
        }
      }
      if (chartSlot && !chartSlot.querySelector('.rc-chart-svg')) analyticsChart(chartSlot);

      var openCard = document.querySelector('#metrics .mc');
      if (openCard) expandableCard(openCard);

      var listSlot = document.getElementById('rc-recent-weeks');
      if (!listSlot && rows().length >= 3) {
        var anchor = document.getElementById('rc-weekly-trend') || document.getElementById('rc-activity');
        if (anchor) {
          listSlot = el('section', 'rc-txlist-holder');
          listSlot.id = 'rc-recent-weeks';
          listSlot.innerHTML = '<h2>Recent weeks</h2>';
          anchor.parentNode.insertBefore(listSlot, anchor.nextSibling);
        }
      }
      if (listSlot && !listSlot.querySelector('.rc-txitem')) transactionList(listSlot);

      var compare = document.getElementById('cmp-body');
      if (compare) fluidTabs(compare);
      undoableSwap();

      var reload = document.getElementById('start-btn');
      if (reload) dynamicButton(reload);

      var feedback = document.getElementById('feedback');
      if (feedback) feedbackBox(feedback);

      stickyHeader();
      var sticky = document.getElementById('rc-sticky');
      if (sticky && typeof sticky.rcSync === 'function') sticky.rcSync();
      scrollIsland();
    } catch (error) {
      // A component that cannot install must not take the page down with it.
      console.warn('component scan skipped part of the page:', error);
    }
  }

  window.RBIComponents = { scan: scan };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(scan, 0); });
  } else {
    scan();
  }
  var pending = null;
  new MutationObserver(function () {
    if (pending) return;
    pending = setTimeout(function () { pending = null; scan(); }, 60);
  }).observe(document.body, { childList: true, subtree: true });
})();
