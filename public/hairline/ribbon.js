/* Ribbon — the weekly reserve series as a signal.
 *
 * The points are the same `records` the metrics and weekly table read. Pointing
 * at a sample reads its week and value; the table below remains the exact,
 * keyboard-accessible source. Missing values are skipped, never drawn as zero.
 *
 * Wrapped in an IIFE: the engine's figures are written at top level, and two of
 * them on one page would collide on their destructured names.
 */
(function () {
const {
  Cam, facing, fit, hull, open, poly, proj, rrect, ringAt, run, seg,
  disposer, mk, pointer,
} = HL;

const N = 12;
const Z = 3.2;

/** A rounded box, drawn from its foot and top rings. */
function boxAt(parent, P, front, cx, cy, hw, hd, z0, z1, r) {
  const foot = rrect(cx - hw, cy - hd, cx + hw, cy + hd, r, 6);
  const top = rrect(cx - hw + 0.8, cy - hd + 0.8, cx + hw - 0.8, cy + hd - 0.8, Math.max(0.6, r - 0.8), 6);
  const g = mk('g', {}, parent);
  const sil = mk('path', { d: poly(hull(ringAt(P, foot, z0).concat(ringAt(P, top, z1)))), class: 'sil' }, g);
  const cr = mk('path', { d: open(ringAt(P, run(top, front), z1)), class: 'nf lo' }, g);
  return { g, sil, cr };
}

function readDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso) + 'T00:00:00');
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();

  const C = Cam(45, 0.5, 2.55);
  fit(C, [[-52, -24, 0], [52, 24, 0], [-52, -24, 8], [52, 24, 8]], 200, 164);
  const P = proj(C), front = facing(C);
  const root = mk('g', {}, svg);

  let items = [];
  let points = [];
  let dots = [];
  let selected = -1;
  let signature = null;

  function readDefault() {
    const n = items.length;
    read.textContent = n ? `${n} weeks · latest ${readDate(items[n - 1].date)}` : 'No weekly data yet';
    stage.setAttribute(
      'aria-label',
      n
        ? `${n} weekly reserve observations on a signal ribbon. Point at a sample to read its week and value.`
        : 'No weekly reserve observations have loaded yet.',
    );
  }

  function build() {
    root.replaceChildren();
    selected = -1;
    points = [];
    dots = [];

    const plate = boxAt(root, P, front, 0, 0, 50, 18, 0, 1.6, 4);
    mk('path', { d: seg(P(-44, 10, 1.7), P(44, 10, 1.7)), class: 'nf dash' }, plate.g);

    const usable = items.filter((x) => Number.isFinite(Number(x.value)));
    if (!usable.length) {
      readDefault();
      return;
    }

    const values = usable.map((x) => Number(x.value));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const step = usable.length > 1 ? 88 / (usable.length - 1) : 0;
    points = usable.map((item, i) => ({
      x: -44 + i * step,
      y: 10 - ((Number(item.value) - min) / span) * 18,
      item,
    }));

    mk('path', { d: open(points.map((p) => P(p.x, p.y, Z))), class: 'sil' }, root);
    dots = points.map((p) => {
      const dot = mk('circle', { r: 2, class: 'dot off' }, root);
      const [sx, sy] = P(p.x, p.y, Z);
      dot.setAttribute('cx', sx.toFixed(2));
      dot.setAttribute('cy', sy.toFixed(2));
      return dot;
    });

    readDefault();
  }

  function highlight(i) {
    if (i === selected) return;
    selected = i;
    dots.forEach((dot, k) => dot.setAttribute('class', k === i ? 'dot' : 'dot off'));
    if (i < 0) {
      readDefault();
      return;
    }
    const p = points[i];
    read.textContent = `${readDate(p.item.date)} · ${Number(p.item.value).toLocaleString('en-IN')} USD mn`;
  }

  function pick(pt) {
    const [u, v] = HL.unproj(C, pt[0], pt[1], Z);
    let best = -1, distance = Infinity;
    points.forEach((p, i) => {
      const d = Math.hypot(u - p.x, v - p.y);
      if (d < distance && d <= 7) {
        distance = d;
        best = i;
      }
    });
    return best;
  }

  function set(next) {
    const list = (Array.isArray(next) ? next : []).slice(-N).map((r) => ({
      date: r && r.date ? String(r.date) : '',
      value: r ? r.total_usd : null,
    }));
    const sig = list.map((x) => `${x.date}:${x.value}`).join('|');
    if (sig === signature) return;
    signature = sig;
    items = list;
    build();
  }

  bag.add(pointer(stage, {
    move: (p) => highlight(pick(p)),
    down: (p) => highlight(pick(p)),
    leave: () => highlight(-1),
  }));
  bag.add(() => svg.replaceChildren());

  set(value);
  return { set, destroy: bag.dispose };
}

hairline({
  name: 'ribbon',
  means: 'Weekly reserve observations on a signal ribbon; point at a sample to read its week and value.',
  rules: [1, 4, 6, 8],
  range: [0, 12, 1],
  tour: [[150, 150], [200, 120], [260, 170], [310, 200], null],
  mount,
});

let ribbonHandle = null;

/** Called from updateUI() with the records the metrics already rendered. */
window.mountRbiRibbon = function (records) {
  const host = document.getElementById('rbi-ribbon');
  if (!host || !window.mountHairline) return;
  if (!ribbonHandle) ribbonHandle = window.mountHairline('rbi-ribbon', records);
  else if (ribbonHandle.set) ribbonHandle.set(records);
};
})();
