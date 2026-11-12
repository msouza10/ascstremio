// Páginas do painel. Cada view expõe { root, update(data), params?(q), destroy? }:
// monta o DOM uma vez e só atualiza textos a cada leitura (a cada 5 s), para não
// perder foco, tooltip, aba aberta nem texto digitado.
(() => {
  const U = window.UI;
  const { el, icon, setText, clear, badge, stateBadge, pill, meter, card, secTitle, cardHead, link, kpi, alertBox,
    fmtBytes, fmtSpeed, fmtHours, fmtDays, fmtDate, fmtRatio, ago, pct, toneOf, iconOf, STATE, EXPLAIN, FILTERS, sortTitles } = U;
  const app = () => window.App;

  // ----------------------------------------------------------- linha de filme
  function metricBox(label, narrow) {
    const root = el('div', `metric${narrow ? ' metric-narrow' : ''}`);
    const lbl = el('span', 'lbl', label);
    const top = el('div', 'metric-top');
    const a = el('span'); const b = el('span');
    top.append(a, b);
    const m = narrow ? null : meter();
    root.append(lbl, top);
    if (m) root.append(m.root);
    return { root, lbl, a, b, m };
  }

  function movieRow() {
    const root = el('a', 'item');
    root.dataset.link = '';
    const ic = el('div', 'item-ic');
    const icSlot = el('span');
    ic.append(icSlot);
    const main = el('div', 'item-main');
    const title = el('div', 'item-title');
    const badges = el('div', 'item-badges');
    main.append(title, badges);
    const metrics = el('div', 'item-metrics');
    const seed = metricBox('Seed (13.1)');
    const due = metricBox('Prazo (13.3)');
    const net = metricBox('Agora', true);
    metrics.append(seed.root, due.root, net.root);
    const go = icon('chevron-right', 'ic-go');
    root.append(ic, main, metrics, go);
    let lastIcon = '';

    return {
      root,
      update(t) {
        root.href = `/filmes/${t.infoHash}`;
        const tone = toneOf(t);
        root.className = `item t-${tone}`;
        setText(title, t.name);
        const ico = iconOf(t);
        if (ico !== lastIcon) { clear(ic); ic.append(icon(ico, 'ic-20')); lastIcon = ico; }

        clear(badges);
        badges.append(stateBadge(t));
        if (t.freeleech === true) badges.append(badge('Free', 'seed', { upper: true }));
        if (t.size !== null && t.size !== undefined) badges.append(badge(fmtBytes(t.size), 'primary'));
        if (t.diskBytes > 0) badges.append(badge(`${fmtBytes(t.diskBytes)} em disco`, null, { line: true }));
        if (t.ascId) badges.append(badge(`#${t.ascId}`, null, { line: true }));
        if (t.released) badges.append(badge(t.released === 'delete' ? 'arquivos removidos' : 'seed encerrado', null, { line: true }));

        // seed / download
        const ob = ['seeding', 'paused', 'missing', 'awaiting', 'hnr', 'done'].includes(t.state);
        const fillTone = t.risk === 'crit' ? 'leech' : t.risk === 'warn' ? 'complete' : (t.state === 'completing' ? 'primary' : 'seed');
        if (ob) {
          setText(seed.lbl, 'Seed (13.1)');
          setText(seed.a, t.state === 'done' ? 'Cumprido' : fmtHours(t.seededHours));
          setText(seed.b, t.state === 'done' ? '' : `de ${fmtHours(t.requiredHours)}`);
          seed.m.set(t.state === 'done' ? 1 : t.seededHours / t.requiredHours, fillTone);
        } else if (t.state === 'completing') {
          setText(seed.lbl, 'Download');
          setText(seed.a, `${U.num0.format(t.progress * 100)}%`);
          setText(seed.b, '');
          seed.m.set(t.progress, 'primary');
        } else if (t.state === 'partial') {
          setText(seed.lbl, 'Download');
          setText(seed.a, `${U.num0.format(t.progress * 100)}%`);
          setText(seed.b, 'parcial');
          seed.m.set(t.progress, 'complete');
        } else {
          setText(seed.lbl, 'Seed (13.1)'); setText(seed.a, '—'); setText(seed.b, '');
          seed.m.set(0, null, true);
        }

        // prazo: quanto dos 12 dias ainda resta
        const hasDue = t.daysLeft !== null && t.daysLeft !== undefined && !['done', 'unstarted'].includes(t.state);
        setText(due.a, hasDue ? fmtDays(t.daysLeft) : '—');
        setText(due.b, '');
        due.m.set(hasDue ? t.daysLeft / 12 : 0, t.risk === 'crit' ? 'leech' : t.risk === 'warn' ? 'complete' : 'primary', !hasDue);

        // rede
        if (t.active) { setText(net.a, `↓ ${fmtSpeed(t.downSpeed)}`); setText(net.b, `↑ ${fmtSpeed(t.upSpeed)}`); }
        else { setText(net.a, '—'); setText(net.b, 'fora do motor'); }
      },
    };
  }

  // ------------------------------------------------------- concluir download
  // Fluxo com confirmação dentro da página (sem confirm()).
  function completeFlow() {
    const root = el('div', 'stack');
    let confirming = false; let result = ''; let busy = false; let current = null;
    function render() {
      clear(root);
      const t = current;
      if (!t) return;
      const can = t.state === 'partial' || t.state === 'unstarted';
      if (can && !confirming) {
        const b = el('button', 'btn btn-outline');
        b.type = 'button';
        b.append(icon('download'), document.createTextNode('Concluir download em segundo plano'));
        b.addEventListener('click', () => { confirming = true; result = ''; render(); });
        root.append(b, el('p', 'foot', 'Baixa o restante com prioridade baixa e abre a obrigação de 72 h de seed.'));
      } else if (can && confirming) {
        const free = t.freeleech === true;
        root.append(alertBox(free ? 'complete' : 'leech', free ? 'Abre 72 h de seed' : 'Não é freeleech',
          free ? 'Só faça se for manter a ponte ligada: o seed é cobrado pelo tracker.'
            : 'O download inteiro conta no seu ratio, e concluir também abre 72 h de seed.'));
        const row = el('div', 'item-badges');
        const ok = el('button', 'btn btn-primary', 'Confirmar e concluir');
        ok.type = 'button'; ok.disabled = busy;
        const cancel = el('button', 'btn btn-ghost', 'Cancelar');
        cancel.type = 'button';
        cancel.addEventListener('click', () => { confirming = false; render(); });
        ok.addEventListener('click', async () => {
          busy = true; ok.disabled = true; cancel.disabled = true;
          try {
            const res = await app().call('POST', 'complete', { infoHash: t.infoHash });
            result = res.aviso ? `Iniciado. ${res.aviso}` : 'Iniciado. O restante baixa em segundo plano.';
          } catch (e) { result = e.message || 'Não foi possível iniciar.'; }
          busy = false; confirming = false; render(); app().refresh();
        });
        row.append(ok, cancel);
        root.append(row);
      } else if (!result) {
        root.append(el('p', 'foot', t.state === 'completing'
          ? 'O restante já está sendo baixado. Acompanhe o progresso acima.'
          : 'Este filme não precisa de ação: o download já foi concluído ou não é cobrado.'));
      }
      if (result) root.append(el('p', 'foot', result));
    }
    return { root, set(t) { const was = current?.state; current = t; if (was !== t.state || !root.childElementCount) render(); } };
  }

  function seedFlow() {
    const root = el('div', 'stack');
    let current = null; let action = null; let busy = false; let result = ''; let signature = '';
    const labels = { keep: 'Continuar semeando', stop: 'Parar seed e manter arquivos', delete: 'Excluir arquivos e parar seed' };
    function render() {
      clear(root);
      const t = current;
      if (!t || !/^[0-9a-f]{40}$/.test(t.infoHash)) return;
      root.append(el('p', 'foot', t.tracker?.satisfied
        ? 'Seed obrigatório cumprido e confirmado pelo tracker. Você pode manter ou excluir os arquivos.'
        : 'Parar ou excluir fica disponível depois que o tracker confirmar o seed obrigatório. Para decidir depois, selecione AFTER_SEED=manual nas configurações.'));
      if (t.tracker?.satisfied && !t.tracker.hitAndRun && t.onDisk !== 'none') {
        const row = el('div', 'item-badges');
        for (const key of ['keep', 'stop', 'delete']) {
          if (key !== 'delete' && !t.active) continue;
          const button = el('button', 'btn btn-outline', labels[key]);
          button.type = 'button'; button.disabled = busy;
          button.addEventListener('click', () => { action = key; result = ''; render(); });
          row.append(button);
        }
        root.append(row);
        if (action) {
          root.append(el('p', '', action === 'delete'
            ? 'Os arquivos deste conteúdo serão apagados. Assistir novamente pode baixar tudo e criar uma nova obrigação de seed.'
            : action === 'stop' ? 'O seed será encerrado e os arquivos ficarão no disco para assistir depois.'
              : 'O seed continuará e este conteúdo não será apagado automaticamente.'));
          const ok = el('button', 'btn btn-primary', `Confirmar: ${labels[action].toLowerCase()}`);
          const cancel = el('button', 'btn btn-ghost', 'Cancelar');
          ok.type = cancel.type = 'button'; ok.disabled = cancel.disabled = busy;
          cancel.addEventListener('click', () => { action = null; render(); });
          ok.addEventListener('click', async () => {
            busy = true; render();
            try { result = (await app().call('POST', 'seed', { infoHash: current.infoHash, action })).message; }
            catch (err) { result = err.message || 'Não foi possível concluir a ação.'; }
            busy = false; action = null; render(); app().refresh();
          });
          root.append(ok, cancel);
        }
      }
      if (result) { const message = el('p', 'foot', result); message.setAttribute('role', 'status'); root.append(message); }
    }
    return { root, set(t) {
      current = t;
      const next = JSON.stringify([t.infoHash, t.tracker?.satisfied, t.tracker?.hitAndRun, t.active, t.onDisk, t.seedChoice]);
      if (next !== signature && !busy) { signature = next; action = null; render(); }
    } };
  }

  // ------------------------------------------------------------ visão geral
  function overview() {
    const root = el('div', 'page');
    const head = el('div', 'page-head');
    const hl = el('div');
    hl.append(el('h1', '', 'Visão geral'));
    const updated = el('p', 'page-sub', 'Atualizando…');
    hl.append(updated);
    head.append(hl, refreshButton());
    const alerts = el('div', 'alerts');

    const grid = el('div', 'grid grid-kpi');
    const K = {
      pending: kpi({ icon: 'timer', tone: 'complete', label: 'Seed pendente' }),
      risk: kpi({ icon: 'flag', tone: 'seed', label: 'Em risco' }),
      machine: kpi({ icon: 'clock', tone: 'primary', label: 'Máquina ligada' }),
      down: kpi({ icon: 'arrow-down-to-line', tone: 'primary', label: 'Download agora' }),
      done: kpi({ icon: 'circle-check', tone: 'seed', label: 'Cumpridos' }),
      disk: kpi({ icon: 'hard-drive', tone: 'neutral', label: 'Espaço ocupado' }),
    };
    for (const k of Object.values(K)) grid.append(k.root);

    const two = el('div', 'grid grid-2');
    const left = el('div', 'stack');
    const obl = card('card-flush');
    const oblHead = cardHead('Obrigações e downloads', link('/filmes', 'Ver todos os filmes'));
    const oblList = el('div', 'list');
    const oblEmpty = el('div', 'empty', 'Nenhuma obrigação de seed aberta no momento.');
    obl.append(oblHead, oblList, oblEmpty);
    left.append(obl);

    const right = el('div', 'stack');
    const trafficCard = card();
    const chart = U.trafficChart({ compact: true });
    const lg = el('ul', 'legend');
    for (const [k, t] of [['key-down', 'Download'], ['key-up', 'Upload']]) { const li = el('li'); li.append(el('span', `key ${k}`), document.createTextNode(t)); lg.append(li); }
    trafficCard.append(cardHead('Tráfego · última hora', link('/trafego', 'Detalhes')), lg, chart.root);
    const accCard = card();
    const accRows = el('dl', 'rows');
    accCard.append(cardHead('Conta no ASC', link('/conta', 'Abrir')), accRows);
    right.append(trafficCard, accCard);
    two.append(left, right);
    root.append(head, alerts, grid, two);

    const rows = new Map();
    return {
      root,
      update(d) {
        const s = d.summary;
        setText(updated, `Atualizado às ${U.fmtClock(Date.parse(d.generatedAt))}`);

        // avisos
        clear(alerts);
        const items = [];
        for (const t of d.titles) for (const w of t.warnings) items.push({ tone: t.risk === 'crit' ? 'leech' : 'complete', text: w, hash: t.infoHash });
        // Política de disco (alerta com histerese): novos downloads bloqueados também aparecem aqui.
        if (s.disk?.blocked) items.unshift({ tone: 'complete', text: `Novos downloads bloqueados: ${s.disk.reason}. O seed que já está em disco continua.`, hash: null });
        items.sort((a, b) => (a.tone === 'leech' ? 0 : 1) - (b.tone === 'leech' ? 0 : 1));
        if (!items.length) {
          alerts.append(alertBox('seed', 'Tudo em dia', 'Nenhum risco de hit-and-run agora. A ponte segue semeando o que o tracker cobra.'));
        } else {
          for (const i of items) alerts.append(alertBox(i.tone, i.tone === 'leech' ? 'Aja agora' : 'Atenção', i.text, i.hash ? link(`/filmes/${i.hash}`, 'Abrir') : undefined));
        }

        K.pending.set(U.num.format(s.hoursPending), 'h', s.pending ? `${s.pending} filme(s) com obrigação aberta` : 'Nenhuma obrigação aberta');
        K.risk.setTone(s.critical ? 'leech' : s.atRisk ? 'complete' : 'seed');
        K.risk.set(String(s.atRisk), '', s.critical ? `${s.critical} crítico(s): aja agora` : s.atRisk ? 'Veja os avisos acima' : 'Tudo em dia');
        K.machine.set(s.machineHoursPerDay ? `≥ ${U.num.format(s.machineHoursPerDay)}` : '0', 'h/dia',
          s.machineHoursPerDay > 24 ? 'não fecha antes do prazo atual' : s.machineHoursPerDay ? 'para quitar antes do prazo atual' : 'nenhum prazo correndo');
        K.down.set(fmtSpeed(s.downSpeed), '', `Upload ${fmtSpeed(s.upSpeed)} · ${s.peers} peers`);
        K.done.set(String(s.done), `de ${s.total}`, 'com seed concluído e confirmado');
        K.disk.set(s.diskUsed === undefined ? '—' : fmtBytes(s.diskUsed), '',
          s.diskReclaimable > 0 ? `${fmtBytes(s.diskReclaimable)} sem uso · ${fmtBytes(s.freeBytes)} livres` : `${fmtBytes(s.freeBytes)} livres no disco`);

        // obrigações e downloads
        const relevant = sortTitles(d.titles.filter((t) => ['seeding', 'paused', 'missing', 'awaiting', 'hnr', 'completing'].includes(t.state)));
        const live = new Set();
        for (const t of relevant) {
          live.add(t.infoHash);
          let r = rows.get(t.infoHash);
          if (!r) { r = movieRow(); rows.set(t.infoHash, r); }
          r.update(t);
        }
        for (const [h, r] of rows) if (!live.has(h)) { r.root.remove(); rows.delete(h); }
        relevant.forEach((t) => oblList.append(rows.get(t.infoHash).root));
        oblEmpty.hidden = relevant.length > 0;

        chart.update(d);
        renderAccount(accRows, d);
      },
      destroy() { chart.destroy(); },
    };
  }

  function renderAccount(dl, d) {
    clear(dl);
    const a = d.account; const st = d.stats;
    const row = (k, v, tone) => { const r = el('div', 'row'); const dd = el('dd', tone ? `t-${tone}` : '', v); if (tone) dd.style.setProperty('color', `var(--${tone})`); r.append(el('dt', '', k), dd); dl.append(r); };
    row('Ratio', st ? fmtRatio(st.ratio) : '—', st && st.ratio >= 1 ? 'seed' : st ? 'leech' : null);
    row('Hit-and-runs', a ? String(a.hitAndRuns) : '—', a && a.hitAndRuns ? 'leech' : 'seed');
    row('Prisão de download', a ? (a.prisonUntil ? `até ${fmtDate(a.prisonUntil)}` : 'nenhuma') : '—', a && a.prisonUntil ? 'leech' : null);
    row('Seeds pendentes no site', a ? String(a.pendingSeeds) : '—');
    row('Isento de HnR (VIP)', a ? (a.exempt ? 'sim' : 'não') : '—');
  }

  function refreshButton() {
    const b = el('button', 'btn btn-outline btn-sm');
    b.type = 'button';
    b.append(icon('loader-circle'), document.createTextNode('Atualizar'));
    b.addEventListener('click', () => app().refresh(true));
    return b;
  }

  // ------------------------------------------------------------------ filmes
  function filmes(q0) {
    const root = el('div', 'page');
    const head = el('div', 'page-head');
    const hl = el('div');
    hl.append(el('h1', '', 'Filmes'));
    const sub = el('p', 'page-sub');
    hl.append(sub);
    const sw = el('label', 'search');
    sw.append(el('span', 'sr', 'Buscar filme'), icon('search'));
    const input = el('input', 'input');
    input.type = 'search'; input.placeholder = 'Buscar pelo nome'; input.autocomplete = 'off'; input.maxLength = 80; input.id = 'busca';
    sw.append(input);
    head.append(hl, sw);

    const tabs = el('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    const box = card('card-flush');
    const list = el('div', 'list');
    const empty = el('div', 'empty');
    box.append(list, empty);
    root.append(head, tabs, box);

    let estado = 'todos'; let query = '';
    let data = null;
    const rows = new Map();

    function setParams(q) {
      const p = new URLSearchParams(q || '');
      const e = p.get('estado');
      estado = FILTERS.some((f) => f.key === e) ? e : 'todos';
      query = p.get('q') || '';
      if (input.value !== query) input.value = query;
      if (data) apply();
    }
    function pushUrl() {
      const p = new URLSearchParams();
      if (estado !== 'todos') p.set('estado', estado);
      if (query) p.set('q', query);
      const qs = p.toString();
      history.replaceState(null, '', `/filmes${qs ? `?${qs}` : ''}`);
      app().markNav();
    }
    function renderTabs() {
      clear(tabs);
      for (const f of FILTERS) {
        const n = data ? data.titles.filter(f.test).length : 0;
        const b = el('button', 'tab');
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(estado === f.key));
        b.append(document.createTextNode(f.label), pill(String(n), 'neutral'));
        b.addEventListener('click', () => { estado = f.key; pushUrl(); renderTabs(); apply(); });
        tabs.append(b);
      }
    }
    function apply() {
      const f = FILTERS.find((x) => x.key === estado) ?? FILTERS[0];
      const ql = query.trim().toLowerCase();
      let shown = 0;
      for (const t of data.titles) {
        const r = rows.get(t.infoHash);
        if (!r) continue;
        const vis = f.test(t) && (!ql || t.name.toLowerCase().includes(ql));
        r.root.hidden = !vis;
        if (vis) shown += 1;
      }
      empty.hidden = shown > 0;
      if (!shown) {
        empty.textContent = data.titles.length ? 'Nenhum filme nesta seleção.'
          : 'A biblioteca está vazia. Coloque arquivos .torrent em private/torrents/ ou abra um filme do catálogo ASC no Stremio.';
      }
      setText(sub, `${shown} de ${data.titles.length} filme(s)`);
    }
    input.addEventListener('input', () => { query = input.value; pushUrl(); apply(); });

    setParams(q0);
    return {
      root,
      params: setParams,
      update(d) {
        data = d;
        const live = new Set();
        for (const t of d.titles) {
          live.add(t.infoHash);
          let r = rows.get(t.infoHash);
          if (!r) { r = movieRow(); rows.set(t.infoHash, r); }
          r.update(t);
        }
        for (const [h, r] of rows) if (!live.has(h)) { r.root.remove(); rows.delete(h); }
        sortTitles(d.titles).forEach((t) => list.append(rows.get(t.infoHash).root));
        renderTabs();
        apply();
      },
    };
  }

  // ----------------------------------------------------------------- detalhe
  function filmeDetalhe(hash) {
    const root = el('div', 'page');
    const crumbs = el('nav', 'crumbs');
    crumbs.setAttribute('aria-label', 'Você está em');
    const cm = link('/filmes', 'Filmes', ''); cm.className = '';
    const cname = el('span');
    crumbs.append(cm, icon('chevron-right', 'ic-14'), cname);

    const head = el('div', 'page-head');
    const hl = el('div', 'stack');
    const title = el('h1');
    const badges = el('div', 'item-badges');
    hl.append(title, badges);
    const ext = el('a', 'btn btn-outline btn-sm');
    ext.target = '_blank'; ext.rel = 'noopener noreferrer';
    ext.append(document.createTextNode('Abrir no ASC'), icon('arrow-up-from-line'));
    head.append(hl, ext);

    const alerts = el('div', 'alerts');
    const cols = el('div', 'grid grid-2');
    const main = el('div', 'stack');
    const side = el('div', 'stack');

    // seed
    const cSeed = card();
    const sBig = el('div', 'kpi-value'); const sBigV = el('span'); const sBigU = el('span', 'kpi-unit'); sBig.append(sBigV, sBigU);
    const sMeter = meter({ large: true });
    const sNote = el('p', 'foot');
    cSeed.append(cardHead('Seed · regra 13.1'), sBig, sMeter.root, sNote);
    // prazo
    const cDue = card();
    const dBig = el('div', 'kpi-value'); const dBigV = el('span'); const dBigU = el('span', 'kpi-unit'); dBig.append(dBigV, dBigU);
    const dMeter = meter({ large: true });
    const dNote = el('p', 'foot');
    cDue.append(cardHead('Prazo · regra 13.3'), dBig, dMeter.root, dNote);
    // situação
    const cState = card();
    const stText = el('p');
    cState.append(cardHead('Situação'), stText);
    // tracker
    const cTr = card();
    const trRows = el('dl', 'rows');
    cTr.append(cardHead('Tracker'), trRows);
    main.append(cSeed, cDue, cState, cTr);

    // aside
    const cAct = card();
    const actRows = el('dl', 'rows');
    cAct.append(cardHead('Sua atividade'), actRows);
    const cBtn = card();
    const flow = completeFlow();
    const seed = seedFlow();
    cBtn.append(cardHead('Ações'), flow.root, seed.root);
    const cDet = card();
    const detRows = el('dl', 'rows');
    cDet.append(cardHead('Detalhes'), detRows);
    side.append(cAct, cBtn, cDet);

    cols.append(main, side);
    root.append(crumbs, head, alerts, cols);

    const kv = (dl, pairs) => {
      clear(dl);
      for (const [k, v, mono] of pairs) { const r = el('div', mono ? 'row stackrow' : 'row'); const dd = el('dd', mono ? 'mono' : '', v); r.append(el('dt', '', k), dd); dl.append(r); }
    };

    return {
      root,
      update(d) {
        const t = d.titles.find((x) => x.infoHash === hash);
        if (!t) {
          clear(root);
          const c = card('empty');
          c.append(el('p', '', 'Este filme não está mais na biblioteca.'), link('/filmes', 'Voltar para a lista'));
          root.append(c);
          return;
        }
        document.title = `${t.name} · Monitor ASC`;
        setText(cname, t.name);
        setText(title, t.name);
        title.className = 'page-title';
        clear(badges);
        badges.append(stateBadge(t));
        if (t.freeleech === true) badges.append(badge('Free', 'seed', { upper: true }));
        else if (t.freeleech === false) badges.append(badge('Sem freeleech', null, { line: true }));
        if (t.size !== null && t.size !== undefined) badges.append(badge(fmtBytes(t.size), 'primary'));
        ext.hidden = !t.ascId;
        if (t.ascId) ext.href = `https://amigos-share.club/torrents/${t.ascId}`;

        clear(alerts);
        for (const w of t.warnings) alerts.append(alertBox(t.risk === 'crit' ? 'leech' : 'complete', t.risk === 'crit' ? 'Aja agora' : 'Atenção', w));

        const ob = ['seeding', 'paused', 'missing', 'awaiting', 'hnr', 'done'].includes(t.state);
        const tone = t.risk === 'crit' ? 'leech' : t.risk === 'warn' ? 'complete' : 'seed';
        if (ob) {
          setText(sBigV, t.state === 'done' ? fmtHours(t.requiredHours) : fmtHours(t.seededHours));
          setText(sBigU, t.state === 'done' ? 'cumpridas' : `de ${fmtHours(t.requiredHours)}`);
          sMeter.set(t.state === 'done' ? 1 : t.seededHours / t.requiredHours, tone);
          setText(sNote, t.state === 'done' ? 'Confirmado pelo tracker.' : `Faltam ${fmtHours(Math.max(0, t.requiredHours - t.seededHours))} para cumprir (ou ratio 1.0 neste torrent).`);
        } else if (t.state === 'completing') {
          setText(sBigV, `${U.num0.format(t.progress * 100)}%`); setText(sBigU, 'baixado');
          sMeter.set(t.progress, 'primary');
          setText(sNote, 'O seed de 72 h só começa quando o download concluir (regra 13.1).');
        } else {
          setText(sBigV, `${U.num0.format(t.progress * 100)}%`); setText(sBigU, 'baixado');
          sMeter.set(t.progress, 'complete', t.progress === 0);
          setText(sNote, 'Sem download concluído não há obrigação de seed.');
        }

        const hasDue = t.daysLeft !== null && t.daysLeft !== undefined && !['done', 'unstarted'].includes(t.state);
        cDue.hidden = !hasDue;
        if (hasDue) {
          setText(dBigV, fmtDays(t.daysLeft)); setText(dBigU, `até ${fmtDate(t.deadline)}`);
          dMeter.set(t.daysLeft / 12, t.risk === 'crit' ? 'leech' : t.risk === 'warn' ? 'complete' : 'primary');
          setText(dNote, t.hoursPerDayNeeded ? `São ${U.num.format(t.hoursPerDayNeeded)} h/dia de máquina ligada para quitar antes do prazo atual. Cada announce renova o prazo (último announce + 12 dias).` : 'Cada announce renova o prazo (último announce + 12 dias).');
        }
        setText(stText, EXPLAIN[t.state] ?? '');

        kv(trRows, [
          ['Situação no site', t.tracker ? (t.tracker.satisfied ? 'cumprido' : t.tracker.remainingHours === null ? 'sem dado de seed' : `faltam ${fmtHours(t.tracker.remainingHours)}`) : 'ainda não conferido'],
          ['Última conferência', t.tracker ? ago(t.tracker.checkedAt) : '—'],
          ['Hit-and-run', t.tracker ? (t.tracker.hitAndRun ? 'registrado' : 'nenhum') : '—'],
          ['Concluído em', t.completedAt ? fmtDate(t.completedAt) : 'não concluído'],
        ]);
        kv(actRows, [
          ['Download agora', t.active ? fmtSpeed(t.downSpeed) : '—'],
          ['Upload agora', t.active ? fmtSpeed(t.upSpeed) : '—'],
          ['Baixado (sessão)', fmtBytes(t.downloaded)],
          ['Enviado (sessão)', fmtBytes(t.uploaded)],
          ['Ratio (sessão)', fmtRatio(t.ratio)],
          ['Peers', String(t.peers)],
        ]);
        kv(detRows, [
          ['Tamanho', t.size === null || t.size === undefined ? '—' : fmtBytes(t.size)],
          ['Ocupa em disco', t.diskBytes > 0 ? `${fmtBytes(t.diskBytes)}${t.size ? ` (${U.num0.format((t.diskBytes / t.size) * 100)}%)` : ''}` : 'nada'],
          ['ID no ASC', t.ascId ?? '—'],
          ['Info hash', t.infoHash, true],
        ]);
        flow.set(t);
        seed.set(t);
      },
    };
  }

  // ---------------------------------------------------------- tráfego e disco
  function trafego() {
    const root = el('div', 'page');
    const head = el('div', 'page-head');
    const hl = el('div');
    hl.append(el('h1', '', 'Tráfego e disco'));
    const updated = el('p', 'page-sub');
    hl.append(updated);
    head.append(hl, refreshButton());

    const grid = el('div', 'grid grid-kpi k4');
    const K = {
      down: kpi({ icon: 'arrow-down-to-line', tone: 'primary', label: 'Download agora' }),
      up: kpi({ icon: 'arrow-up-from-line', tone: 'seed', label: 'Upload agora' }),
      peers: kpi({ icon: 'users', tone: 'neutral', label: 'Peers conectados' }),
      disk: kpi({ icon: 'hard-drive', tone: 'neutral', label: 'Espaço ocupado' }),
    };
    for (const k of Object.values(K)) grid.append(k.root);

    const cChart = card();
    const toggle = el('button', 'btn btn-ghost', 'Ver como tabela');
    toggle.type = 'button'; toggle.setAttribute('aria-pressed', 'false');
    const lg = el('ul', 'legend');
    for (const [k, t] of [['key-down', 'Download'], ['key-up', 'Upload']]) { const li = el('li'); li.append(el('span', `key ${k}`), document.createTextNode(t)); lg.append(li); }
    const tools = el('div', 'item-badges'); tools.append(lg, toggle);
    const chartHead = el('div', 'card-head');
    const ct = el('div'); ct.append(secTitle('Tráfego da ponte'), el('p', 'page-sub', 'Última hora, uma amostra a cada 15 s'));
    chartHead.append(ct, tools);
    const chart = U.trafficChart();
    toggle.addEventListener('click', () => {
      const on = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', String(on));
      setText(toggle, on ? 'Ver como gráfico' : 'Ver como tabela');
      chart.asTable(on);
    });
    cChart.append(chartHead, chart.root);

    const cDisk = card('card-flush');
    const diskBody = el('div', 'stack'); diskBody.style.setProperty('padding', '0 16px 16px');
    const bar = U.diskBar();
    const diskRows = el('dl', 'rows');
    diskBody.append(bar.root, diskRows);
    const tw = el('div', 'table-wrap');
    const table = document.createElement('table');
    const th = document.createElement('thead'); const thr = document.createElement('tr');
    for (const [h, r] of [['Filme', false], ['Situação', false], ['Em disco', true], ['% do arquivo', true]]) { const c = el('th', r ? 'r' : '', h); c.scope = 'col'; thr.append(c); }
    th.append(thr);
    const tb = document.createElement('tbody');
    table.append(th, tb); tw.append(table);
    cDisk.append(cardHead('Espaço em disco'), diskBody, tw);

    root.append(head, grid, cChart, cDisk);
    return {
      root,
      update(d) {
        const s = d.summary;
        setText(updated, `Atualizado às ${U.fmtClock(Date.parse(d.generatedAt))}`);
        K.down.set(fmtSpeed(s.downSpeed), '', 'soma de todos os torrents');
        K.up.set(fmtSpeed(s.upSpeed), '', `${fmtBytes(s.uploaded)} enviados nesta sessão`);
        K.peers.set(String(s.peers), '', `${s.active} torrent(s) no motor`);
        K.disk.set(fmtBytes(s.diskUsed), '', `${fmtBytes(s.freeBytes)} livres no disco`);
        chart.update(d);

        bar.update(s, d.titles);
        clear(diskRows);
        for (const [k, v] of [['Ocupado pelo addon', fmtBytes(s.diskUsed)], ['Sem uso (só streaming e fora da biblioteca)', fmtBytes(s.diskReclaimable)], ['Livre no disco', fmtBytes(s.freeBytes)],
          ...(s.disk ? [['Reserva efetiva', s.disk.reserve === null ? 'indisponível' : fmtBytes(s.disk.reserve)], ['Comprometido com downloads', fmtBytes(s.disk.committed)],
            ['Disponível para novos downloads', s.disk.available === null ? 'desconhecido' : fmtBytes(Math.max(0, s.disk.available))]] : [])]) {
          const r = el('div', 'row'); r.append(el('dt', '', k), el('dd', '', v)); diskRows.append(r);
        }
        clear(tb);
        const withDisk = d.titles.filter((t) => t.diskBytes > 0).sort((a, b) => b.diskBytes - a.diskBytes);
        for (const t of withDisk) {
          const tr = document.createElement('tr');
          const c1 = document.createElement('td'); c1.append(link(`/filmes/${t.infoHash}`, t.name, ''));
          const c2 = document.createElement('td'); c2.append(stateBadge(t));
          tr.append(c1, c2, el('td', 'r', fmtBytes(t.diskBytes)), el('td', 'r', t.size ? `${U.num0.format((t.diskBytes / t.size) * 100)}%` : '—'));
          tb.append(tr);
        }
        if (!withDisk.length) { const tr = document.createElement('tr'); const c = el('td', 'muted', 'Nenhum filme com dados em disco.'); c.colSpan = 4; tr.append(c); tb.append(tr); }
      },
      destroy() { chart.destroy(); },
    };
  }

  // ------------------------------------------------------------------- conta
  function conta(q0) {
    const root = el('div', 'page');
    const head = el('div', 'page-head');
    const hl = el('div');
    hl.append(el('h1', '', 'Conta e serviço'), el('p', 'page-sub', 'Sessão no ASC, situação da conta e configuração do serviço'));
    head.append(hl);
    const tabs = el('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    const panels = { sessao: el('div', 'stack'), conta: el('div', 'stack'), servico: el('div', 'stack'), regras: el('div', 'stack') };
    const LABELS = [['sessao', 'Sessão'], ['conta', 'Conta no ASC'], ['servico', 'Serviço'], ['regras', 'Regras']];
    let aba = 'sessao';

    // sessão
    const cSess = card();
    const sessRows = el('dl', 'rows');
    const sessNotice = el('div');
    const acts = el('div', 'item-badges');
    const bVerify = el('button', 'btn btn-outline', 'Verificar sessão'); bVerify.type = 'button';
    const bRelogin = el('button', 'btn btn-outline', 'Entrar de novo'); bRelogin.type = 'button';
    const bLogout = el('button', 'btn btn-danger'); bLogout.type = 'button';
    bLogout.append(icon('log-out'), document.createTextNode('Remover sessão local'));
    acts.append(bVerify, bRelogin, bLogout);
    const filterNote = el('p', 'foot');
    filterNote.append(document.createTextNode('O filtro de releases (somente freeleech, regra 2.7) é uma preferência: altere em '));
    const filterLink = el('a', '', 'Configurações'); filterLink.href = '/configuracoes'; filterLink.setAttribute('data-link', '');
    filterNote.append(filterLink, document.createTextNode('.'));
    cSess.append(cardHead('Sessão'), sessRows, filterNote, sessNotice, acts, el('p', 'foot', 'Remover a sessão local apaga os cookies salvos neste computador. Não encerra outras sessões no ASC nem torrents ativos.'));
    bVerify.addEventListener('click', () => app().session('verify'));
    bRelogin.addEventListener('click', () => app().nav('/entrar?de-novo=1'));
    bLogout.addEventListener('click', () => app().session('logout'));
    panels.sessao.append(cSess);

    // conta
    const cAcc = card(); const accRows = el('dl', 'rows');
    cAcc.append(cardHead('Situação da conta'), accRows);
    panels.conta.append(cAcc);

    // serviço
    const cSvc = card(); const svcRows = el('dl', 'rows');
    cSvc.append(cardHead('Configuração em uso'), svcRows);
    const cCmd = card();
    const pre = el('pre', 'code', 'systemctl --user status ascstremio\njournalctl --user -u ascstremio -f\nsystemctl --user restart ascstremio');
    cCmd.append(cardHead('Comandos do serviço'), pre, el('p', 'foot', 'As variáveis ficam em private/service.env (modelo comentado). Depois de editar, reinicie o serviço.'));
    panels.servico.append(cSvc, cCmd);

    // regras
    const cRules = card();
    const rl = el('dl', 'rows');
    const RULES = [
      ['13.1', 'Depois de concluir, semear 72 h ou até ratio 1.0 no torrent.', 'A ponte semeia o que o tracker cobra e só considera cumprido quando o site confirma.'],
      ['13.3', 'Só é hit-and-run quem passa 12 dias sem semear antes de cumprir.', 'Avisos de prazo curto, torrent inativo e arquivo ausente; cada announce renova o prazo.'],
      ['13.5', 'Parar de semear depois de um hit-and-run é reincidência (advertência de 30 dias).', 'Se o tracker registrar HnR, o painel pede para continuar semeando.'],
      ['2.6', 'Conta sem acesso por 90 dias é banida.', 'O addon guarda o último login e avisa a partir de 60 dias. Semear não conta como acesso ao site.'],
      ['2.7', 'Manter o ratio em 1.0 ou mais.', 'Filtro freeleech ligado por padrão e aviso quando o release não é freeleech.'],
      ['2.2', 'A conta é pessoal e intransferível.', 'Ponte e painel só em 127.0.0.1; não hospede o addon para outras pessoas.'],
    ];
    for (const [n, rule, how] of RULES) {
      const r = el('div', 'row');
      const dt = el('dt'); dt.append(badge(n, 'primary'));
      const dd = el('dd'); dd.append(el('div', '', rule), el('div', 'muted', how));
      dd.style.setProperty('text-align', 'left');
      r.append(dt, dd); rl.append(r);
    }
    cRules.append(cardHead('Regras do ASC e como o addon as segue'), rl);
    panels.regras.append(cRules);

    function renderTabs() {
      clear(tabs);
      for (const [k, label] of LABELS) {
        const b = el('button', 'tab', label);
        b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(aba === k));
        b.addEventListener('click', () => { aba = k; history.replaceState(null, '', `/conta${k === 'sessao' ? '' : `?aba=${k}`}`); app().markNav(); renderTabs(); showPanel(); });
        tabs.append(b);
      }
    }
    function showPanel() { for (const [k, p] of Object.entries(panels)) p.hidden = k !== aba; }
    function setParams(q) { const a = new URLSearchParams(q || '').get('aba'); aba = LABELS.some(([k]) => k === a) ? a : 'sessao'; renderTabs(); showPanel(); }
    root.append(head, tabs, ...Object.values(panels));
    setParams(q0);

    const kvr = (dl, pairs) => { clear(dl); for (const [k, v, tone] of pairs) { const r = el('div', 'row'); const dd = el('dd', '', v); if (tone) dd.style.setProperty('color', `var(--${tone})`); r.append(el('dt', '', k), dd); dl.append(r); } };
    return {
      root,
      params: setParams,
      update(d) {
        const s = app().store.status || {};
        kvr(sessRows, [
          ['Estado', s.connected ? 'conectada ao ASC' : 'não confirmada', s.connected ? 'seed' : 'complete'],
          ['Último login', s.lastLoginAt ? `${fmtDate(s.lastLoginAt)} (${ago(s.lastLoginAt)})` : 'desconhecido'],
          ['Filtro de releases', s.onlyFreeleech === false ? 'todos os releases' : 'somente freeleech'],
        ]);
        clear(sessNotice);
        if (s.notice) sessNotice.append(alertBox('complete', 'Inatividade (regra 2.6)', s.notice));

        const a = d.account; const st = d.stats;
        kvr(accRows, [
          ['Ratio', st ? fmtRatio(st.ratio) : '—', st && st.ratio >= 1 ? 'seed' : st ? 'leech' : null],
          ['Enviado', st ? fmtBytes(st.uploaded) : '—'],
          ['Baixado', st ? fmtBytes(st.downloaded) : '—'],
          ['Hit-and-runs', a ? String(a.hitAndRuns) : '—', a && a.hitAndRuns ? 'leech' : 'seed'],
          ['Prisão de download', a ? (a.prisonUntil ? `até ${fmtDate(a.prisonUntil)}` : 'nenhuma') : '—', a && a.prisonUntil ? 'leech' : null],
          ['Seeds pendentes no site', a ? String(a.pendingSeeds) : '—'],
          ['Hit-and-runs resolvidos', a ? String(a.cleared) : '—'],
          ['Isento de HnR (VIP)', a ? (a.exempt ? 'sim' : 'não') : '—'],
        ]);

        const c = d.settings;
        kvr(svcRows, [
          ['Seed exigido', `${c.requiredHours} h por torrent`],
          ['Concluir download em segundo plano', c.backgroundMode === 'auto' ? `automático (parado há ${c.idleMinutes} min)` : 'só quando você pede'],
          ['Ao cumprir o limite', { delete: 'encerra e apaga os arquivos', stop: 'encerra e mantém os arquivos', keep: 'continua semeando', manual: 'você decide no painel; mantém semeando até lá' }[c.afterSeed] ?? c.afterSeed],
          ['Suspensão do PC', c.keepAwake ? 'bloqueada agora (há seed pendente)' : 'livre (nada pendente)'],
          ['Ponte escuta em', c.host],
          ['Limite de upload', c.uploadLimit > 0 ? fmtSpeed(c.uploadLimit) : 'sem limite'],
        ]);
      },
    };
  }

  // ------------------------------------------------------------------ entrar
  function entrar(q0) {
    const root = el('div', 'page');
    const wrap = el('div', 'hero');
    wrap.append(badge('Painel do addon', 'primary', { upper: true }));
    const h1 = el('h1'); h1.append(document.createTextNode('Conectar ao '), el('span', '', 'Amigos Share'));
    wrap.append(h1, el('p', 'muted', 'A senha é usada só para entrar. Fica salva apenas a sessão, neste computador, com permissão restrita. O painel abre quando a sessão for confirmada.'));
    const c = card();
    const form = el('form', 'form');
    form.method = 'post'; form.action = '/api/login';
    const mk = (label, id, type, extra = {}) => {
      const f = el('label', 'field'); f.htmlFor = id;
      const i = el('input', 'input'); i.id = id; i.name = id; i.type = type; i.required = true;
      Object.assign(i, extra);
      f.append(el('span', '', label), i);
      return { f, i };
    };
    const u = mk('Usuário', 'username', 'text', { maxLength: 100, autocomplete: 'username' });
    const p = mk('Senha', 'password', 'password', { maxLength: 512, autocomplete: 'current-password' });
    const row = el('div', 'item-badges');
    const submit = el('button', 'btn btn-primary', 'Conectar');
    const cancel = el('button', 'btn btn-ghost', 'Cancelar'); cancel.type = 'button';
    row.append(submit, cancel);
    const status = el('p', 'status'); status.setAttribute('role', 'status');
    form.append(u.f, p.f, row);
    form.append(el('p', 'foot', 'As preferências, inclusive o filtro "somente freeleech" (regra 2.7), ficam em Configurações, no menu, depois de entrar.'));
    c.append(form, status);
    wrap.append(c);
    root.append(wrap);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true; setText(status, 'Entrando…'); status.classList.remove('error');
      try {
        await app().session('login', { username: u.i.value, password: p.i.value });
      } catch (err) { setText(status, err.message); status.classList.add('error'); }
      p.i.value = ''; submit.disabled = false;
    });
    cancel.addEventListener('click', () => app().nav('/conta'));
    const redo = () => new URLSearchParams(location.search).has('de-novo');
    return {
      root,
      update() {
        cancel.hidden = !(app().store.status?.connected && redo());
        const m = app().store.status?.message;
        if (!status.classList.contains('error') && !submit.disabled && m) setText(status, m);
      },
    };
  }

  window.Views = { overview, filmes, filmeDetalhe, trafego, conta, entrar, movieRow };
})();
