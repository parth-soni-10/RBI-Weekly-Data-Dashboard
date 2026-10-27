/* Fund Widget — label/value/change cards on a reel you can spin.
 *
 *   <div class="fw-host" data-fund-widget role="listbox" aria-label="…">
 *     <div class="fw-item">
 *       <div data-fw-label>FY 2020-21</div>
 *       <div data-fw-value>7,013.99</div>
 *       <div data-fw-change data-fw-dir="up">+3,937.37</div>
 *     </div>
 *     …
 *   </div>
 *
 *   var reel = FundWidget.mount(host);   // reel.goTo(i) · reel.refresh() · reel.destroy()
 *
 * The host owns the items, their numbers and their formatting. The kit owns
 * only where those items sit: a vertical ring, the front item square to the
 * viewer and its neighbours turned into the ring above and below. Dragging
 * spins it; releasing snaps to the nearest card. Arrow keys, Home/End and a tap
 * on any card do the same, and the front card is reported as the selection the
 * way a listbox reports one — role="option" with aria-selected, named by the
 * host's aria-activedescendant.
 *
 * Everything is measured from the host's own CSS: --fw-gap is the distance
 * between two cards (78px by default), --fw-h the height of the opening. Nothing
 * is declared in JavaScript that a stylesheet could say, and the layout rules
 * only apply once the kit has marked the host [data-fw-ready] — so with the
 * script missing, the host's cards simply sit one under the other.
 *
 * A host that rebuilds its cards (a render pass, a data load) calls
 * FundWidget.refresh(host) or mount() again: the reel re-collects what is
 * there now and keeps the card it was showing when it can.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var uid = 0;

  var RANGE = 3;        // cards visible on each side before one is hidden
  var TILT = 21;        // degrees each step turns into the ring
  var DEPTH = 0.92;     // z pull-back per step, as a share of --fw-gap
  var DIM = 0.17;       // opacity lost per step
  var DRAG_SLOP = 4;    // px before a press counts as a drag
  var RUBBER = 0.3;     // how far past the ends a drag may pull

  function num(v, fallback) {
    var n = parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* Past an end the reel gives, in proportion to how hard it is pulled. */
  function soft(v, lo, hi) {
    if (v < lo) return lo + (v - lo) * RUBBER;
    if (v > hi) return hi + (v - hi) * RUBBER;
    return v;
  }

  function itemsOf(host) {
    var found = host.querySelectorAll('[data-fw-item]');
    if (!found.length) found = host.children;
    var out = [];
    for (var i = 0; i < found.length; i++) {
      if (found[i].nodeType === 1) out.push(found[i]);
    }
    return out;
  }

  function gapOf(host) {
    var cs = global.getComputedStyle(host);
    return num(cs.getPropertyValue('--fw-gap'), 78);
  }

  function place(inst) {
    var gap = inst.gap;
    for (var i = 0; i < inst.items.length; i++) {
      var el = inst.items[i];
      var d = i - inst.pos;
      var far = Math.abs(d) > RANGE + 0.85;
      // Off the reel: hidden rather than transformed to a nonsense depth, so
      // text stays crisp and the compositor is not asked to draw the whole ring.
      el.style.visibility = far ? 'hidden' : '';
      if (far) el.setAttribute('aria-hidden', 'true');
      else el.removeAttribute('aria-hidden');
      if (far) continue;
      el.style.transform =
        'translateY(-50%)' +
        ' translateY(' + (d * gap).toFixed(2) + 'px)' +
        ' translateZ(' + (-Math.abs(d) * gap * DEPTH).toFixed(2) + 'px)' +
        ' rotateX(' + (-d * TILT).toFixed(2) + 'deg)';
      el.style.opacity = Math.max(0.12, 1 - Math.abs(d) * DIM).toFixed(3);
      el.style.zIndex = String(200 - Math.round(Math.abs(d) * 20));
    }
  }

  function paint(inst) {
    var i = inst.index;
    for (var k = 0; k < inst.items.length; k++) {
      var el = inst.items[k];
      if (k === i) {
        el.setAttribute('data-fw-front', '');
        el.setAttribute('aria-selected', 'true');
      } else {
        el.removeAttribute('data-fw-front');
        el.setAttribute('aria-selected', 'false');
      }
    }
    var frontEl = inst.items[i];
    if (frontEl && frontEl.id) inst.host.setAttribute('aria-activedescendant', frontEl.id);
    else inst.host.removeAttribute('aria-activedescendant');
  }

  function report(inst, why) {
    inst.host.dispatchEvent(new global.CustomEvent('fund-widget:change', {
      bubbles: true,
      detail: {
        index: inst.index,
        item: inst.items[inst.index] || null,
        value: readField(inst, 'value'),
        change: readField(inst, 'change'),
        reason: why,
      },
    }));
  }

  function readField(inst, name) {
    var el = inst.items[inst.index];
    if (!el) return '';
    var field = el.querySelector('[data-fw-' + name + ']');
    return field ? field.textContent.trim() : '';
  }

  function goTo(inst, i, why) {
    var n = inst.items.length;
    var next = clamp(Math.round(i), 0, Math.max(0, n - 1));
    var changed = next !== inst.index;
    inst.index = next;
    inst.pos = next;              // the settle animation rides on the CSS transition
    place(inst);
    paint(inst);
    if (changed) report(inst, why || 'go');
    return changed;
  }

  /* A resize or a rebuilt list must not animate: the card is already where it
     is, it is just being told where that is. */
  function settle(inst, fn) {
    var host = inst.host;
    host.classList.add('is-quiet');
    fn();
    global.requestAnimationFrame(function () {
      global.requestAnimationFrame(function () { host.classList.remove('is-quiet'); });
    });
  }

  function startDrag(inst, ev) {
    if (ev.button != null && ev.button !== 0) return;
    if (ev.target.closest && ev.target.closest('a,button,input,select,textarea')) return;
    // No capture yet: a press that never moves has to keep its real target, so a
    // tap on a card can be told which card it hit. Capture starts with the drag.
    inst.drag = {
      id: ev.pointerId,
      from: ev.clientY,
      startPos: inst.pos,
      moved: false,
      captured: false,
    };
  }

  function moveDrag(inst, ev) {
    var d = inst.drag;
    if (!d || (d.id != null && ev.pointerId !== d.id)) return;
    var dy = ev.clientY - d.from;
    if (!d.moved && Math.abs(dy) > DRAG_SLOP) {
      d.moved = true;
      inst.host.classList.add('is-dragging');
      if (!d.captured && inst.host.setPointerCapture) {
        try { inst.host.setPointerCapture(d.id); d.captured = true; } catch (e) { /* the drag still works without it */ }
      }
    }
    if (!d.moved) return;
    var n = inst.items.length;
    // Dragging down pulls the cards down, so the card that was above comes to
    // the front: the index falls as the pointer falls.
    inst.pos = soft(d.startPos - dy / inst.gap, 0, n - 1);
    place(inst);
  }

  function endDrag(inst, ev) {
    var d = inst.drag;
    if (!d || (d.id != null && ev.pointerId !== d.id)) return;
    inst.drag = null;
    inst.host.classList.remove('is-dragging');
    if (d.captured && inst.host.releasePointerCapture && inst.host.hasPointerCapture && inst.host.hasPointerCapture(d.id)) {
      try { inst.host.releasePointerCapture(d.id); } catch (e) { /* already gone */ }
    }
    if (d.moved) {
      // Finish on the card the drag was closest to; the snap rides the CSS
      // transition from wherever the pointer left the reel.
      goTo(inst, Math.round(clamp(inst.pos, 0, inst.items.length - 1)), 'drag');
      return;
    }
    // A press that never moved is a tap: bring the card under it to the front.
    var item = ev.target.closest ? ev.target.closest('[data-fw-item]') : null;
    if (!item) return;
    var at = inst.items.indexOf(item);
    if (at >= 0) goTo(inst, at, 'tap');
  }

  function onKey(inst, ev) {
    var n = inst.items.length;
    var step = 0;
    switch (ev.key) {
      case 'ArrowUp': step = -1; break;
      case 'ArrowDown': step = 1; break;
      case 'PageUp': step = -3; break;
      case 'PageDown': step = 3; break;
      case 'Home': step = -n; break;
      case 'End': step = n; break;
      default: return;
    }
    ev.preventDefault();
    goTo(inst, ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1 : inst.index + step, 'key');
  }

  function mount(host, options) {
    if (!host) return null;
    if (host.__fundWidget) return refresh(host.__fundWidget, options);
    var items = itemsOf(host);
    if (!items.length) return null;

    var opts = options || {};
    var inst = {
      host: host,
      items: items,
      opts: opts,
      gap: gapOf(host),
      index: 0,
      pos: 0,
      drag: null,
      hadTabIndex: host.hasAttribute('tabindex'),
    };

    // The instance the caller keeps: move it, re-read it, take it apart.
    inst.goTo = function (i, why) { return goTo(inst, i, why); };
    inst.refresh = function (options) { return refresh(inst, options); };
    inst.destroy = function () { destroy(inst); };

    host.setAttribute('data-fw-ready', '');
    if (!host.hasAttribute('tabindex')) host.tabIndex = 0;
    if (!host.getAttribute('role')) host.setAttribute('role', 'listbox');
    if (!host.hasAttribute('aria-orientation')) host.setAttribute('aria-orientation', 'vertical');
    host.__fundWidget = inst;

    // Identity for aria-activedescendant, and the option role for the cards.
    items.forEach(function (el) {
      if (!el.id) el.id = 'fw-' + (++uid) + '-' + (inst.host.id || 'host');
      if (!el.getAttribute('role')) el.setAttribute('role', 'option');
      if (el.style.visibility) el.style.visibility = '';
    });

    var want = opts.index != null ? opts.index : host.getAttribute('data-fw-index');
    if (want === 'last') want = items.length - 1;
    else if (want != null) want = num(want, 0);
    inst.index = clamp(Math.round(want == null ? 0 : want), 0, items.length - 1);
    inst.pos = inst.index;
    settle(inst, function () { place(inst); paint(inst); });

    inst.onDown = function (ev) { startDrag(inst, ev); };
    inst.onMove = function (ev) { moveDrag(inst, ev); };
    inst.onUp = function (ev) { endDrag(inst, ev); };
    inst.onKey = function (ev) { onKey(inst, ev); };
    host.addEventListener('pointerdown', inst.onDown);
    host.addEventListener('pointermove', inst.onMove);
    host.addEventListener('pointerup', inst.onUp);
    host.addEventListener('pointercancel', inst.onUp);
    host.addEventListener('keydown', inst.onKey);

    if (global.ResizeObserver) {
      inst.ro = new global.ResizeObserver(function () {
        var gap = gapOf(host);
        if (gap !== inst.gap) inst.gap = gap;
        settle(inst, function () { place(inst); });
      });
      inst.ro.observe(host);
    }
    return inst;
  }

  /* Re-read the cards (a host render pass may have replaced them). The card in
     front is kept by identity where possible, by index otherwise. */
  function refresh(inst, options) {
    var host = inst.host;
    var before = inst.items[inst.index] || null;
    var items = itemsOf(host);
    if (!items.length) return inst;
    items.forEach(function (el) {
      if (!el.id) el.id = 'fw-' + (++uid) + '-' + (host.id || 'host');
      if (!el.getAttribute('role')) el.setAttribute('role', 'option');
    });
    inst.items = items;
    if (options && options.index != null) inst.index = clamp(Math.round(options.index), 0, items.length - 1);
    else if (before && items.indexOf(before) >= 0) inst.index = items.indexOf(before);
    else inst.index = clamp(inst.index, 0, items.length - 1);
    inst.pos = inst.index;
    inst.gap = gapOf(host);
    settle(inst, function () { place(inst); paint(inst); });
    return inst;
  }

  function destroy(inst) {
    if (!inst || inst.host.__fundWidget !== inst) return;
    var host = inst.host;
    host.removeEventListener('pointerdown', inst.onDown);
    host.removeEventListener('pointermove', inst.onMove);
    host.removeEventListener('pointerup', inst.onUp);
    host.removeEventListener('pointercancel', inst.onUp);
    host.removeEventListener('keydown', inst.onKey);
    if (inst.ro) inst.ro.disconnect();
    host.removeAttribute('data-fw-ready');
    host.removeAttribute('aria-activedescendant');
    host.classList.remove('is-dragging', 'is-quiet');
    if (!inst.hadTabIndex) host.removeAttribute('tabindex');
    inst.items.forEach(function (el) {
      el.removeAttribute('data-fw-front');
      el.removeAttribute('aria-selected');
      el.removeAttribute('aria-hidden');
      el.style.transform = '';
      el.style.opacity = '';
      el.style.zIndex = '';
      el.style.visibility = '';
    });
    delete host.__fundWidget;
  }

  global.FundWidget = {
    mount: mount,
    /* Mounts if it is not mounted; otherwise re-reads the cards. An index may
       be given, which is also how a host moves the reel from outside. */
    refresh: function (host, index) {
      var el = typeof host === 'string' ? doc.querySelector(host) : host;
      if (!el) return null;
      var options = index == null ? null : { index: index };
      return el.__fundWidget ? refresh(el.__fundWidget, options) : mount(el, options);
    },
    destroy: function (host) {
      var inst = typeof host === 'string' ? doc.querySelector(host) : host;
      if (inst) destroy(inst.__fundWidget);
    },
  };
})(window);
