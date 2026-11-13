// Assistente depois do primeiro login e página permanente de Configurações (issue #23).
// A lista de opções, os tipos, os limites e as regras vêm do servidor (esquema único em
// src/settings.js); aqui só há apresentação. Nada usa innerHTML: textos entram por textContent.
(() => {
  const U = window.UI;
  const M = window.SettingsModel;
  const { el, icon, clear, setText, badge, card, cardHead, alertBox, ago, fmtDate } = U;
  const app = () => window.App;
  let uid = 0;

  // ------------------------------------------------------------- utilitários
  function liveRegion() {
    const r = el('div', 'status');
    r.setAttribute('role', 'status');
    r.setAttribute('aria-live', 'polite');
    return r;
  }

  // Erro do servidor -> caixa de alerta focável (leitores de tela anunciam; o foco vai para ela).
  function errorBox() {
    const box = el('div', 'alerts');
    box.setAttribute('role', 'alert');
    box.tabIndex = -1;
    return {
      root: box,
      show(title, lines) {
        clear(box);
        const body = el('div');
        for (const l of lines ?? []) {
          if (l && typeof l === 'object') {
            // Item com ação (ex.: ir até o campo inválido): botão em forma de link, alcançável por teclado.
            const row = el('div', 'alert-body');
            const b = el('button', 'link-btn', l.text); b.type = 'button';
            b.addEventListener('click', l.onClick);
            row.append(b); body.append(row);
          } else body.append(el('div', 'alert-body', l));
        }
        const a = alertBox('leech', title);
        a.querySelector('div').append(...body.childNodes);
        box.append(a);
        box.focus({ preventScroll: false });
      },
      clear() { clear(box); },
    };
  }

  // Sem texto "Copiado.": o ícone do próprio botão vira ✓ por 2 s (e volta). Só a falha escreve.
  async function copy(text, btn, status) {
    try {
      await navigator.clipboard.writeText(text);
      const ic = btn.querySelector('.ic use');
      const label = btn.querySelector('.btn-label');
      if (ic && label) {
        const old = label.textContent;
        ic.setAttribute('href', '#i-check'); setText(label, 'Copiada');
        setTimeout(() => { ic.setAttribute('href', '#i-copy'); setText(label, old); }, 2000);
      }
    } catch { setText(status, 'Não foi possível copiar sozinho: selecione o texto e copie.'); }
  }

  // Campo de uma opção do esquema. onInput(texto|null). Segue o que o servidor diz: bloqueio,
  // origem e descrição vêm de `option`; limites só viram atributos do input (o servidor valida).
  // `short` (assistente): só o aviso de reinício e a dica curta; o texto completo e as origens
  // continuam na página Configurações.
  function optionField(option, drafts, onInput, { noReset = false, short = false } = {}) {
    uid += 1;
    const id = `opt-${option.key}-${uid}`;
    const wrap = el('div', 'opt');
    const kind = M.kindOf(option);
    const friendly = M.labelOf(option) !== option.key;
    const title = el('div', 'opt-title');
    const label = el('label', friendly ? 'opt-label' : 'opt-label opt-key', M.labelOf(option));
    label.htmlFor = id;
    title.append(label);
    if (friendly) title.append(el('span', 'opt-key', option.key));
    wrap.append(title);

    const meta = el('div', 'item-badges');
    // Só o que foge do padrão ganha selo (ambiente/arquivo) e o reinício pendente. O "vale após
    // reiniciar" de cada opção aparece na conferência antes de salvar, onde de fato decide algo.
    if (!short && option.source !== 'default') meta.append(badge(M.originText(option), option.source === 'env' ? 'complete' : 'neutral', { line: true }));
    if (option.pending) meta.append(badge('reinício pendente', 'complete', { icon: 'flag' }));
    if (meta.children.length) wrap.append(meta);

    const descId = `${id}-d`;
    const errId = `${id}-e`;
    const hint = short ? M.hintOf(option) : null;
    const desc = el('p', hint ? 'opt-hint' : 'foot', hint ?? option.description);
    desc.id = descId;
    const err = el('p', 'opt-error'); err.id = errId; err.hidden = true;

    const current = Object.prototype.hasOwnProperty.call(drafts, option.key) && drafts[option.key] !== null ? drafts[option.key] : M.textOf(option.value);
    let input;
    if (option.secret) {
      input = el('input', 'input'); input.value = option.defined ? '(definido)' : '(não definido)';
    } else if (kind === 'enum' || kind === 'bool') {
      input = el('select', 'input');
      const values = kind === 'bool' ? ['false', 'true'] : option.values;
      for (const v of values) { const o = el('option', '', M.valueLabel(option, v)); o.value = v; input.append(o); }
      input.value = current;
    } else {
      input = el('input', 'input');
      input.type = kind === 'number' ? 'number' : 'text';
      if (kind === 'number') {
        input.step = option.type === 'int' ? '1' : 'any';
        if (option.min !== null) input.min = String(option.min);
        if (option.max !== null) input.max = String(option.max);
        input.inputMode = 'decimal';
      }
      input.value = current;
      input.autocomplete = 'off'; input.spellcheck = false;
    }
    input.id = id;
    input.setAttribute('aria-describedby', `${descId} ${errId}`);
    if (!option.editable) {
      input.disabled = true;
      input.setAttribute('aria-disabled', 'true');
    } else {
      const fire = () => onInput(input.value);
      input.addEventListener('input', fire);
      input.addEventListener('change', fire);
    }
    const row = el('div', 'opt-row');
    row.append(input);
    if (option.unit) row.append(el('span', 'muted', option.unit));
    if (option.editable && option.source === 'file' && !noReset) {
      // "Voltar ao padrão" é uma alternância: o campo continua editável e o botão mantém o foco; clicar
      // de novo desfaz só esta restauração (as outras edições não são perdidas).
      const reset = el('button', 'btn btn-ghost btn-sm', 'Voltar ao padrão');
      reset.type = 'button';
      reset.setAttribute('aria-pressed', 'false');
      let restoring = false; let before = '';
      const setRestoring = (on) => {
        restoring = on;
        reset.setAttribute('aria-pressed', String(on));
        reset.textContent = on ? 'Desfazer restauração' : 'Voltar ao padrão';
        wrap.classList.toggle('is-restoring', on);
      };
      reset.addEventListener('click', () => {
        if (!restoring) {
          before = input.value;
          onInput(null);
          input.value = M.textOf(option.default);
          setRestoring(true);
        } else {
          input.value = before;
          onInput(before);
          setRestoring(false);
        }
      });
      // Digitar no campo enquanto está "será restaurado" vira uma edição normal.
      input.addEventListener('input', () => { if (restoring) setRestoring(false); });
      row.append(reset);
    }
    wrap.append(row, desc, err);
    if (!option.editable) wrap.append(el('p', 'opt-lock', `Somente leitura: ${option.reason}.`));
    wrap.classList.toggle('is-locked', !option.editable);
    return {
      root: wrap,
      input,
      showError(lines) {
        err.hidden = !lines?.length;
        // O rótulo do campo já está acima: a mensagem fica só com o motivo (sem "CHAVE: ").
        const bare = (l) => String(l).replace(new RegExp(`^(settings\\.json: )?${option.key}: `), '');
        setText(err, (lines ?? []).map(bare).join(' '));
        if (lines?.length) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
      },
    };
  }

  // Prévia (o que muda e o que exige reinício). `saved` muda só o título.
  function previewBox(data, restartHint) {
    const box = el('div', 'stack');
    if (!data.changes.length) { box.append(el('p', 'muted', 'Nenhuma alteração: os valores já são esses.')); return box; }
    const ul = el('ul', 'changes');
    for (const c of data.changes) {
      const li = el('li');
      li.append(el('code', '', M.changeLine(c)));
      li.append(document.createTextNode(' '), c.restart ? badge('vale após reiniciar', 'complete', { icon: 'flag' }) : badge('vale na hora', 'seed'));
      ul.append(li);
    }
    box.append(ul);
    if (data.restart.length) box.append(alertBox('complete', 'Reinício necessário', `${data.restart.join(', ')} só passa(m) a valer depois de reiniciar. ${restartHint}`));
    for (const w of data.warnings ?? []) box.append(alertBox('complete', 'Aviso', w));
    if (data.recovery?.length) {
      const rec = alertBox('primary', 'Se algo der errado, como voltar');
      const body = rec.querySelector('div');
      for (const l of data.recovery) body.append(el('div', 'alert-body', l));
      box.append(rec);
    }
    return box;
  }

  // Observa se o Stremio já pediu algo ao addon com esta credencial (src/addon-activity.js).
  // O Stremio não avisa instalação: ler o manifesto só prova que o link foi aberto; só um pedido
  // de catálogo/stream prova que o addon está instalado. Sem sinal, nunca se diz "conectado".
  const WATCH_MS = 2500;
  const RECHECK_MS = 10000;
  const WATCH_MAX = 120; // ~5 min; depois pede para verificar de novo, em vez de insistir
  // Confirmação da instalação: um cartão que troca de título e texto conforme o Stremio avança, e
  // 3 barras de progresso (instalar → manifesto aberto → abrir um filme). A barra atual anima; as
  // feitas ficam cheias. "Manifesto aberto" é o que o servidor viu; "abrir um filme" é o que confirma.
  function connectionWatch(credentialId, onChange = () => {}) {
    const box = el('div', 'conn');
    const now = el('div', 'conn-now');
    const dot = el('span', 'conn-dot'); dot.setAttribute('aria-hidden', 'true');
    const copy = el('div', 'conn-text');
    const heading = el('strong');
    const line = el('small');
    line.setAttribute('role', 'status');
    line.setAttribute('aria-live', 'polite');
    copy.append(heading, line);
    now.append(dot, copy);
    const bars = el('div', 'conn-bars');
    bars.setAttribute('role', 'progressbar');
    bars.setAttribute('aria-label', 'Progresso da instalação no Stremio');
    bars.setAttribute('aria-valuemin', '0');
    bars.setAttribute('aria-valuemax', '3');
    const items = [0, 1, 2].map(() => { const b = el('span', 'conn-bar'); bars.append(b); return b; });
    const again = el('button', 'btn btn-outline btn-sm', 'Verificar de novo'); again.type = 'button'; again.hidden = true;
    box.append(now, bars, again);
    mark(0); // já nasce em andamento; a primeira consulta ajusta (ex.: voltou à tela com o addon já instalado)
    setText(heading, 'Instalar no Stremio');
    setText(line, 'Abra o link ou cole a URL em Addons e clique em Instalar.');
    const hhmm = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    let timer = null;
    let tries = 0;
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    // `at` = quantas barras já estão cheias; a seguinte anima (3 = tudo feito).
    function mark(at) {
      items.forEach((b, i) => { b.dataset.s = i < at ? 'done' : (i === at ? 'active' : 'pending'); });
      dot.dataset.s = at >= 3 ? 'done' : 'active';
      bars.setAttribute('aria-valuenow', String(at));
      box.setAttribute('aria-busy', at < 3 ? 'true' : 'false');
    }
    function show(me) {
      const state = me?.state ?? 'aguardando';
      onChange(state);
      if (state === 'instalado' || state === 'em_uso') {
        mark(3);
        box.dataset.state = 'conectado';
        setText(heading, 'Conexão confirmada');
        setText(line, `Às ${hhmm(me.lastSeenAt)} o Stremio acessou o addon.`);
        return true;
      }
      box.dataset.state = state;
      if (state === 'manifesto_lido') {
        mark(2);
        setText(heading, 'Manifesto aberto');
        setText(line, 'O Stremio já leu o addon. Agora abra qualquer filme, só para confirmar a comunicação.');
      } else {
        mark(0);
        setText(heading, 'Instalar no Stremio');
        setText(line, 'Abra o link ou cole a URL em Addons e clique em Instalar.');
      }
      bars.setAttribute('aria-valuetext', heading.textContent);
      return false;
    }
    // A credencial sumiu do servidor (revogada ou dados refeitos): nada de "Conectado" velho na tela.
    function gone() {
      stop();
      items.forEach((b) => { b.dataset.s = 'paused'; });
      dot.dataset.s = 'paused';
      box.setAttribute('aria-busy', 'false');
      box.dataset.state = 'ausente';
      onChange('ausente'); // o assistente deixa de mostrar "conectado": a credencial já não funciona
      setText(heading, 'Credencial não encontrada');
      setText(line, 'Esta credencial não existe mais neste servidor (foi revogada ou os dados foram refeitos). Crie outra para instalar.');
      again.hidden = true;
    }
    // Depois de conectado, confere devagar só se a credencial ainda existe.
    async function recheck() {
      if (!box.isConnected) { stop(); return; }
      try {
        const out = await app().call('GET', 'addon-connection');
        if (!out.credentials.some((c) => c.id === credentialId)) gone();
      } catch { /* mantém o que já foi confirmado */ }
    }
    async function poll() {
      tries += 1;
      try {
        const out = await app().call('GET', 'addon-connection');
        const me = out.credentials.find((c) => c.id === credentialId);
        if (!me) { gone(); return; }
        if (show(me)) { stop(); again.hidden = true; timer = setInterval(recheck, RECHECK_MS); return; }
      } catch { setText(line, 'Não foi possível consultar a conexão agora; tentando de novo.'); }
      if (!box.isConnected || tries >= WATCH_MAX) {
        stop();
        if (box.isConnected) {
          items.forEach((b) => { if (b.dataset.s === 'active') b.dataset.s = 'paused'; });
          dot.dataset.s = 'paused';
          box.setAttribute('aria-busy', 'false');
          setText(heading, 'Ainda não confirmado');
          setText(line, 'Se o Stremio não abriu, copie a URL e cole em Addons. Remover o addon no Stremio não é detectado aqui.');
          again.hidden = false;
        }
      }
    }
    function start() { stop(); tries = 0; again.hidden = true; poll(); timer = setInterval(poll, WATCH_MS); }
    again.addEventListener('click', start);
    start();
    return box;
  }

  // Emite uma credencial de instalação e mostra a URL do addon (uma vez). Só mostra o formulário
  // quando a URL se aplica (sem mudança de rede esperando reinício). `onConnection(estado)`
  // avisa o chamador (o assistente) do que o addon já viu do Stremio.
  // showActiveList: mostra "Credenciais ativas: …" no próprio cartão (a aba Addons tem lista própria);
  // onCreated(made): avisa quando uma credencial nova é criada (para a lista se atualizar).
  function installCard(getState, defaultName, onConnection = () => {}, footer = null, showActiveList = true, onCreated = () => {}) {
    const c = card();
    c.classList.add('card-stack');
    c.append(cardHead('Instalar o addon no Stremio'));
    const body = el('div', 'stack');
    const out = el('div', 'stack');
    const status = liveRegion();
    const err = errorBox();
    function draw() {
      const st = getState();
      clear(body);
      const addon = st.addon;
      if (!addon.url) { body.append(alertBox('complete', 'URL ainda indisponível', addon.reason)); return; }
      if (!shown) body.append(el('p', 'muted', 'Cada aparelho ou instalação do Stremio recebe a sua própria credencial, que pode ser revogada sozinha.'));
      const f = el('form', 'form');
      const lab = el('label', 'field'); lab.htmlFor = 'cred-name';
      const inp = el('input', 'input'); inp.id = 'cred-name'; inp.maxLength = 40; inp.value = defaultName; inp.required = true; inp.autocomplete = 'off';
      lab.append(el('span', '', 'Nome do aparelho (até 40 caracteres)'), inp);
      const go = el('button', 'btn btn-primary', 'Criar credencial e mostrar a URL'); go.type = 'submit';
      f.append(lab, go);
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); go.disabled = true; err.clear(); setText(status, 'Criando…');
        try {
          const made = await app().call('POST', 'credentials', { name: inp.value });
          setText(status, '');
          st.credentials.push(made.credential);
          remember(made);
          showUrl(made);
          draw();
          onCreated(made);
        } catch (ex) { setText(status, ''); err.show('Não foi possível criar a credencial', [ex.message]); } finally { go.disabled = false; }
      });
      const names = st.credentials.filter((x) => !x.revokedAt);
      const parts = [f];
      if (names.length && showActiveList) parts.push(el('p', 'foot', `Credenciais ativas: ${names.map((x) => x.name).join(', ')}. Para revogar, use o terminal: npm run credenciais -- revogar.`));
      if (shown) {
        // Com a URL já na tela, o foco é instalar: criar outra credencial fica recolhido.
        const more = el('details', 'more');
        more.append(el('summary', '', 'Criar outra credencial (para outro aparelho)'), ...parts);
        body.append(more);
      } else body.append(...parts);
    }
    // Só o verificador da credencial fica no servidor; a URL com o token é guardada apenas nesta
    // aba do navegador (sessionStorage), para reaparecer ao recarregar e sumir ao fechar a aba.
    const KEEP = 'ascstremio.urls';
    function kept() {
      try { return JSON.parse(sessionStorage.getItem(KEEP) ?? '{}') || {}; } catch { return {}; }
    }
    function remember(made) {
      try { sessionStorage.setItem(KEEP, JSON.stringify({ ...kept(), [made.credential.id]: made })); } catch { /* sem armazenamento: a URL só aparece nesta tela */ }
    }
    function restore() {
      // Sem base utilizável (reinício de rede pendente) não há URL a oferecer; com base, a URL é
      // refeita com o endereço ATUAL e o token guardado (a guardada pode ser de outro endereço).
      const base = getState().addon?.url;
      if (!base) return;
      const all = kept();
      const active = getState().credentials.filter((x) => !x.revokedAt && all[x.id]?.token);
      if (!active.length) return;
      const made = all[active[active.length - 1].id];
      showUrl({ ...made, ...M.addonUrls(base, made.token) });
    }
    let shown = false;
    function showUrl(made) {
      shown = true;
      out.classList.add('install-out');
      clear(out);
      const box = el('div', 'secret-box');
      const h = el('p', 'alert-title', 'URL do addon');
      const code = el('code', 'code-wrap', made.manifestUrl);
      code.tabIndex = 0;
      const btns = el('div', 'item-badges');
      const cp = el('button', 'btn btn-outline btn-icon'); cp.type = 'button';
      cp.append(icon('copy'), el('span', 'btn-label', 'Copiar URL'));
      cp.addEventListener('click', () => copy(made.manifestUrl, cp, status));
      // Não há botão para o app do Stremio: ele troca stremio:// por https:// e perde a porta,
      // mas o addon fala HTTP. O Stremio Web mantém o http (só no loopback, onde o navegador
      // aceita) e colar a URL em Addons funciona sempre.
      if (made.manifestUrl.startsWith('http://127.0.0.1')) {
        const web = el('a', 'btn btn-primary', 'Abrir no Stremio Web'); web.href = made.webUrl; web.target = '_blank'; web.rel = 'noopener noreferrer';
        btns.append(web, cp);
      } else {
        cp.className = 'btn btn-primary';
        btns.append(cp);
      }
      box.append(h, code, btns, el('p', 'foot', 'No app do Stremio: Addons, cole a URL no campo de busca de addons. Em outro aparelho, cole a mesma URL lá. Não compartilhe esta URL com outras pessoas.'));
      box.append(connectionWatch(made.credential.id, onConnection));
      out.append(box);
    }
    c.append(err.root, body, out, status);
    if (footer) c.append(footer);
    draw();
    restore();
    if (shown) draw(); // voltou com a URL guardada na aba: recolhe o formulário de novo
    return { root: c, redraw: draw };
  }

  // -------------------------------------------------------------- carregamento
  async function loadState() {
    return app().call('GET', 'settings');
  }

  function loadingCard(text) {
    const c = card();
    c.append(el('p', 'muted', text));
    return c;
  }

  // =============================================================== Configurações
  function configuracoes() {
    const root = el('div', 'page page-wide');
    const head = el('div', 'page-head');
    const hl = el('div');
    hl.append(el('h1', '', 'Configurações'), el('p', 'page-sub', 'Valores em uso e o que muda ao reiniciar.'));
    const wiz = U.link('/assistente', 'Abrir o assistente');
    wiz.className = 'btn btn-outline';
    const searchWrap = el('div', 'search cfg-search');
    const search = el('input', 'input');
    search.type = 'search'; search.placeholder = 'Buscar opção'; search.autocomplete = 'off';
    search.setAttribute('aria-label', 'Buscar opção');
    const clearBtn = el('button', 'search-clear'); clearBtn.type = 'button'; clearBtn.hidden = true;
    clearBtn.setAttribute('aria-label', 'Limpar busca');
    clearBtn.append(icon('x'));
    searchWrap.append(icon('search'), search, clearBtn);
    head.append(hl, searchWrap, wiz);
    const layout = el('div', 'cfg-layout');
    const index = el('nav', 'cfg-index');
    index.setAttribute('aria-label', 'Grupos de opções');
    const host = el('div', 'stack cfg-main');
    layout.append(index, host);
    root.append(head, layout);
    let sections = [];
    let updateBar = () => {};
    let emptyNote = null;

    function indexLink(label, id) {
      const b = el('button', 'cfg-index-link', label); b.type = 'button';
      b.addEventListener('click', () => {
        const t = document.getElementById(id);
        if (!t) return;
        t.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        t.tabIndex = -1; t.focus({ preventScroll: true });
      });
      return b;
    }

    // Busca por nome, chave ou explicação. Grupo sem resultado some; avançadas com resultado abrem.
    function applySearch() {
      const q = search.value.trim().toLowerCase();
      let any = false;
      for (const s of sections) {
        let hits = 0;
        for (const row of s.card.querySelectorAll('.opt')) { const ok = !q || row.dataset.q.includes(q); row.hidden = !ok; if (ok) hits += 1; }
        if (s.adv) {
          const advHit = [...s.adv.querySelectorAll('.opt')].some((r) => !r.hidden);
          s.adv.hidden = !advHit;
          if (q && advHit) s.adv.open = true;
        }
        s.card.hidden = hits === 0;
        if (hits) any = true;
      }
      if (emptyNote) emptyNote.hidden = any || !q;
    }
    search.addEventListener('input', () => { clearBtn.hidden = !search.value; applySearch(); });
    clearBtn.addEventListener('click', () => { search.value = ''; clearBtn.hidden = true; applySearch(); search.focus(); });

    let state = null;
    let drafts = {};
    let errors = { byKey: {}, general: [] };
    let fields = new Map();
    let busy = false;
    const live = liveRegion();
    const errBox = errorBox();
    const previewHost = el('div', 'stack');

    // Vagas de reprodução em uso agora: só leitura (os limites se editam em "Reproduções simultâneas").
    function playbackCard() {
      const p = state.playback;
      if (!p) return null;
      const c = card();
      c.append(cardHead('Reproduções em andamento'));
      const lim = (n) => (n > 0 ? String(n) : 'sem limite');
      c.append(el('p', 'muted', `${p.active} em uso; limite total: ${lim(p.maxSessions)}; por credencial: ${lim(p.maxPerCredential)}.`));
      if (p.credentials?.length) {
        const ul = el('ul', 'foot-list');
        for (const x of p.credentials) ul.append(el('li', '', `${x.name ?? x.credentialId}: ${x.active ?? x.sessions ?? 0}`));
        c.append(ul);
      }
      return c;
    }

    // Destino dos alertas (issue #31): a URL é segredo, só entra aqui (escrita) e nunca volta.
    function alertsCard() {
      const c = card();
      c.append(cardHead('Destino dos alertas por webhook'));
      const info = el('p', 'muted', 'Carregando…');
      info.setAttribute('role', 'status'); info.setAttribute('aria-live', 'polite');
      const msg = el('p', 'muted');
      msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite');
      const url = el('input', 'input'); url.type = 'password'; url.autocomplete = 'off'; url.placeholder = 'URL do destino (segredo; não é exibida depois)';
      url.setAttribute('aria-label', 'URL do destino do webhook');
      const bearer = el('input', 'input'); bearer.type = 'password'; bearer.autocomplete = 'off'; bearer.placeholder = 'Token bearer (opcional)';
      bearer.setAttribute('aria-label', 'Token bearer do webhook (opcional)');
      const row = el('div', 'item-badges');
      const save = el('button', 'btn btn-primary', 'Salvar destino'); save.type = 'button';
      const test = el('button', 'btn btn-outline', 'Enviar mensagem de teste'); test.type = 'button';
      const del = el('button', 'btn btn-ghost', 'Remover destino'); del.type = 'button';
      row.append(save, test, del);
      const labeled = (text, input) => { const l = el('label', 'field'); l.append(el('span', '', text), input); return l; };
      url.placeholder = ''; bearer.placeholder = '';
      c.append(info, labeled('URL do destino (segredo; não é exibida depois)', url), labeled('Token bearer (opcional)', bearer), row, msg);
      const show = (st) => {
        info.textContent = `Alertas ${st.enabled ? 'habilitados' : 'desabilitados'}; destino: ${st.configured ? `configurado (${st.source}${st.host ? `, ${st.host}` : ''})` : 'não configurado'}${st.problem ? ` — ${st.problem.replace(/\.+$/, '')}` : ''}. Último envio: ${st.lastSuccessAt ?? 'nunca'}; último erro: ${st.lastError ?? 'nenhum'}.`;
      };
      // Botões travados durante a chamada (evita envio de teste duplicado); a falha é anunciada como alerta.
      const run = async (route, body, ok) => {
        for (const b of [save, test, del]) b.disabled = true;
        try {
          const r = await app().call('POST', route, body);
          show(r.status ?? r); msg.setAttribute('role', 'status'); msg.textContent = ok; url.value = ''; bearer.value = '';
        } catch (ex) { msg.setAttribute('role', 'alert'); msg.textContent = ex.data?.error ?? ex.message; }
        finally { for (const b of [save, test, del]) b.disabled = false; }
      };
      app().call('GET', 'alerts').then(show, (ex) => { info.textContent = ex.message; });
      save.addEventListener('click', () => run('alerts/webhook', { url: url.value, bearerToken: bearer.value }, 'Destino salvo. Habilite ALERTS_ENABLED acima depois de testar.'));
      test.addEventListener('click', () => run('alerts/test', {}, 'Mensagem de teste entregue.'));
      del.addEventListener('click', () => run('alerts/webhook/clear', {}, 'Destino removido.'));
      return c;
    }

    // O cartão da porta de peers é redesenhado sozinho (sem tocar no formulário nem nas edições).
    let peerHost = null;
    let peerOpen = false;
    let peerAt = 0;
    function drawPeer() {
      if (!peerHost) return;
      clear(peerHost);
      const c = peerPortCard();
      if (c) peerHost.append(c);
    }
    async function refreshPeer() {
      if (!state || !peerHost || Date.now() - peerAt < 15000) return;
      peerAt = Date.now();
      try { const fresh = await loadState(); state.peerPort = fresh.peerPort; drawPeer(); } catch { /* mantém o último valor */ }
    }

    // Porta de peers: somente leitura. Escuta local não é alcance externo; os estados são explícitos.
    function peerPortCard() {
      const p = state.peerPort;
      if (!p) return null;
      const c = card();
      c.classList.add('card-stack');
      const names = { escutando: 'Escutando', sem_entrada: 'Sem entrada observada', entrada_observada: 'Entrada observada', sem_escuta: 'Sem escuta', desconhecido: 'Desconhecido' };
      const head = cardHead('Porta de peers (BitTorrent)');
      head.append(badge(names[p.state] ?? 'Desconhecido', p.state === 'entrada_observada' ? 'complete' : 'neutral'));
      c.append(head);
      c.append(el('p', 'muted', p.summary));
      // O texto longo (firewall, NAT, como conferir) fica recolhido; o resumo acima basta no dia a dia.
      const more = el('details', 'more');
      more.open = peerOpen;
      more.addEventListener('toggle', () => { peerOpen = more.open; });
      more.append(el('summary', '', 'Ver detalhes e como liberar a porta'));
      const e = p.layers.escuta; const n = p.layers.entrada;
      const ul = el('ul', 'foot-list');
      ul.append(el('li', '', `Escuta: configurada ${e.configurada || 'automática'}; em uso ${e.real ?? 'desconhecida'}; ${e.protocolo}.`));
      ul.append(el('li', '', `Publicação (${p.layers.publicacao.modo}): ${p.layers.publicacao.nota}`));
      ul.append(el('li', '', `Firewall/NAT: ${p.layers.firewallNat.estado}. ${p.layers.firewallNat.nota}`));
      ul.append(el('li', '', `Entradas observadas desde ${n.desde ?? '-'}: ${n.observada}; última: ${n.ultima ?? 'nenhuma'}.`));
      more.append(ul);
      for (const t of [...p.notes, ...p.advice]) more.append(el('p', 'foot', t));
      c.append(more);
      return c;
    }

    function bannerPending() {
      if (!state.pending.length) return null;
      return alertBox('complete', 'Reinício pendente', `${state.pending.join(', ')} já está(ão) salvo(s), mas só vale(m) depois de reiniciar. ${state.restartHint}`);
    }

    function draw() {
      clear(host); fields = new Map();
      const alerts = el('div', 'alerts');
      const b = bannerPending(); if (b) alerts.append(b);
      for (const p of state.problems) alerts.append(alertBox('leech', 'Problema na configuração', p));
      for (const w of state.warnings) alerts.append(alertBox('complete', 'Aviso', w));
      if (!state.ok) alerts.append(alertBox('primary', 'Como consertar', 'Valores vindos do ambiente (systemd, Compose) são corrigidos lá. Um settings.json ilegível se isola com o aplicativo parado: npm run configurar -- recuperar.'));
      host.append(alerts);

      const form = el('form', 'stack');
      form.noValidate = true;
      sections = [];
      for (const g of M.groupOptions(state.options, state.groups)) {
        const c = card();
        c.classList.add('cfg-group');
        const idh = `grp-${g.key}`;
        const h = cardHead(g.label); h.querySelector('h2').id = idh;
        c.setAttribute('aria-labelledby', idh);
        c.append(h);
        const list = el('div', 'opts');
        const advList = el('div', 'opts');
        for (const o of g.options) {
          const f = optionField(o, drafts, (v) => { if (v === null || v === M.textOf(o.value)) { if (v === null) drafts[o.key] = null; else delete drafts[o.key]; } else drafts[o.key] = v; previewHost.replaceChildren(); updateBar(); });
          fields.set(o.key, f);
          f.root.dataset.q = `${M.labelOf(o)} ${o.key} ${o.description ?? ''}`.toLowerCase();
          if (errors.byKey[o.key]) f.showError(errors.byKey[o.key]);
          (o.access === 'advanced' ? advList : list).append(f.root);
        }
        c.append(list);
        let adv = null;
        if (advList.children.length) {
          adv = el('details', 'more');
          adv.append(el('summary', '', `Opções avançadas (${advList.children.length})`), advList);
          c.append(adv);
        }
        sections.push({ id: idh, label: g.label, card: c, adv });
        form.append(c);
      }
      emptyNote = el('div', 'empty-note'); emptyNote.hidden = true;
      const clearSearch = el('button', 'btn btn-outline btn-sm', 'Limpar busca'); clearSearch.type = 'button';
      clearSearch.addEventListener('click', () => { search.value = ''; clearBtn.hidden = true; applySearch(); search.focus(); });
      emptyNote.append(el('span', '', 'Nenhuma opção encontrada para essa busca.'), clearSearch);
      form.append(emptyNote);

      const bar = el('div', 'savebar');
      const count = el('span', 'savebar-count');
      const review = el('button', 'btn btn-primary', 'Revisar alterações'); review.type = 'submit';
      const discard = el('button', 'btn btn-ghost', 'Descartar'); discard.type = 'button';
      bar.append(count, discard, review);
      updateBar = () => {
        const n = Object.keys(M.buildChanges(state.options, drafts)).length;
        bar.hidden = n === 0;
        setText(count, `${n} ${n === 1 ? 'alteração não salva' : 'alterações não salvas'}`);
      };
      updateBar();
      form.append(live, bar);
      form.addEventListener('submit', (e) => { e.preventDefault(); doPreview(); });
      discard.addEventListener('click', () => { drafts = {}; errors = { byKey: {}, general: [] }; errBox.clear(); previewHost.replaceChildren(); setText(live, 'Alterações descartadas.'); draw(); });

      clear(index);
      for (const s of sections) index.append(indexLink(s.label, s.id));
      index.append(indexLink('Destino do webhook', 'cfg-alerts'));

      // Estado em andamento (só leitura) primeiro; o formulário em seguida; o webhook no fim. A
      // geração de credenciais do addon não mora mais aqui (fica no assistente por enquanto).
      const status = el('div', 'cfg-status');
      const pb = playbackCard();
      if (pb) status.append(pb);
      peerHost = el('div'); status.append(peerHost); drawPeer();
      const alertsC = alertsCard(); alertsC.id = 'cfg-alerts';
      host.append(errBox.root, previewHost, status, form, alertsC);
      applySearch();
    }

    function fail(ex, title) {
      const problems = ex.data?.problems?.length ? ex.data.problems : [ex.message];
      errors = M.problemsByKey(ex.data?.code === 'conflict' ? [] : problems, state.options);
      for (const [k, lines] of Object.entries(errors.byKey)) {
        fields.get(k)?.showError(lines);
        // Um campo avançado inválido não pode ficar escondido na seção recolhida.
        const hidden = fields.get(k)?.root.closest('details'); if (hidden) hidden.open = true;
      }
      // O resumo nomeia cada campo com problema e leva até ele (foco e rolagem), por teclado ou clique.
      const links = Object.entries(errors.byKey).map(([k, lines]) => {
        const opt = state.options.find((o) => o.key === k);
        const reason = String(lines[0]).replace(new RegExp(`^(settings\\.json: )?${k}: `), '');
        return { text: `${opt ? M.labelOf(opt) : k}: ${reason}`, onClick: () => {
          const f = fields.get(k);
          if (!f) return;
          // Campo escondido pela busca (ou em grupo escondido): limpa o filtro e abre a seção avançada antes de focar.
          if (f.root.hidden || f.root.closest('.cfg-group')?.hidden) { search.value = ''; clearBtn.hidden = true; applySearch(); }
          const adv = f.root.closest('details'); if (adv) adv.open = true;
          f.input.scrollIntoView({ block: 'center' }); f.input.focus();
        } };
      });
      const resumo = links.length || errors.general.length ? [...links, ...errors.general] : problems;
      errBox.show(title, ex.data?.code === 'conflict' ? [ex.message] : resumo);
    }

    async function doPreview() {
      const changes = M.buildChanges(state.options, drafts);
      errBox.clear(); previewHost.replaceChildren();
      for (const f of fields.values()) f.showError(null);
      if (!Object.keys(changes).length) { setText(live, 'Nada foi alterado.'); return; }
      setText(live, 'Conferindo…');
      try {
        const data = await app().call('POST', 'settings/preview', { expectedRevision: state.revision, changes });
        setText(live, '');
        const c = card();
        c.append(cardHead('Confira antes de salvar'), previewBox(data, state.restartHint));
        const row = el('div', 'item-badges');
        const ok = el('button', 'btn btn-primary', 'Salvar'); ok.type = 'button';
        const back = el('button', 'btn btn-ghost', 'Voltar e editar'); back.type = 'button';
        row.append(ok, back);
        c.append(row);
        previewHost.replaceChildren(c);
        ok.focus();
        back.addEventListener('click', () => previewHost.replaceChildren());
        ok.addEventListener('click', () => doSave(changes, ok));
      } catch (ex) { setText(live, ''); fail(ex, ex.data?.code === 'conflict' ? 'A configuração mudou' : 'Não foi possível validar'); if (ex.data?.code === 'conflict') offerReload(); }
    }

    async function doSave(changes, button) {
      if (busy) return; busy = true; button.disabled = true;
      try {
        const out = await app().call('POST', 'settings', { expectedRevision: state.revision, changes });
        state = out.state; drafts = {}; errors = { byKey: {}, general: [] };
        draw();
        const c = card();
        c.append(cardHead('Configuração salva'), previewBox({ ...out, restart: out.restart }, state.restartHint));
        previewHost.replaceChildren(c);
        setText(live, `Salvo (revisão ${out.revision}).`);
      } catch (ex) {
        fail(ex, ex.data?.code === 'conflict' ? 'A configuração mudou' : 'Não foi possível salvar');
        if (ex.data?.code === 'conflict') offerReload(); else previewHost.replaceChildren();
      } finally { busy = false; }
    }

    // Conflito: o servidor mudou. Recarrega os valores e mantém o que o operador digitou.
    function offerReload() {
      const b = el('button', 'btn btn-outline', 'Recarregar valores e manter o que digitei'); b.type = 'button';
      b.addEventListener('click', async () => {
        try { state = await loadState(); errors = { byKey: {}, general: [] }; draw(); setText(live, 'Valores recarregados; suas edições foram mantidas. Revise de novo.'); } catch (ex) { errBox.show('Não foi possível recarregar', [ex.message]); }
      });
      previewHost.replaceChildren(b);
    }

    (async () => {
      host.append(loadingCard('Carregando configurações…'));
      try { state = await loadState(); draw(); } catch (ex) {
        clear(host);
        // Sem dados não há o que buscar nem índice: largura total, mensagem e o caminho de volta.
        searchWrap.hidden = true; index.hidden = true; layout.classList.add('cfg-layout-solo');
        host.append(alertBox('leech', 'Não foi possível abrir as configurações', ex.status === 401 ? 'A sessão do ASC não está confirmada. Entre de novo; as configurações continuam salvas.' : ex.message));
        if (ex.status === 401) {
          const again = U.link('/entrar', 'Entrar de novo');
          again.className = 'btn btn-primary';
          host.append(again);
        }
      }
    })();
    return { root, update() {} };
  }

  // ================================================================== Assistente
  function assistente() {
    const root = el('div', 'page page-narrow');
    const head = el('div', 'page-head');
    const hl = el('div');
    hl.append(el('h1', '', 'Assistente de configuração'), el('p', 'page-sub', 'Poucos passos: como você vai usar, seed e disco, e a instalação no Stremio. Dá para mudar tudo depois em Configurações.'));
    head.append(hl);
    const stepper = el('ol', 'stepper');
    const body = el('div', 'stack');
    root.append(head, stepper, body);

    let state = null;
    let mode = 'local';
    let drafts = {};
    let step = 'modo';
    let lastPreview = null;
    let connection = 'aguardando';
    let finish = null;
    const errBox = errorBox();
    const live = liveRegion();
    const LABELS = { modo: 'Uso', endereco: 'Endereço', seed: 'Seed e disco', revisar: 'Revisar', instalar: 'Instalar' };
    const opt = (key) => state.options.find((o) => o.key === key);
    // O modo efetivo (state.mode) vale: BRIDGE_ALLOW_LAN=1 liga a LAN com ASCSTREMIO_MODE ainda no padrão.
    const draftMode = () => (drafts.ASCSTREMIO_MODE ?? state.mode);

    function drawStepper() {
      clear(stepper);
      const steps = order();
      steps.forEach((s, i) => {
        const li = el('li', '', `${i + 1}. ${LABELS[s]}`);
        li.dataset.s = i < steps.indexOf(step) ? 'done' : (s === step ? 'current' : 'todo');
        if (s === step) li.setAttribute('aria-current', 'step');
        stepper.append(li);
      });
    }

    // Rodapé do cartão: ações secundárias à esquerda, a principal à direita.
    function nav(buttons) {
      const row = el('div', 'actions');
      row.append(...buttons);
      return row;
    }
    function button(text, cls, fn) {
      const b = el('button', `btn ${cls}`, text); b.type = 'button'; b.addEventListener('click', fn); return b;
    }
    function go(next) {
      step = next; errBox.clear(); setText(live, ''); draw();
      document.getElementById('view')?.focus({ preventScroll: false });
    }
    // A etapa de revisão só aparece quando há o que gravar (ou enquanto o operador está nela).
    const reviewNeeded = () => step === 'revisar' || Object.keys(M.buildChanges(state.options, drafts)).length > 0;
    function order() { return M.wizardSteps(mode, reviewNeeded()); }
    const nextOf = () => order()[order().indexOf(step) + 1];
    const prevOf = () => order()[order().indexOf(step) - 1];

    async function dismiss() {
      try { await app().call('POST', 'wizard/dismiss', {}); } catch { /* adiar é só conveniência */ }
      app().nav('/');
    }

    function draw() {
      mode = draftMode();
      drawStepper(); clear(body);
      body.append(errBox.root);
      if (step === 'instalar') {
        // Um cartão só: o da instalação já traz Voltar e Concluir no fim.
        body.append(installCard(() => state, M.copyName(mode, state.hostname), (s) => { connection = s; syncFinish(); }, installFooter()).root);
        body.append(live);
        return;
      }
      const c = card();
      c.classList.add('card-stack');
      if (step === 'modo') drawMode(c);
      else if (step === 'endereco') drawAddress(c);
      else if (step === 'seed') drawSeed(c);
      else drawReview(c);
      body.append(c);
      body.append(live);
    }

    function choice(name, value, title, text, checked, disabled) {
      uid += 1;
      const id = `${name}-${value}-${uid}`;
      const l = el('label', 'choice'); l.htmlFor = id;
      const r = el('input'); r.type = 'radio'; r.name = name; r.id = id; r.value = value; r.checked = checked; r.disabled = disabled;
      const t = el('span'); t.append(el('strong', '', title), el('small', '', text));
      l.append(r, t);
      return { l, r };
    }

    function drawMode(c) {
      const o = opt('ASCSTREMIO_MODE');
      c.append(cardHead('Como você vai usar'));
      const fs = el('fieldset', 'choices');
      fs.append(el('legend', 'sr-only', 'Modo de uso'));
      const a = choice('mode', 'local', 'Neste computador', 'O Stremio roda aqui. É o mais simples e o mais seguro: addon e ponte só aceitam este computador.', mode === 'local', !o.editable);
      const b = choice('mode', 'lan', 'Também nos meus outros aparelhos', 'Para a sua TV e o seu celular na mesma rede. Addon e ponte passam a escutar na rede local, sem criptografia: use só em rede doméstica confiável. O painel continua só aqui.', mode === 'lan', !o.editable);
      for (const x of [a, b]) x.r.addEventListener('change', () => { if (x.r.checked) { drafts.ASCSTREMIO_MODE = x.r.value; mode = x.r.value; drawStepper(); } });
      fs.append(a.l, b.l);
      c.append(fs);
      if (!o.editable) c.append(alertBox('complete', 'Modo definido fora do painel', `${o.reason}. Valor atual: ${mode}.`));
      c.append(nav([button('Pular por enquanto', 'btn-ghost', dismiss), button('Próximo', 'btn-primary', () => go(nextOf()))]));
    }

    // Vazio = escolha automática: se havia endereço salvo no arquivo, a alteração é REMOVÊ-LO
    // (null); só apagar o rascunho manteria o IP antigo sem o operador perceber.
    function setAddress(value) {
      const o = opt('LAN_ADVERTISE_HOST');
      const v = String(value).trim();
      if (v) drafts.LAN_ADVERTISE_HOST = v;
      else if (o.source === 'file') drafts.LAN_ADVERTISE_HOST = null;
      else delete drafts.LAN_ADVERTISE_HOST;
    }

    function drawAddress(c) {
      c.append(cardHead('Endereço deste computador na rede'));
      c.append(el('p', 'muted', 'É o endereço que a TV e o celular vão usar para chegar aqui. Se o roteador trocar o IP, os aparelhos deixam de achar o addon: reserve o IP no roteador ou use um nome da sua rede.'));
      const o = opt('LAN_ADVERTISE_HOST');
      const net = state.network;
      if (net.note) c.append(alertBox('complete', 'Contêiner', net.note));
      if (net.list.length) {
        const f = el('div', 'field');
        const lab = el('label', '', 'Endereços deste computador'); lab.htmlFor = 'lan-pick';
        const sel = el('select', 'input'); sel.id = 'lan-pick';
        const none = el('option', '', 'Escolher automaticamente (aviso se houver mais de um)'); none.value = '';
        sel.append(none);
        for (const x of net.list) { const op = el('option', '', `${x.address} (${x.interface}): ${x.reason}`); op.value = x.address; sel.append(op); }
        sel.value = drafts.LAN_ADVERTISE_HOST === null ? '' : (drafts.LAN_ADVERTISE_HOST ?? M.textOf(o.value));
        sel.disabled = !o.editable;
        sel.addEventListener('change', () => { setAddress(sel.value); manual.input.value = sel.value; });
        f.append(lab, sel);
        c.append(f);
      }
      const manual = optionField(o, drafts, (v) => setAddress(v ?? ''), { noReset: true, short: true });
      c.append(manual.root);
      const info = el('ul', 'foot-list');
      for (const t of [
        'Ficam acessíveis na rede: o addon e a ponte de vídeo, só com a credencial de cada aparelho. O painel (porta 7020) continua somente neste computador.',
        'O tráfego é HTTP sem criptografia: o token da credencial passa em claro na rede local. Use só em casa.',
        'A senha do ASC não é usada pelos aparelhos e não dá acesso administrativo ao aplicativo. Cada aparelho recebe uma credencial própria, revogável.',
        'Checar que o endereço é deste computador não prova que a TV o alcança (roteador, firewall, Wi-Fi isolado): teste no aparelho.',
      ]) info.append(el('li', '', t));
      c.append(info);
      c.append(nav([button('Voltar', 'btn-ghost', () => go(prevOf())), button('Próximo', 'btn-primary', () => go(nextOf()))]));
    }

    function drawSeed(c) {
      c.append(cardHead('Seed, disco e filtro de releases'));
      c.append(el('p', 'muted', mode === 'lan' ? 'Confira os padrões. O seed e a conta ficam neste host.' : 'Os valores seguros já estão preenchidos: pode seguir sem mexer em nada.'));
      for (const key of ['AFTER_SEED', 'DISK_RESERVE_GIB', 'DISK_RESERVE_PERCENT', 'ASC_ONLY_FREELEECH']) {
        const o = opt(key);
        const f = optionField(o, drafts, (v) => {
          if (v === null || v === M.textOf(o.value)) delete drafts[key]; else drafts[key] = v;
        }, { noReset: true, short: true });
        c.append(f.root);
      }
      // Sem alterações, vai direto para a instalação; com alterações, passa pela conferência.
      c.append(nav([button('Voltar', 'btn-ghost', () => go(prevOf())), button('Próximo', 'btn-primary', () => go(nextOf()))]));
    }

    async function preview() {
      const changes = M.buildChanges(state.options, drafts);
      if (!Object.keys(changes).length) return { changes: [], restart: [], warnings: [], recovery: null, empty: true };
      return app().call('POST', 'settings/preview', { expectedRevision: state.revision, changes });
    }

    function drawReview(c) {
      c.append(cardHead('Revisar e salvar'));
      const area = el('div', 'stack');
      c.append(area);
      const row = nav([]);
      c.append(row);
      (async () => {
        try {
          lastPreview = await preview();
          area.append(lastPreview.empty ? el('p', 'muted', 'Nada a gravar: os valores seguros atuais serão mantidos.') : previewBox(lastPreview, state.restartHint));
          row.append(button('Voltar', 'btn-ghost', () => go(prevOf())));
          const ok = button(lastPreview.empty ? 'Continuar' : 'Salvar e continuar', 'btn-primary', async () => {
            ok.disabled = true;
            try {
              if (!lastPreview.empty) {
                const out = await app().call('POST', 'settings', { expectedRevision: state.revision, changes: M.buildChanges(state.options, drafts) });
                state = out.state; drafts = {};
              }
              go('instalar');
            } catch (ex) {
              const lines = ex.data?.problems?.length ? ex.data.problems : [ex.message];
              errBox.show(ex.data?.code === 'conflict' ? 'A configuração mudou' : 'Não foi possível salvar', lines);
              if (ex.data?.code === 'conflict') {
                // Mantém o que foi digitado e recarrega a revisão.
                try { state = await loadState(); } catch { /* o aviso acima já orienta */ }
              }
              ok.disabled = false;
            }
          });
          row.append(ok);
        } catch (ex) {
          errBox.show(ex.data?.code === 'conflict' ? 'A configuração mudou' : 'Valores não aceitos', ex.data?.problems?.length ? ex.data.problems : [ex.message]);
          row.append(button('Voltar e corrigir', 'btn-primary', () => go(order().includes('endereco') ? 'endereco' : 'seed')));
          if (ex.data?.code === 'conflict') { try { state = await loadState(); } catch { /* ignora */ } }
        }
      })();
    }

    // Rodapé do cartão de instalação. Concluir leva ao Início (a visão geral), onde a pessoa vai
    // acompanhar o dia a dia; Configurações continua a um clique no menu.
    function installFooter() {
      finish = button('Concluir sem confirmar a instalação', 'btn-outline', async () => {
        try { await app().call('POST', 'wizard/complete', {}); app().nav('/'); } catch (ex) { errBox.show('Não foi possível registrar a conclusão', [ex.message]); }
      });
      syncFinish();
      return nav([button('Voltar', 'btn-ghost', () => go(prevOf())), finish]);
    }

    // O botão final destaca quando o Stremio já falou com o addon; concluir sem isso segue
    // permitido (outro aparelho, instalação depois), mas o texto deixa claro que não foi confirmado.
    function syncFinish() {
      if (!finish) return;
      const ok = connection === 'instalado' || connection === 'em_uso';
      // Sem URL (reinício de rede pendente) não há o que instalar agora: o texto diz que fica para depois.
      const later = !state.addon?.url;
      finish.textContent = ok ? 'Concluir assistente' : (later ? 'Concluir e instalar depois' : 'Concluir sem confirmar a instalação');
      finish.className = `btn ${ok ? 'btn-primary' : 'btn-outline'}`;
    }

    (async () => {
      body.append(loadingCard('Carregando…'));
      try { state = await loadState(); mode = state.mode; draw(); } catch (ex) {
        clear(body);
        body.append(alertBox('leech', 'Não foi possível abrir o assistente', ex.status === 401 ? 'A sessão do ASC não está confirmada. Entre de novo; o assistente continua disponível.' : ex.message));
      }
    })();
    return { root, update() {} };
  }

  // Aba "Addons" da página Conta: gerar um addon novo (credencial + URL + confirmação no Stremio) e
  // ver os já gerados. Revogar ainda é pelo terminal (o servidor não tem essa ação no painel).
  function addonsPanel() {
    const root = el('div', 'stack');
    let state = null;
    const SITUACAO = {
      aguardando: 'Sem atividade desde que o serviço iniciou',
      manifesto_lido: 'Manifesto lido',
      instalado: 'Instalado',
      em_uso: 'Em uso',
    };

    function listCard() {
      const c = card();
      c.append(cardHead('Addons gerados'));
      const active = state.credentials.filter((x) => !x.revokedAt);
      if (!active.length) { c.append(el('p', 'muted', 'Nenhum addon gerado ainda.')); return c; }
      const ul = el('ul', 'cred-list');
      const status = new Map();
      for (const x of active) {
        const li = el('li');
        const meta = el('div', 'cred-meta');
        meta.append(el('strong', '', x.name), el('small', '', `Criado em ${fmtDate(new Date(x.createdAt).toISOString())}`));
        const chip = el('span', 'cred-status', '…');
        status.set(x.id, chip);
        li.append(meta, chip);
        ul.append(li);
      }
      c.append(ul, el('p', 'foot', 'A URL de um addon só aparece quando ele é criado. Para revogar um addon, use o terminal: npm run credenciais -- revogar.'));
      // A situação vem da atividade vista pelo serviço (zera quando ele reinicia).
      app().call('GET', 'addon-connection').then((r) => {
        for (const cr of r.credentials) {
          const chip = status.get(cr.id);
          if (!chip) continue;
          const base = SITUACAO[cr.state] ?? SITUACAO.aguardando;
          setText(chip, cr.lastSeenAt ? `${base} · visto ${ago(cr.lastSeenAt)}` : base);
          chip.dataset.s = cr.state;
        }
      }, () => { for (const chip of status.values()) setText(chip, ''); });
      return c;
    }

    function draw() {
      clear(root);
      let list = listCard();
      const refreshList = () => { const next = listCard(); list.replaceWith(next); list = next; };
      // Quando a conexão de um addon muda (ex.: o Stremio confirmou), a lista relê a situação.
      let seen = '';
      const onConnection = (s) => { if (s !== seen) { seen = s; if (s !== 'aguardando') refreshList(); } };
      root.append(installCard(() => state, M.copyName(state.mode, state.hostname), onConnection, null, false, refreshList).root, list);
    }

    root.append(loadingCard('Carregando…'));
    loadState().then((s) => { state = s; draw(); }, (ex) => {
      clear(root);
      root.append(alertBox('leech', 'Não foi possível abrir os addons', ex.status === 401 ? 'A sessão do ASC não está confirmada. Entre de novo.' : ex.message));
    });
    return root;
  }

  window.Views = Object.assign(window.Views ?? {}, { configuracoes, assistente, addonsPanel });
})();
