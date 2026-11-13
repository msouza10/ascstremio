// Página /logs: leitura ao vivo, filtros, download e controle do nível de gravação.
// Texto de log entra sempre por textContent/createTextNode (mensagens podem trazer
// nomes de arquivo e erros de terceiros); o destaque da busca monta <mark> por DOM.
(() => {
  const U = window.UI;
  const { el, icon, setText, clear, card, secTitle, cardHead, badge, fmtBytes, fmtDate } = U;
  const app = () => window.App;

  const LEVELS = [
    { key: 'error', label: 'Erro', tone: 'leech' },
    { key: 'warn', label: 'Aviso', tone: 'complete' },
    { key: 'info', label: 'Info', tone: 'primary' },
    { key: 'debug', label: 'Debug', tone: 'neutral' },
  ];
  const RANGES = [
    ['5m', '5 minutos', 5 * 60_000], ['15m', '15 minutos', 15 * 60_000], ['1h', '1 hora', 3_600_000],
    ['6h', '6 horas', 6 * 3_600_000], ['24h', '24 horas', 24 * 3_600_000], ['tudo', 'Tudo', 0],
  ];
  const DEFAULT_LEVELS = ['error', 'warn', 'info'];
  const MAX_DOM = 2000;
  const POLL_MS = 2000;
  const p2 = (n) => String(n).padStart(2, '0');
  const clock = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`; };

  function logsView(q0) {
    const root = el('div', 'page');

    // ------------------------------------------------------------ cabeçalho
    const head = el('div', 'page-head');
    const hl = el('div');
    hl.append(el('h1', '', 'Logs'));
    const sub = el('p', 'page-sub', 'Carregando…');
    hl.append(sub);
    const dl = el('div', 'item-badges');
    const aTxt = el('a', 'btn btn-outline btn-sm'); aTxt.append(icon('download'), document.createTextNode('Baixar .txt'));
    const aNd = el('a', 'btn btn-outline btn-sm'); aNd.append(icon('download'), document.createTextNode('Baixar .ndjson'));
    aTxt.setAttribute('download', ''); aNd.setAttribute('download', '');
    dl.append(aTxt, aNd);
    head.append(hl, dl);

    // -------------------------------------------------------------- filtros
    const bar = card('stack');
    const levelRow = el('div', 'logchips');
    levelRow.setAttribute('role', 'group'); levelRow.setAttribute('aria-label', 'Níveis');
    const chipRefs = {};
    for (const l of LEVELS) {
      const b = el('button', `logchip t-${l.tone}`); b.type = 'button';
      const dot = el('span', 'dot'); const lab = el('span', '', l.label); const n = el('span', 'n', '0');
      b.append(dot, lab, n);
      b.addEventListener('click', () => { toggleLevel(l.key); });
      levelRow.append(b);
      chipRefs[l.key] = { b, n };
    }
    const row2 = el('div', 'logfilters');
    const sw = el('label', 'search'); sw.append(el('span', 'sr', 'Buscar nos logs'), icon('search'));
    const input = el('input', 'input'); input.type = 'search'; input.id = 'logbusca'; input.placeholder = 'Buscar na mensagem e nos dados'; input.autocomplete = 'off'; input.maxLength = 100;
    sw.append(input);
    const fonteSel = el('select', 'input'); fonteSel.id = 'logfonte'; fonteSel.setAttribute('aria-label', 'Fonte');
    const janelaSel = el('select', 'input'); janelaSel.id = 'logjanela'; janelaSel.setAttribute('aria-label', 'Janela de tempo');
    for (const [k, label] of RANGES) { const o = el('option', '', label); o.value = k; janelaSel.append(o); }
    row2.append(sw, fonteSel, janelaSel);
    const row3 = el('div', 'item-badges');
    const bLive = el('button', 'btn btn-outline btn-sm'); bLive.type = 'button'; bLive.setAttribute('aria-pressed', 'true');
    const bEnd = el('button', 'btn btn-ghost btn-icon'); bEnd.type = 'button';
    bEnd.append(icon('arrow-down-to-line'), document.createTextNode('Ir para o fim'));
    const bCopy = el('button', 'btn btn-ghost btn-icon'); bCopy.type = 'button'; bCopy.append(icon('copy'), document.createTextNode('Copiar visíveis'));
    const bClear = el('button', 'btn btn-ghost btn-icon'); bClear.type = 'button';
    bClear.append(icon('x'), document.createTextNode('Limpar tela'));
    const hint = el('span', 'page-sub');
    row3.append(bLive, bEnd, bCopy, bClear, hint);
    bar.append(levelRow, row2, row3);

    // --------------------------------------------------------------- visor
    const view = card('card-flush');
    const vhead = el('div', 'logvhead');
    const count = el('span', 'page-sub');
    const bMore = el('button', 'btn btn-ghost', 'Carregar anteriores'); bMore.type = 'button'; bMore.hidden = true;
    vhead.append(count, bMore);
    const box = el('div', 'logbox'); box.tabIndex = 0; box.setAttribute('role', 'log'); box.setAttribute('aria-label', 'Linhas de log'); box.setAttribute('aria-live', 'off');
    const empty = el('div', 'empty', 'Nenhuma linha com esses filtros.');
    view.append(vhead, box, empty);

    // ------------------------------------------------------ arquivos / nível
    const cFiles = card('card-flush');
    const fBody = el('div', 'table-wrap');
    const fTable = document.createElement('table');
    const fh = document.createElement('thead'); const fhr = document.createElement('tr');
    for (const [h, r] of [['Arquivo', false], ['Tamanho', true], ['Última gravação', true], ['', true]]) { const th = el('th', r ? 'r' : '', h); th.scope = 'col'; fhr.append(th); }
    fh.append(fhr);
    const fb = document.createElement('tbody');
    fTable.append(fh, fb); fBody.append(fTable);
    const fNote = el('p', 'foot'); fNote.style.setProperty('padding', '12px 16px 16px');
    cFiles.append(cardHead('Arquivos de log no disco'), fBody, fNote);

    const cCfg = card();
    const lvlSel = el('select', 'input'); lvlSel.id = 'lognivel'; lvlSel.setAttribute('aria-label', 'Nível mínimo de gravação');
    for (const l of [...LEVELS].reverse()) { const o = el('option', '', l.label === 'Info' ? 'Info (padrão do terminal)' : l.label); o.value = l.key; lvlSel.append(o); }
    const cfgStatus = el('p', 'status'); cfgStatus.setAttribute('role', 'status');
    const lvlField = el('label', 'field'); lvlField.htmlFor = 'lognivel';
    lvlField.append(el('span', '', 'Nível mínimo de gravação'), lvlSel);
    cCfg.append(cardHead('Gravação'), lvlField, cfgStatus,
      el('p', 'foot', 'Linhas abaixo do nível escolhido não são gravadas (nem na memória nem em disco). Debug mostra cada requisição ao ASC e cada pedido de streaming. A passkey, cookies, senhas e tokens são removidos antes de qualquer gravação. A mudança vale até reiniciar o serviço; para fixar, use LOG_LEVEL em private/service.env.'));

    const grid = el('div', 'grid grid-2');
    grid.append(cFiles, cCfg);
    root.append(head, bar, view, grid);

    // --------------------------------------------------------------- estado
    const st = { levels: new Set(DEFAULT_LEVELS), fonte: '', q: '', janela: '6h', live: true };
    let boot = null; let lastId = 0; let firstId = 0; let total = 0; let more = false;
    let timer = null; let busy = false; let unseen = 0; let destroyed = false;
    const lines = new Map(); // id -> elemento

    function readParams(q) {
      const p = new URLSearchParams(q || '');
      const lv = (p.get('nivel') || '').split(',').filter((x) => LEVELS.some((l) => l.key === x));
      st.levels = new Set(lv.length ? lv : DEFAULT_LEVELS);
      st.fonte = p.get('fonte') || '';
      st.q = p.get('q') || '';
      st.janela = RANGES.some(([k]) => k === p.get('janela')) ? p.get('janela') : '6h';
    }
    function pushUrl() {
      const p = new URLSearchParams();
      const lv = LEVELS.map((l) => l.key).filter((k) => st.levels.has(k));
      if (lv.join() !== DEFAULT_LEVELS.join()) p.set('nivel', lv.join(','));
      if (st.fonte) p.set('fonte', st.fonte);
      if (st.q) p.set('q', st.q);
      if (st.janela !== '6h') p.set('janela', st.janela);
      const qs = p.toString();
      history.replaceState(null, '', `/logs${qs ? `?${qs}` : ''}`);
    }
    function since() {
      const r = RANGES.find(([k]) => k === st.janela);
      return r && r[2] ? Date.now() - r[2] : 0;
    }
    function filterQuery(extra = {}) {
      const p = new URLSearchParams();
      const lv = LEVELS.map((l) => l.key).filter((k) => st.levels.has(k));
      if (lv.length && lv.length < LEVELS.length) p.set('nivel', lv.join(','));
      if (st.fonte) p.set('fonte', st.fonte);
      if (st.q) p.set('q', st.q);
      const s = since(); if (s) p.set('desde', String(s));
      for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
      return p.toString();
    }
    function syncControls() {
      for (const l of LEVELS) chipRefs[l.key].b.setAttribute('aria-pressed', String(st.levels.has(l.key)));
      if (input.value !== st.q) input.value = st.q;
      janelaSel.value = st.janela;
      if ([...fonteSel.options].some((o) => o.value === st.fonte)) fonteSel.value = st.fonte;
      bLive.setAttribute('aria-pressed', String(st.live));
      clear(bLive);
      // Ponto que pulsa quando ao vivo (o ícone de carregamento girando parecia travado/erro).
      const dot = el('span', st.live ? 'live-dot is-live' : 'live-dot'); dot.setAttribute('aria-hidden', 'true');
      bLive.append(dot, document.createTextNode(st.live ? 'Ao vivo' : 'Pausado'));
      aTxt.href = `/api/logs/download?${filterQuery({ formato: 'txt' })}`;
      aNd.href = `/api/logs/download?${filterQuery({ formato: 'ndjson' })}`;
    }
    function toggleLevel(k) {
      if (st.levels.has(k)) { if (st.levels.size > 1) st.levels.delete(k); } else st.levels.add(k);
      changed();
    }
    function changed() { pushUrl(); syncControls(); fetchFull(); }

    // ---------------------------------------------------------------- linhas
    function highlight(node, text, q) {
      if (!q) { node.textContent = text; return; }
      const low = text.toLowerCase(); const needle = q.toLowerCase();
      let i = 0;
      for (;;) {
        const at = low.indexOf(needle, i);
        if (at < 0) { node.append(document.createTextNode(text.slice(i))); break; }
        node.append(document.createTextNode(text.slice(i, at)));
        node.append(el('mark', '', text.slice(at, at + needle.length)));
        i = at + needle.length;
      }
    }
    function makeLine(e) {
      const tone = LEVELS.find((l) => l.key === e.level)?.tone ?? 'neutral';
      const root = el('div', `ll t-${tone}`);
      root.dataset.id = String(e.id); root.dataset.level = e.level;
      const main = el('div', 'll-main');
      const t = el('time', 'll-t', clock(e.t)); t.dateTime = new Date(e.t).toISOString();
      const lv = el('span', 'll-lv', e.level === 'error' ? 'ERRO' : e.level === 'warn' ? 'AVISO' : e.level.toUpperCase());
      const src = el('span', 'll-src', e.src);
      const msg = el('span', 'll-msg');
      highlight(msg, e.msg, st.q);
      main.append(t, lv, src, msg);
      root.append(main);
      if (e.data !== undefined) {
        const btn = el('button', 'll-more', '{…}'); btn.type = 'button'; btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-label', 'Mostrar dados da linha');
        const pre = el('pre', 'll-data', JSON.stringify(e.data, null, 2)); pre.hidden = true;
        btn.addEventListener('click', () => { const open = pre.hidden; pre.hidden = !open; btn.setAttribute('aria-expanded', String(open)); });
        main.append(btn); root.append(pre);
      }
      root.dataset.text = `${clock(e.t)} ${e.level.toUpperCase().padEnd(5)} [${e.src}] ${e.msg}`;
      return root;
    }
    function nearBottom() { return box.scrollHeight - box.scrollTop - box.clientHeight < 90; }
    function toEnd() { box.scrollTop = box.scrollHeight; unseen = 0; renderHint(); }
    function renderHint() { setText(hint, unseen ? `${unseen} nova(s) abaixo` : ''); }
    function renderMeta() {
      const shown = lines.size;
      setText(count, `${shown} linha(s) na tela · ${total} na memória`);
      empty.hidden = shown > 0;
      bMore.hidden = !more;
    }
    function append(entries) {
      const stick = st.live && nearBottom();
      for (const e of entries) {
        if (lines.has(e.id)) continue;
        const node = makeLine(e);
        lines.set(e.id, node);
        box.append(node);
        lastId = Math.max(lastId, e.id);
        if (!stick) unseen += 1;
      }
      while (lines.size > MAX_DOM) { const [id, node] = lines.entries().next().value; node.remove(); lines.delete(id); more = true; }
      if (stick) toEnd(); else renderHint();
      renderMeta();
    }
    function prepend(entries) {
      const prev = box.scrollHeight;
      const frag = document.createDocumentFragment();
      for (const e of entries) { if (lines.has(e.id)) continue; const n = makeLine(e); lines.set(e.id, n); frag.append(n); }
      box.prepend(frag);
      box.scrollTop += box.scrollHeight - prev;
    }

    // ----------------------------------------------------------------- rede
    function applyMeta(d) {
      total = d.total;
      for (const l of LEVELS) setText(chipRefs[l.key].n, String(d.counts[l.key] ?? 0));
      const keep = fonteSel.value || st.fonte;
      const opts = ['', ...d.sources];
      if (opts.join('|') !== [...fonteSel.options].map((o) => o.value).join('|')) {
        clear(fonteSel);
        for (const s of opts) { const o = el('option', '', s || 'Todas as fontes'); o.value = s; fonteSel.append(o); }
        fonteSel.value = opts.includes(keep) ? keep : '';
      }
      if (lvlSel.value !== d.level && document.activeElement !== lvlSel) lvlSel.value = d.level;
      setText(sub, `${d.total} linha(s) em memória · gravando a partir de ${d.level}`);
    }
    async function fetchFull() {
      if (busy) { busy = 'again'; return; }
      busy = true;
      try {
        const d = await app().call('GET', `logs?${filterQuery({ limit: 500 })}`);
        boot = d.boot; lastId = 0; unseen = 0;
        for (const n of lines.values()) n.remove();
        lines.clear();
        more = d.more; firstId = d.entries[0]?.id ?? 0;
        applyMeta(d);
        append(d.entries);
        lastId = Math.max(lastId, d.entries.length ? d.entries[d.entries.length - 1].id : 0);
        toEnd();
      } catch (e) { setText(sub, `Não foi possível ler os logs: ${e.message}`); }
      const again = busy === 'again';
      busy = false;
      if (again && !destroyed) fetchFull();
    }
    async function poll() {
      if (destroyed || !st.live || busy || document.hidden) return;
      busy = true;
      try {
        const d = await app().call('GET', `logs?${filterQuery({ after: lastId, limit: 500 })}`);
        if (d.boot !== boot || d.lastId < lastId) { busy = false; fetchFull(); return; }
        applyMeta(d);
        if (d.entries.length) append(d.entries);
      } catch { /* o addon pode estar reiniciando: tenta de novo no próximo ciclo */ }
      // Um filtro mudou durante a leitura: refaz a carga completa em vez de perder o pedido.
      if (busy === 'again') { busy = false; fetchFull(); } else busy = false;
    }
    async function loadMore() {
      if (!firstId) return;
      bMore.disabled = true;
      try {
        const d = await app().call('GET', `logs?${filterQuery({ before: firstId, limit: 500 })}`);
        if (d.entries.length) { firstId = d.entries[0].id; prepend(d.entries); }
        more = d.more;
      } catch (e) { setText(hint, e.message); }
      bMore.disabled = false;
      renderMeta();
    }
    async function loadFiles() {
      try {
        const d = await app().call('GET', 'logs/files');
        clear(fb);
        for (const f of d.files) {
          const tr = document.createElement('tr');
          const a = el('a', 'link', 'Baixar'); a.href = `/api/logs/file?nome=${encodeURIComponent(f.name)}`; a.setAttribute('download', f.name);
          const c1 = el('td', 'mono', f.name); const c4 = document.createElement('td'); c4.className = 'r'; c4.append(a);
          tr.append(c1, el('td', 'r', fmtBytes(f.bytes)), el('td', 'r', fmtDate(new Date(f.modifiedAt).toISOString())), c4);
          fb.append(tr);
        }
        if (!d.files.length) { const tr = document.createElement('tr'); const c = el('td', 'muted', 'Nenhum arquivo ainda: a gravação em disco começa com o serviço.'); c.colSpan = 4; tr.append(c); fb.append(tr); }
        setText(fNote, `Cada arquivo guarda um dia (NDJSON, uma linha por registro), com permissão 0600 em private/logs/. Arquivos com mais de ${d.retentionDays} dias são apagados. Passado o teto de 20 MB por dia, só aviso e erro continuam sendo gravados.`);
      } catch { /* sem arquivos */ }
    }

    // -------------------------------------------------------------- eventos
    input.addEventListener('input', () => { st.q = input.value.trim(); clearTimeout(input._t); input._t = setTimeout(changed, 250); });
    fonteSel.addEventListener('change', () => { st.fonte = fonteSel.value; changed(); });
    janelaSel.addEventListener('change', () => { st.janela = janelaSel.value; changed(); });
    bLive.addEventListener('click', () => { st.live = !st.live; syncControls(); if (st.live) { poll(); } });
    bEnd.addEventListener('click', toEnd);
    bMore.addEventListener('click', loadMore);
    bClear.addEventListener('click', () => { for (const n of lines.values()) n.remove(); lines.clear(); more = false; unseen = 0; renderMeta(); renderHint(); });
    bCopy.addEventListener('click', async () => {
      const text = [...box.querySelectorAll('.ll')].map((n) => n.dataset.text).join('\n');
      try { await navigator.clipboard.writeText(text); setText(hint, `${lines.size} linha(s) copiada(s)`); }
      catch { const r = document.createRange(); r.selectNodeContents(box); const s = getSelection(); s.removeAllRanges(); s.addRange(r); setText(hint, 'Selecionado: use Ctrl+C'); }
    });
    box.addEventListener('scroll', () => { if (nearBottom() && unseen) { unseen = 0; renderHint(); } }, { passive: true });
    lvlSel.addEventListener('change', async () => {
      setText(cfgStatus, 'Aplicando…'); cfgStatus.classList.remove('error');
      try { const r = await app().call('POST', 'logs/level', { nivel: lvlSel.value }); setText(cfgStatus, `Nível mínimo agora: ${r.level}.`); fetchFull(); }
      catch (e) { setText(cfgStatus, e.message); cfgStatus.classList.add('error'); }
    });

    readParams(q0); syncControls();
    fetchFull(); loadFiles();
    timer = setInterval(poll, POLL_MS);

    return {
      root,
      params(q) { const before = `${[...st.levels].sort()}|${st.fonte}|${st.q}|${st.janela}`; readParams(q); syncControls(); if (before !== `${[...st.levels].sort()}|${st.fonte}|${st.q}|${st.janela}`) fetchFull(); },
      update() { /* os logs têm leitura própria; o painel não os empurra */ },
      destroy() { destroyed = true; clearInterval(timer); clearTimeout(input._t); },
    };
  }

  window.Views = window.Views || {};
  window.Views.logs = logsView;
  void secTitle; void badge;
})();
