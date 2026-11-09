// Gráficos do painel (SVG puro, sem biblioteca), seguindo a skill de dataviz:
// duas séries com legenda + rótulo direto na ponta (o par azul/verde é fraco
// para tritanopia, então a cor nunca vai sozinha), marcas finas, grade
// hairline, tooltip com cursor, navegação por teclado e visão em tabela.
(() => {
  const { el, svg, setText, clear, fmtSpeed, fmtBytes, fmtClock } = window.UI;
  const STEPS = [64, 128, 256, 512, 1024, 2048, 5120, 10240, 20480, 51200, 102400, 204800, 512000, 1048576].map((k) => k * 1024);
  const niceMax = (v) => STEPS.find((s) => s >= v * 1.1) ?? Math.ceil(v * 1.1);
  const speedTick = (n) => (n === 0 ? '0' : fmtSpeed(n));

  // ---------------------------------------------------------- tooltip único
  const tip = {
    node: () => document.getElementById('tip'),
    show(rows, title, x, y) {
      const t = tip.node();
      clear(t);
      t.append(el('div', 'tip-time', title));
      for (const r of rows) {
        const row = el('div', 'tip-row');
        if (r.key) row.append(el('span', `key ${r.key}`));
        row.append(el('b', '', r.value), el('span', '', r.label));
        t.append(row);
      }
      t.hidden = false;
      const left = Math.min(x + 14, window.innerWidth - t.offsetWidth - 8);
      t.style.setProperty('left', `${Math.max(8, left)}px`);
      t.style.setProperty('top', `${Math.max(8, y - t.offsetHeight - 12)}px`);
    },
    hide() { tip.node().hidden = true; },
  };

  // ------------------------------------------------------ gráfico de tráfego
  function trafficChart({ compact = false } = {}) {
    const root = el('div');
    const box = el('div', 'chart');
    box.tabIndex = 0;
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', 'Gráfico de linhas: download e upload da ponte na última hora');
    const tableWrap = el('div', 'table-wrap');
    tableWrap.hidden = true;
    const table = document.createElement('table');
    const cap = el('caption', 'sr', 'Velocidade da ponte, uma linha a cada 5 minutos');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const [h, r] of [['Horário', false], ['Download', true], ['Upload', true]]) { const th = el('th', r ? 'r' : '', h); th.scope = 'col'; hr.append(th); }
    thead.append(hr);
    const tbody = document.createElement('tbody');
    table.append(cap, thead, tbody);
    tableWrap.append(table);
    root.append(box, tableWrap);

    let data = null; let geom = null; let hoverIdx = null;
    let W = 720; let H = compact ? 150 : 230;
    const M = { l: 58, r: compact ? 12 : 104, t: 12, b: 26 };

    function draw() {
      if (!data) return;
      box.querySelectorAll('svg, .chart-empty').forEach((n) => n.remove());
      W = Math.max(300, Math.round(box.clientWidth || 720));
      H = compact ? 150 : (W < 520 ? 190 : 230);
      const end = Date.parse(data.generatedAt);
      const start = end - 3_600_000;
      const pts = data.traffic.filter((p) => p.t >= start);
      const top = niceMax(Math.max(0, ...pts.map((p) => Math.max(p.up, p.down))));
      const x = (t) => M.l + ((t - start) / (end - start)) * (W - M.l - M.r);
      const y = (v) => M.t + (1 - v / top) * (H - M.t - M.b);
      geom = { pts, x };

      const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
      for (const f of [0, 0.5, 1]) {
        const v = top * f;
        s.append(svg('line', { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v) }, f === 0 ? 'axis-l' : 'grid-l'));
        const tk = svg('text', { x: M.l - 8, y: y(v) + 4 }, 'tick tick-y');
        tk.textContent = speedTick(v);
        s.append(tk);
      }
      for (const [off, label] of [[3_600_000, '−60 min'], [1_800_000, '−30 min'], [0, 'agora']]) {
        const tx = svg('text', { x: x(end - off), y: H - 6 }, 'tick tick-x');
        tx.textContent = label;
        s.append(tx);
      }
      const line = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
      const area = (k) => (pts.length > 1 ? `${line(k)}L${x(pts[pts.length - 1].t).toFixed(1)},${y(0)}L${x(pts[0].t).toFixed(1)},${y(0)}Z` : '');
      if (pts.length > 1) {
        for (const k of ['down', 'up']) { s.append(svg('path', { d: area(k) }, `a-${k}`)); s.append(svg('path', { d: line(k) }, `s-${k}`)); }
      }
      const last = pts[pts.length - 1];
      if (last) {
        for (const k of ['down', 'up']) s.append(svg('circle', { cx: x(last.t), cy: y(last[k]), r: 4 }, `dot-${k}`));
        if (!compact) {
          // rótulo direto na ponta; se as linhas se encostam o de cima sobe e o de baixo desce,
          // sempre dentro da área do gráfico (nunca em cima dos rótulos do eixo x)
          const yd = y(last.down); const yu = y(last.up);
          const floor = H - M.b - 3;
          const ys = { down: yd + 4, up: yu + 4 };
          if (Math.abs(yd - yu) < 15) {
            const upper = yd <= yu ? 'down' : 'up'; const lower = upper === 'down' ? 'up' : 'down';
            ys[lower] = Math.min(Math.max(yd, yu) + 15, floor);
            ys[upper] = Math.min(Math.min(yd, yu) - 6, ys[lower] - 14);
          }
          const place = (k) => {
            const t = svg('text', { x: x(last.t) + 10, y: ys[k] }, 'lbl');
            t.textContent = `${k === 'down' ? '↓' : '↑'} ${fmtSpeed(last[k])}`;
            s.append(t);
          };
          place('down');
          place('up');
        }
      }
      const cross = svg('line', { x1: 0, x2: 0, y1: M.t, y2: H - M.b, visibility: 'hidden' }, 'cross');
      cross.id = `cross-${compact ? 'c' : 'f'}`;
      s.append(cross);
      s.append(svg('rect', { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b }, 'hit'));
      box.append(s);
      if (!pts.some((p) => p.up || p.down)) {
        box.append(el('p', 'chart-empty', 'Sem tráfego na última hora. A ponte só transfere quando um filme toca ou há seed ativo.'));
      }
      fillTable();
      if (hoverIdx !== null) show(Math.min(hoverIdx, pts.length - 1));
    }

    function fillTable() {
      clear(tbody);
      const pts = data.traffic;
      for (let i = pts.length - 1, n = 0; i >= 0 && n < 13; i -= 20, n += 1) {
        const tr = document.createElement('tr');
        const c1 = el('td', '', fmtClock(pts[i].t)); const c2 = el('td', 'r', fmtSpeed(pts[i].down)); const c3 = el('td', 'r', fmtSpeed(pts[i].up));
        tr.append(c1, c2, c3);
        tbody.append(tr);
      }
    }

    function show(idx, ev) {
      if (!geom || !geom.pts.length || idx < 0) { hide(); return; }
      const p = geom.pts[idx];
      hoverIdx = idx;
      const cross = box.querySelector('line.cross');
      if (cross) { cross.setAttribute('x1', geom.x(p.t)); cross.setAttribute('x2', geom.x(p.t)); cross.setAttribute('visibility', 'visible'); }
      const r = box.getBoundingClientRect();
      const px = ev ? ev.clientX : r.left + (geom.x(p.t) / W) * r.width;
      tip.show([
        { key: 'key-down', value: fmtSpeed(p.down), label: 'Download' },
        { key: 'key-up', value: fmtSpeed(p.up), label: 'Upload' },
      ], fmtClock(p.t), px, ev ? ev.clientY : r.top + 24);
    }
    function hide() {
      hoverIdx = null;
      tip.hide();
      box.querySelector('line.cross')?.setAttribute('visibility', 'hidden');
    }
    function nearest(ev) {
      if (!geom || !geom.pts.length) return -1;
      const r = box.querySelector('svg').getBoundingClientRect();
      const vx = ((ev.clientX - r.left) / r.width) * W;
      let best = 0; let bd = Infinity;
      geom.pts.forEach((p, i) => { const d = Math.abs(geom.x(p.t) - vx); if (d < bd) { bd = d; best = i; } });
      return best;
    }
    box.addEventListener('pointermove', (ev) => { const i = nearest(ev); if (i >= 0) show(i, ev); });
    box.addEventListener('pointerleave', hide);
    box.addEventListener('focus', () => { if (geom?.pts.length) show(geom.pts.length - 1); });
    box.addEventListener('blur', hide);
    box.addEventListener('keydown', (ev) => {
      const n = geom?.pts.length ?? 0;
      if (!n) return;
      const cur = hoverIdx ?? n - 1;
      if (ev.key === 'ArrowLeft') { show(Math.max(0, cur - 1)); ev.preventDefault(); }
      else if (ev.key === 'ArrowRight') { show(Math.min(n - 1, cur + 1)); ev.preventDefault(); }
      else if (ev.key === 'Escape') hide();
    });
    if (window.ResizeObserver) {
      let lastW = 0;
      new ResizeObserver(() => { const w = Math.round(box.clientWidth); if (data && w && w !== lastW) { lastW = w; draw(); } }).observe(box);
    }

    return {
      root,
      update(d) { data = d; draw(); },
      asTable(on) { tableWrap.hidden = !on; box.hidden = on; hide(); },
      destroy() { hide(); },
    };
  }

  // ------------------------------------------- composição do espaço em disco
  // Barra empilhada (parte do todo), 2px de respiro entre os segmentos,
  // legenda sempre presente com os valores, tooltip por segmento.
  function diskBar() {
    const root = el('div', 'stack');
    const bar = el('div', 'stackbar');
    const keys = el('ul', 'keys');
    root.append(bar, keys);
    return {
      root,
      update(summary, titles) {
        const sum = (f) => titles.filter(f).reduce((a, t) => a + (t.diskBytes || 0), 0);
        const parts = [
          { id: 'seed', tone: 'seed', label: 'Em seed ou cumpridos', bytes: sum((t) => ['seeding', 'paused', 'awaiting', 'hnr', 'missing', 'done'].includes(t.state)) },
          { id: 'down', tone: 'primary', label: 'Baixando', bytes: sum((t) => t.state === 'completing') },
          { id: 'part', tone: 'complete', label: 'Só streaming', bytes: sum((t) => t.state === 'partial' || t.state === 'unstarted') },
          { id: 'orph', tone: 'neutral', label: 'Fora da biblioteca', bytes: summary.diskOrphan || 0, stripe: true },
        ];
        const total = parts.reduce((a, p) => a + p.bytes, 0);
        clear(bar); clear(keys);
        bar.classList.toggle('stackbar-off', total === 0);
        for (const p of parts) {
          if (p.bytes > 0) {
            const seg = document.createElement('i');
            seg.className = `t-${p.tone}`;
            seg.style.setProperty('flex-grow', String(p.bytes));
            seg.style.setProperty('flex-basis', '0');
            seg.tabIndex = 0;
            const on = (e) => tip.show([{ value: fmtBytes(p.bytes), label: `${Math.round((p.bytes / total) * 100)}%` }], p.label, e.clientX ?? seg.getBoundingClientRect().left, e.clientY ?? seg.getBoundingClientRect().top);
            seg.addEventListener('pointermove', on);
            seg.addEventListener('focus', on);
            seg.addEventListener('pointerleave', tip.hide);
            seg.addEventListener('blur', tip.hide);
            bar.append(seg);
          }
          const li = el('li', `t-${p.tone}`);
          const sw = el('span', `sw${p.stripe ? ' sw-stripe' : ''}`);
          li.append(sw, document.createTextNode(`${p.label} `), el('b', '', fmtBytes(p.bytes)));
          keys.append(li);
        }
        return total;
      },
    };
  }

  window.UI.tip = tip;
  window.UI.trafficChart = trafficChart;
  window.UI.diskBar = diskBar;
})();
