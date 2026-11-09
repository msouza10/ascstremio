// Roteador (History API, URLs reais), sessão ASC, leitura periódica do painel e
// o shell compartilhado (estatísticas do topo, sidebar, tema).
(() => {
  const U = window.UI;
  const { el, icon, setText, clear, badge, pill, fmtBytes, fmtRatio, ago, FILTERS } = U;
  const POLL_MS = 5000;
  const $ = (id) => document.getElementById(id);

  const store = { status: null, snap: null };
  let view = null; let viewKey = ''; let timer = null; let loading = false; let autoVerified = false;

  // ---------------------------------------------------------------- API
  async function call(method, route, body) {
    const opts = { method, headers: {} };
    if (method === 'POST') {
      opts.headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': window.ASC_CSRF };
      opts.body = JSON.stringify(body ?? {});
    }
    let res;
    try { res = await fetch(`/api/${route}`, opts); } catch { throw new Error('Falha ao falar com o addon local.'); }
    let data = {};
    try { data = await res.json(); } catch { /* corpo vazio */ }
    if (!res.ok) { const err = new Error(data.error || 'Não foi possível concluir.'); err.status = res.status; err.data = data; throw err; }
    return data;
  }

  // ------------------------------------------------------------- rotas
  const ROUTES = [
    { re: /^\/configuracoes$/, key: () => 'configuracoes', title: 'Configurações', make: () => window.Views.configuracoes() },
    { re: /^\/assistente$/, key: () => 'assistente', title: 'Assistente', make: () => window.Views.assistente() },
    { re: /^\/$/, key: () => 'overview', title: 'Visão geral', make: () => window.Views.overview() },
    { re: /^\/filmes$/, key: () => 'filmes', title: 'Filmes', make: () => window.Views.filmes(location.search) },
    { re: /^\/filmes\/([^/]+)$/, key: (m) => `filme:${m[1]}`, title: 'Filme', make: (m) => window.Views.filmeDetalhe(decodeURIComponent(m[1])) },
    { re: /^\/trafego$/, key: () => 'trafego', title: 'Tráfego e disco', make: () => window.Views.trafego() },
    { re: /^\/logs$/, key: () => 'logs', title: 'Logs', public: true, make: () => window.Views.logs(location.search) },
    { re: /^\/conta$/, key: () => 'conta', title: 'Conta e serviço', make: () => window.Views.conta(location.search) },
    { re: /^\/entrar$/, key: () => 'entrar', title: 'Entrar', make: () => window.Views.entrar(location.search) },
  ];

  function match(path) {
    for (const r of ROUTES) { const m = r.re.exec(path); if (m) return { r, m }; }
    return null;
  }

  function nav(href, replace) {
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin) return;
    const same = url.pathname + url.search === location.pathname + location.search;
    if (!same) history[replace ? 'replaceState' : 'pushState'](null, '', url.pathname + url.search);
    render();
  }

  function markNav() {
    const path = location.pathname;
    const estado = new URLSearchParams(location.search).get('estado') || 'todos';
    for (const a of document.querySelectorAll('#nav a, #nav-mobile a')) {
      const h = a.getAttribute('href');
      const on = h === '/' ? path === '/' : path === h || path.startsWith(`${h}/`);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    for (const a of document.querySelectorAll('#sidebar a[data-estado]')) {
      a.setAttribute('aria-current', String(path === '/filmes' && a.dataset.estado === estado));
    }
  }

  function render() {
    const connected = Boolean(store.status?.connected);
    let path = location.pathname.replace(/\/+$/, '') || '/';
    const redo = new URLSearchParams(location.search).has('de-novo');
    // Os logs abrem sem sessão: é onde se descobre por que o login falhou.
    const isPublic = Boolean(match(path)?.r.public);
    if (!connected && path !== '/entrar' && !isPublic) { history.replaceState(null, '', '/entrar'); path = '/entrar'; }
    else if (connected && path === '/entrar' && !redo) { history.replaceState(null, '', '/'); path = '/'; }

    const found = match(path) ?? match('/');
    const key = found.r.key(found.m);
    document.documentElement.dataset.route = key.split(':')[0];
    document.querySelector('.shell').classList.toggle('no-side', !connected);
    const showNav = connected || Boolean(found.r.public);
    $('nav').hidden = !showNav; $('nav-mobile').hidden = !showNav;

    if (view && key === viewKey) {
      view.params?.(location.search);
    } else {
      view?.destroy?.();
      U.tip.hide();
      view = found.r.make(found.m);
      viewKey = key;
      const host = $('view');
      clear(host);
      host.append(view.root);
      window.scrollTo(0, 0);
      host.setAttribute('tabindex', '-1');
      host.focus({ preventScroll: true });
    }
    document.title = `${found.r.title} · Monitor ASC`;
    if (store.snap && connected) view.update(store.snap);
    else if (!connected && !found.r.public) view.update({});
    markNav();
    updateShell();
  }

  // -------------------------------------------------------------- shell
  const side = { built: false, items: new Map() };

  function buildSidebar() {
    const sb = $('sidebar');
    clear(sb);
    const cs = U.card();
    const head = el('div', 'card-head');
    head.append(U.secTitle('Sessão'));
    side.badge = el('span');
    head.append(side.badge);
    side.sessText = el('p', 'muted');
    cs.append(head, side.sessText, U.link('/conta', 'Conta e serviço'));
    const cf = U.card();
    cf.append(U.cardHead('Situação'));
    const nav2 = el('nav', 'stack');
    nav2.style.setProperty('gap', '2px');
    for (const f of FILTERS) {
      const a = el('a', `side-link t-${f.tone}`);
      a.href = f.key === 'todos' ? '/filmes' : `/filmes?estado=${f.key}`;
      a.dataset.link = ''; a.dataset.estado = f.key;
      const l = el('span', 'l'); l.append(icon(f.icon), document.createTextNode(f.label));
      const n = pill('0', 'neutral');
      a.append(l, n);
      nav2.append(a);
      side.items.set(f.key, n);
    }
    cf.append(nav2);
    sb.append(cs, cf);
    side.built = true;
  }

  function updateShell() {
    const connected = Boolean(store.status?.connected);
    const ts = $('topstats');
    clear(ts);
    if (connected && store.snap?.stats) {
      const st = store.snap.stats;
      const add = (ic, tone, label, value) => {
        const s = el('div', `stat t-${tone}`);
        s.append(icon(ic, 'ic-14'), el('small', '', label), document.createTextNode(value));
        ts.append(s);
      };
      add('scale', st.ratio >= 1 ? 'seed' : 'leech', 'Ratio', fmtRatio(st.ratio));
      add('arrow-up-from-line', 'seed', 'Upload', fmtBytes(st.uploaded));
      add('arrow-down-to-line', 'primary', 'Download', fmtBytes(st.downloaded));
      add('users', 'neutral', 'Seed/Leech', `${st.seeding ?? 0}/${st.leeching ?? 0}`);
    }
    if (!connected) return;
    if (!side.built) buildSidebar();
    const s = store.status;
    clear(side.badge);
    side.badge.append(badge('Conectado', 'seed', { icon: 'circle-check' }));
    setText(side.sessText, s.lastLoginAt ? `Último login ${ago(s.lastLoginAt)}.` : 'Data do último login desconhecida.');
    if (store.snap) for (const f of FILTERS) setText(side.items.get(f.key), String(store.snap.titles.filter(f.test).length));
    markNav();
  }

  // ---------------------------------------------------------- polling
  async function refresh(manual) {
    if (loading || !store.status?.connected) return;
    loading = true;
    const host = $('view');
    if (manual) host.setAttribute('aria-busy', 'true');
    try {
      const data = await call('GET', 'monitor');
      store.snap = data;
      view?.update(data);
      updateShell();
    } catch (e) {
      if (e.status === 401) { store.status = { ...store.status, connected: false, saved: false }; store.snap = null; stopPolling(); side.built = false; render(); }
    } finally {
      loading = false;
      host.removeAttribute('aria-busy');
    }
  }
  function startPolling() { if (timer) return; refresh(false); timer = setInterval(() => { if (!document.hidden) refresh(false); }, POLL_MS); }
  function stopPolling() { if (timer) clearInterval(timer); timer = null; }

  // ------------------------------------------------------------ sessão
  function applyStatus(s) {
    store.status = { ...store.status, ...s };
    if (s.connected) startPolling(); else { stopPolling(); store.snap = null; side.built = false; }
  }
  async function session(action, body) {
    const data = await call('POST', action, body ?? {});
    applyStatus(data);
    if (action === 'login' || (action === 'verify' && data.connected)) {
      // Primeiro login com o assistente ainda não concluído nem adiado: oferece-o uma vez.
      // Falha ao consultar nunca atrapalha o login (a conclusão fica em wizard.json, não na sessão).
      let offer = false;
      if (action === 'login') { try { offer = window.SettingsModel.shouldOfferWizard(await call('GET', 'settings')); } catch { /* segue para a visão geral */ } }
      nav(offer ? '/assistente' : '/', true);
    }
    else if (action === 'logout') nav('/entrar', true);
    else render();
    return data;
  }

  // -------------------------------------------------------------- boot
  function bindShell() {
    document.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[data-link]');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      nav(a.getAttribute('href'));
    });
    window.addEventListener('popstate', render);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
    $('theme').addEventListener('click', () => {
      const dark = !document.documentElement.classList.contains('dark');
      document.documentElement.classList.toggle('dark', dark);
      try { localStorage.setItem('monitor.theme', dark ? 'dark' : 'light'); } catch { /* sem storage */ }
      if (store.snap && view) view.update(store.snap);
    });
  }

  async function boot() {
    window.App = { call, nav, refresh, session, store, markNav };
    bindShell();
    try {
      applyStatus(await call('GET', 'status'));
    } catch (e) {
      store.status = { connected: false, message: e.message };
    }
    render();
    // Sessão salva de uma execução anterior: confirma uma vez para abrir o painel.
    if (store.status.saved && !store.status.connected && !autoVerified) {
      autoVerified = true;
      try { await session('verify'); } catch { render(); }
    }
  }

  boot();
})();
