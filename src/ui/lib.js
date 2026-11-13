// Helpers do painel: DOM seguro, formatação pt-BR, estados dos filmes e os
// componentes visuais do padrão do ASC (badge, medidor, card, kpi).
// Todo texto vindo do servidor entra por textContent: nomes de filme são dados
// não confiáveis. Nada aqui usa innerHTML.
(() => {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const num = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
  const num0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  const num2 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

  // ---------------------------------------------------------------- DOM
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function icon(name, cls) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('class', `ic${cls ? ` ${cls}` : ''}`);
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(SVGNS, 'use');
    u.setAttribute('href', `#i-${name}`);
    s.append(u);
    return s;
  }
  function svg(tag, attrs = {}, cls) {
    const e = document.createElementNS(SVGNS, tag);
    if (cls) e.setAttribute('class', cls);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  }
  const setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
  const clear = (node) => node.replaceChildren();

  // ---------------------------------------------------------- formatação
  const fmtBytes = (n) => {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n; let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${num.format(v)} ${u[i]}`;
  };
  const fmtSpeed = (n) => `${fmtBytes(n || 0)}/s`;
  const fmtHours = (h) => `${num.format(h)} h`;
  const fmtDays = (d) => (d === null || d === undefined ? '—' : d <= 0 ? 'vencido' : d < 1 ? `${num.format(d * 24)} h` : `${num.format(d)} dias`);
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const fmtClock = (ms) => new Date(ms).toLocaleTimeString('pt-BR');
  const fmtRatio = (r) => (r === null || r === undefined ? '—' : num2.format(r));
  const ago = (iso) => {
    if (!iso) return '—';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 90) return 'agora há pouco';
    if (s < 5400) return `há ${num0.format(s / 60)} min`;
    if (s < 172800) return `há ${num0.format(s / 3600)} h`;
    return `há ${num0.format(s / 86400)} dias`;
  };
  const pct = (x) => `${Math.max(0, Math.min(100, x * 100)).toFixed(1)}%`;

  // -------------------------------------------------------------- estados
  // tone = cor do domínio: seed (verde), primary (azul), complete (âmbar),
  // leech (vermelho), neutral. Ícone + rótulo sempre juntos (cor nunca sozinha).
  const STATE = {
    hnr: { label: 'Hit-and-run', icon: 'circle-x', tone: 'leech', order: 0 },
    missing: { label: 'Sem arquivo para semear', icon: 'hard-drive-download', tone: 'complete', order: 1 },
    paused: { label: 'Seed parado', icon: 'wifi-off', tone: 'complete', order: 1 },
    seeding: { label: 'Semeando', icon: 'arrow-up-from-line', tone: 'seed', order: 2 },
    awaiting: { label: 'Aguardando o tracker', icon: 'clock', tone: 'complete', order: 3 },
    completing: { label: 'Baixando o restante', icon: 'arrow-down-to-line', tone: 'primary', order: 4 },
    partial: { label: 'Só streaming', icon: 'monitor-play', tone: 'neutral', order: 5 },
    done: { label: 'Cumprido', icon: 'circle-check', tone: 'seed', order: 6 },
    unstarted: { label: 'Não iniciado', icon: 'eye-off', tone: 'neutral', order: 7 },
  };
  const RISK_ORDER = { crit: 0, warn: 1, ok: 2 };
  const EXPLAIN = {
    hnr: 'O tracker registrou hit-and-run. Continue semeando: parar de novo é reincidência.',
    paused: 'Há obrigação de seed e o torrent não está ativo. Mantenha a ponte ligada.',
    missing: 'O tracker cobra seed, mas falta o .torrent ou o arquivo completo aqui, então não dá para semear. É preciso obter o .torrent pelo catálogo ASC e/ou baixar de novo.',
    seeding: 'Semeando para cumprir as 72 h. O tracker confirma em seguida.',
    awaiting: 'Tempo local cumprido; falta o tracker confirmar na próxima conciliação.',
    completing: 'Baixando o restante com prioridade baixa; o seed de 72 h começa ao concluir.',
    partial: 'Você viu só trechos. O site não lista este filme nas pendências. Para quitar o registro, conclua o download.',
    done: 'Obrigação cumprida e confirmada pelo tracker. A ponte encerra o seed e libera disco e rede.',
    unstarted: 'Está na biblioteca, mas nunca foi aberto. Sem snatch e sem obrigação.',
  };

  // Cor efetiva do filme: o risco vence o tom padrão do estado.
  function toneOf(t) {
    if (t.risk === 'crit') return 'leech';
    if (t.risk === 'warn') return 'complete';
    return (STATE[t.state] ?? STATE.unstarted).tone;
  }
  function iconOf(t) {
    const base = STATE[t.state] ?? STATE.unstarted;
    if (t.risk === 'crit' && t.state !== 'hnr') return 'circle-x';
    return base.icon;
  }
  function sortTitles(list) {
    return [...list].sort((a, b) => (
      RISK_ORDER[a.risk] - RISK_ORDER[b.risk]
      || (STATE[a.state]?.order ?? 9) - (STATE[b.state]?.order ?? 9)
      || a.name.localeCompare(b.name, 'pt-BR')));
  }

  // Filtros por situação (usados na sidebar e na lista).
  const FILTERS = [
    { key: 'todos', label: 'Todos', icon: 'list', tone: 'neutral', test: () => true },
    { key: 'atencao', label: 'Atenção', icon: 'flag', tone: 'complete', test: (t) => t.risk !== 'ok' },
    { key: 'seed', label: 'Seed a cumprir', icon: 'arrow-up-from-line', tone: 'seed', test: (t) => ['seeding', 'paused', 'missing', 'awaiting', 'hnr'].includes(t.state) },
    { key: 'baixando', label: 'Baixando', icon: 'arrow-down-to-line', tone: 'primary', test: (t) => t.state === 'completing' },
    { key: 'cumpridos', label: 'Cumpridos', icon: 'circle-check', tone: 'seed', test: (t) => t.state === 'done' },
    { key: 'streaming', label: 'Só streaming', icon: 'monitor-play', tone: 'neutral', test: (t) => t.state === 'partial' },
    { key: 'novos', label: 'Não iniciados', icon: 'eye-off', tone: 'neutral', test: (t) => t.state === 'unstarted' },
  ];

  // ----------------------------------------------------------- componentes
  // badge: cor da família a 15% no fundo + cor cheia no texto.
  function badge(text, tone, opts = {}) {
    const b = el('span', 'badge');
    if (tone && tone !== 'neutral') { b.classList.add('badge-tone', `t-${tone}`); }
    if (opts.line) b.classList.add('badge-line');
    if (opts.upper) b.classList.add('badge-up');
    if (opts.icon) b.append(icon(opts.icon));
    b.append(document.createTextNode(text));
    return b;
  }
  function stateBadge(t) {
    const base = STATE[t.state] ?? STATE.unstarted;
    let label = base.label;
    if (t.state === 'seeding' && t.risk === 'warn') label = 'Semeando, prazo curto';
    const b = badge(label, toneOf(t), { icon: iconOf(t) });
    return b;
  }
  function pill(text, tone) {
    const p = el('span', `pill t-${tone}`, text);
    return p;
  }

  // medidor: o preenchimento leva o tom; o trilho é um tom claro da mesma rampa.
  function meter(opts = {}) {
    const root = el('div', `meter${opts.large ? ' meter-lg' : ''}`);
    const fill = document.createElement('i');
    root.append(fill);
    return {
      root,
      set(fraction, tone, off) {
        root.classList.toggle('off', Boolean(off));
        fill.style.setProperty('width', off ? '0%' : pct(fraction));
        fill.className = tone ? `t-${tone}` : '';
      },
    };
  }

  function card(cls) { return el('section', `card${cls ? ` ${cls}` : ''}`); }
  function secTitle(text, tag = 'h2') { return el(tag, 'sec-title', text); }
  function cardHead(title, extra) {
    const head = el('div', 'card-head');
    head.append(secTitle(title));
    if (extra) head.append(extra);
    return head;
  }
  function link(href, text, cls = 'link') {
    const a = el('a', cls, text);
    a.href = href;
    a.dataset.link = '';
    return a;
  }

  // KPI: ícone quadrado no tom do domínio + rótulo + valor + legenda.
  function kpi({ icon: iconName, tone = 'neutral', label }) {
    const root = card();
    root.classList.add('kpi', `t-${tone}`);
    const ic = el('div', 'kpi-ic');
    ic.append(icon(iconName, 'ic-20'));
    const body = el('div', 'kpi-body');
    const lab = el('div', 'kpi-label', label);
    const value = el('div', 'kpi-value');
    const big = el('span');
    const unit = el('span', 'kpi-unit');
    value.append(big, unit);
    const sub = el('div', 'kpi-sub');
    body.append(lab, value, sub);
    root.append(ic, body);
    return {
      root, big, unit, sub,
      setTone(t) { root.className = `card kpi t-${t}`; },
      set(b, u, s) { setText(big, b); setText(unit, u ?? ''); setText(sub, s ?? ''); },
    };
  }

  function alertBox(tone, title, body, action) {
    const a = el('div', `alert t-${tone}`);
    a.append(icon(tone === 'leech' ? 'circle-x' : tone === 'seed' ? 'circle-check' : 'flag', 'ic-20'));
    const txt = el('div');
    txt.append(el('div', 'alert-title', title));
    if (body) txt.append(el('div', 'alert-body', body));
    a.append(txt);
    if (action) { a.append(action); }
    return a;
  }

  // Aviso de "instalação pendente" (assistente concluído sem URL do addon): usado na Visão geral
  // e nas Configurações. Leva direto à aba Addons, onde a credencial é criada.
  function installPendingAlert() {
    const go = link('/conta?aba=addons', 'Instalar agora', 'btn btn-outline btn-sm btn-icon');
    go.append(icon('arrow-right'));
    return alertBox('complete', 'Falta instalar o addon no Stremio', 'O assistente foi concluído, mas ainda não há credencial para o addon.', go);
  }

  window.UI = {
    el, icon, svg, setText, clear, num, num0, fmtBytes, fmtSpeed, fmtHours, fmtDays, fmtDate, fmtClock, fmtRatio, ago, pct,
    STATE, EXPLAIN, RISK_ORDER, FILTERS, toneOf, iconOf, sortTitles,
    badge, stateBadge, pill, meter, card, secTitle, cardHead, link, kpi, alertBox, installPendingAlert,
  };
})();
