// Assistente depois do primeiro login e página permanente de Configurações (issue #23).
// A lista de opções, os tipos, os limites e as regras vêm do servidor (esquema único em
// src/settings.js); aqui só há apresentação. Nada usa innerHTML: textos entram por textContent.
(() => {
  const U = window.UI;
  const M = window.SettingsModel;
  const { el, icon, clear, setText, badge, card, cardHead, alertBox } = U;
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
        for (const l of lines ?? []) body.append(el('div', 'alert-body', l));
        const a = alertBox('leech', title);
        a.querySelector('div').append(...body.childNodes);
        box.append(a);
        box.focus({ preventScroll: false });
      },
      clear() { clear(box); },
    };
  }

  async function copy(text, status) {
    try { await navigator.clipboard.writeText(text); setText(status, 'Copiado.'); } catch { setText(status, 'Não foi possível copiar sozinho: selecione o texto e copie.'); }
  }

  // Campo de uma opção do esquema. onInput(texto|null). Segue o que o servidor diz: bloqueio,
  // origem e descrição vêm de `option`; limites só viram atributos do input (o servidor valida).
  function optionField(option, drafts, onInput, { noReset = false } = {}) {
    uid += 1;
    const id = `opt-${option.key}-${uid}`;
    const wrap = el('div', 'opt');
    const kind = M.kindOf(option);
    const label = el('label', 'opt-label');
    label.htmlFor = id;
    label.append(el('span', 'opt-key', option.key));
    wrap.append(label);

    const meta = el('div', 'item-badges');
    meta.append(badge(M.originText(option), option.source === 'env' ? 'complete' : 'neutral', { line: true }));
    if (option.access === 'advanced') meta.append(badge('avançada', 'neutral', { line: true }));
    if (option.restart) meta.append(badge('vale após reiniciar', 'neutral', { line: true }));
    else meta.append(badge('vale na hora', 'seed', { line: true }));
    if (option.pending) meta.append(badge('reinício pendente', 'complete', { icon: 'flag' }));
    wrap.append(meta);

    const descId = `${id}-d`;
    const errId = `${id}-e`;
    const desc = el('p', 'foot', option.description);
    desc.id = descId;
    const err = el('p', 'opt-error'); err.id = errId; err.hidden = true;

    const current = Object.prototype.hasOwnProperty.call(drafts, option.key) && drafts[option.key] !== null ? drafts[option.key] : M.textOf(option.value);
    let input;
    if (option.secret) {
      input = el('input', 'input'); input.value = option.defined ? '(definido)' : '(não definido)';
    } else if (kind === 'enum' || kind === 'bool') {
      input = el('select', 'input');
      const values = kind === 'bool' ? ['false', 'true'] : option.values;
      for (const v of values) { const o = el('option', '', v); o.value = v; input.append(o); }
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
      const reset = el('button', 'btn btn-ghost btn-sm', 'Voltar ao padrão');
      reset.type = 'button';
      reset.addEventListener('click', () => {
        onInput(null);
        input.value = M.textOf(option.default);
        input.disabled = true; reset.disabled = true; reset.textContent = 'Será restaurado ao salvar';
      });
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
        setText(err, (lines ?? []).join(' '));
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

  // Emite uma credencial de instalação e mostra a URL do addon (uma vez). Só mostra o formulário
  // quando a URL se aplica (sem mudança de rede esperando reinício).
  function installCard(getState, defaultName) {
    const c = card();
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
      body.append(el('p', 'muted', 'Cada aparelho ou instalação do Stremio recebe a sua credencial, que pode ser revogada sozinha. A senha do ASC não é usada aqui e não dá acesso administrativo ao aplicativo.'));
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
          setText(status, 'Credencial criada. Copie a URL agora: ela não será mostrada de novo.');
          st.credentials.push(made.credential);
          showUrl(made);
          draw();
        } catch (ex) { setText(status, ''); err.show('Não foi possível criar a credencial', [ex.message]); } finally { go.disabled = false; }
      });
      body.append(f);
      const names = st.credentials.filter((x) => !x.revokedAt);
      if (names.length) body.append(el('p', 'foot', `Credenciais ativas: ${names.map((x) => x.name).join(', ')}. Revogar: npm run credenciais -- revogar.`));
    }
    function showUrl(made) {
      clear(out);
      const box = el('div', 'secret-box');
      const h = el('p', 'alert-title', 'URL do addon (aparece uma vez)');
      const code = el('code', 'code-wrap', made.manifestUrl);
      code.tabIndex = 0;
      const btns = el('div', 'item-badges');
      const cp = el('button', 'btn btn-outline', 'Copiar URL'); cp.type = 'button';
      const open = el('a', 'btn btn-outline', 'Abrir no Stremio'); open.href = made.stremioUrl;
      cp.addEventListener('click', () => copy(made.manifestUrl, status));
      btns.append(cp, open);
      box.append(h, code, btns, el('p', 'foot', 'No Stremio: Addons, cole a URL no campo de busca de addons (ou use o botão acima neste computador). Em outro aparelho, cole a mesma URL lá. Não compartilhe esta URL com outras pessoas.'));
      out.append(box);
    }
    c.append(err.root, body, out, status);
    draw();
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
    const root = el('div', 'page');
    const head = el('div', 'page-head');
    const hl = el('div');
    hl.append(el('h1', '', 'Configurações'), el('p', 'page-sub', 'As mesmas opções do terminal (npm run configurar): valor em uso, origem e o que exige reinício'));
    const wiz = U.link('/assistente', 'Abrir o assistente');
    wiz.className = 'btn btn-outline';
    head.append(hl, wiz);
    const host = el('div', 'stack');
    root.append(head, host);

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
      const msg = el('p', 'muted');
      const url = el('input', 'input'); url.type = 'password'; url.autocomplete = 'off'; url.placeholder = 'URL do destino (segredo; não é exibida depois)';
      const bearer = el('input', 'input'); bearer.type = 'password'; bearer.autocomplete = 'off'; bearer.placeholder = 'Token bearer (opcional)';
      const row = el('div', 'item-badges');
      const save = el('button', 'btn btn-primary', 'Salvar destino'); save.type = 'button';
      const test = el('button', 'btn btn-outline', 'Enviar mensagem de teste'); test.type = 'button';
      const del = el('button', 'btn btn-ghost', 'Remover destino'); del.type = 'button';
      row.append(save, test, del);
      c.append(info, url, bearer, row, msg);
      const show = (st) => {
        info.textContent = `Alertas ${st.enabled ? 'habilitados' : 'desabilitados'}; destino: ${st.configured ? `configurado (${st.source}${st.host ? `, ${st.host}` : ''})` : 'não configurado'}${st.problem ? ` — ${st.problem}` : ''}. Último envio: ${st.lastSuccessAt ?? 'nunca'}; último erro: ${st.lastError ?? 'nenhum'}.`;
      };
      const run = async (route, body, ok) => {
        try {
          const r = await app().call('POST', route, body);
          show(r.status ?? r); msg.textContent = ok; url.value = ''; bearer.value = '';
        } catch (ex) { msg.textContent = ex.data?.error ?? ex.message; }
      };
      app().call('GET', 'alerts').then(show, (ex) => { info.textContent = ex.message; });
      save.addEventListener('click', () => run('alerts/webhook', { url: url.value, bearerToken: bearer.value }, 'Destino salvo. Habilite ALERTS_ENABLED acima depois de testar.'));
      test.addEventListener('click', () => run('alerts/test', {}, 'Mensagem de teste entregue.'));
      del.addEventListener('click', () => run('alerts/webhook/clear', {}, 'Destino removido.'));
      return c;
    }

    // O cartão da porta de peers é redesenhado sozinho (sem tocar no formulário nem nas edições).
    let peerHost = null;
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
      const names = { escutando: 'Escutando', sem_entrada: 'Sem entrada observada', entrada_observada: 'Entrada observada', sem_escuta: 'Sem escuta', desconhecido: 'Desconhecido' };
      const head = cardHead('Porta de peers (BitTorrent)');
      head.append(badge(names[p.state] ?? 'Desconhecido', p.state === 'entrada_observada' ? 'complete' : 'neutral'));
      c.append(head);
      c.append(el('p', 'muted', p.summary));
      const e = p.layers.escuta; const n = p.layers.entrada;
      const ul = el('ul', 'foot-list');
      ul.append(el('li', '', `Escuta: configurada ${e.configurada || 'automática'}; em uso ${e.real ?? 'desconhecida'}; ${e.protocolo}.`));
      ul.append(el('li', '', `Publicação (${p.layers.publicacao.modo}): ${p.layers.publicacao.nota}`));
      ul.append(el('li', '', `Firewall/NAT: ${p.layers.firewallNat.estado}. ${p.layers.firewallNat.nota}`));
      ul.append(el('li', '', `Entradas observadas desde ${n.desde ?? '-'}: ${n.observada}; última: ${n.ultima ?? 'nenhuma'}.`));
      c.append(ul);
      for (const t of [...p.notes, ...p.advice]) c.append(el('p', 'foot', t));
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
      for (const g of M.groupOptions(state.options, state.groups)) {
        const c = card();
        const idh = `grp-${g.key}`;
        const h = cardHead(g.label); h.querySelector('h2').id = idh;
        c.setAttribute('aria-labelledby', idh);
        c.append(h);
        const list = el('div', 'opts');
        for (const o of g.options) {
          const f = optionField(o, drafts, (v) => { if (v === null || v === M.textOf(o.value)) { if (v === null) drafts[o.key] = null; else delete drafts[o.key]; } else drafts[o.key] = v; previewHost.replaceChildren(); });
          fields.set(o.key, f);
          if (errors.byKey[o.key]) f.showError(errors.byKey[o.key]);
          list.append(f.root);
        }
        c.append(list);
        form.append(c);
      }
      const bar = el('div', 'savebar');
      const review = el('button', 'btn btn-primary', 'Revisar alterações'); review.type = 'submit';
      const discard = el('button', 'btn btn-ghost', 'Descartar alterações'); discard.type = 'button';
      bar.append(review, discard, live);
      form.append(bar);
      form.addEventListener('submit', (e) => { e.preventDefault(); doPreview(); });
      discard.addEventListener('click', () => { drafts = {}; errors = { byKey: {}, general: [] }; errBox.clear(); previewHost.replaceChildren(); setText(live, 'Alterações descartadas.'); draw(); });
      const pb = playbackCard();
      if (pb) host.append(pb);
      peerHost = el('div'); host.append(peerHost); drawPeer();
      host.append(alertsCard());
      host.append(errBox.root, previewHost, form, installCard(() => state, M.copyName(state.mode)).root);
    }

    function fail(ex, title) {
      const problems = ex.data?.problems?.length ? ex.data.problems : [ex.message];
      errors = M.problemsByKey(ex.data?.code === 'conflict' ? [] : problems, state.options);
      for (const [k, lines] of Object.entries(errors.byKey)) fields.get(k)?.showError(lines);
      // Problemas ligados a um campo ficam no campo; o resumo cobre o resto (e orienta a corrigir).
      const resumo = errors.general.length ? errors.general : (Object.keys(errors.byKey).length ? ['Corrija os campos marcados abaixo.'] : problems);
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
        host.append(alertBox('leech', 'Não foi possível abrir as configurações', ex.status === 401 ? 'A sessão do ASC não está confirmada. Entre de novo; as configurações continuam salvas.' : ex.message));
      }
    })();
    return { root, update() {} };
  }

  // ================================================================== Assistente
  function assistente() {
    const root = el('div', 'page');
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
    let saved = false;
    let lastPreview = null;
    const errBox = errorBox();
    const live = liveRegion();
    const LABELS = { modo: 'Uso', endereco: 'Endereço', seed: 'Seed e disco', revisar: 'Revisar', instalar: 'Instalar' };
    const opt = (key) => state.options.find((o) => o.key === key);
    // O modo efetivo (state.mode) vale: BRIDGE_ALLOW_LAN=1 liga a LAN com ASCSTREMIO_MODE ainda no padrão.
    const draftMode = () => (drafts.ASCSTREMIO_MODE ?? state.mode);

    function drawStepper() {
      clear(stepper);
      const steps = M.wizardSteps(mode);
      steps.forEach((s, i) => {
        const li = el('li', '', `${i + 1}. ${LABELS[s]}`);
        if (s === step) li.setAttribute('aria-current', 'step');
        stepper.append(li);
      });
    }

    function nav(buttons) {
      const row = el('div', 'item-badges');
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
    function order() { return M.wizardSteps(mode); }
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
      const c = card();
      if (step === 'modo') drawMode(c);
      else if (step === 'endereco') drawAddress(c);
      else if (step === 'seed') drawSeed(c);
      else if (step === 'revisar') drawReview(c);
      else drawInstall(c);
      body.append(c);
      if (step === 'instalar') body.append(installCard(() => state, M.copyName(mode)).root);
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
      const a = choice('mode', 'local', 'Neste computador', 'Padrão e mais simples: o Stremio roda aqui. Addon e ponte só aceitam este computador (127.0.0.1). Valores seguros já vêm prontos.', mode === 'local', !o.editable);
      const b = choice('mode', 'lan', 'Host para os meus aparelhos na rede', 'Este computador atende só os SEUS outros aparelhos (TV, celular) na rede local, com a sua conta e o seu seed. Addon e ponte passam a escutar na rede; o painel continua só aqui. Sem TLS: use só em rede doméstica confiável.', mode === 'lan', !o.editable);
      for (const x of [a, b]) x.r.addEventListener('change', () => { if (x.r.checked) { drafts.ASCSTREMIO_MODE = x.r.value; mode = x.r.value; drawStepper(); } });
      fs.append(a.l, b.l);
      c.append(fs);
      if (!o.editable) c.append(alertBox('complete', 'Modo definido fora do painel', `${o.reason}. Valor atual: ${mode}.`));
      c.append(el('p', 'foot', 'Não é um serviço compartilhado: a conta, a passkey e o seed são seus (regra 2.2 do ASC). Nunca exponha à internet.'));
      c.append(nav([button('Continuar', 'btn-primary', () => go(nextOf())), button('Pular por enquanto', 'btn-ghost', dismiss)]));
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
      const manual = optionField(o, drafts, (v) => setAddress(v ?? ''), { noReset: true });
      c.append(manual.root);
      const info = el('ul', 'foot-list');
      for (const t of [
        'Ficam acessíveis na rede: o addon e a ponte de vídeo, só com a credencial de cada aparelho. O painel (porta 7020) continua somente neste computador.',
        'O tráfego é HTTP sem criptografia: o token da credencial passa em claro na rede local. Use só em casa.',
        'A senha do ASC não é usada pelos aparelhos e não dá acesso administrativo ao aplicativo. Cada aparelho recebe uma credencial própria, revogável.',
        'Checar que o endereço é deste computador não prova que a TV o alcança (roteador, firewall, Wi-Fi isolado): teste no aparelho.',
      ]) info.append(el('li', '', t));
      c.append(info);
      c.append(nav([button('Voltar', 'btn-ghost', () => go(prevOf())), button('Continuar', 'btn-primary', () => go(nextOf()))]));
    }

    function drawSeed(c) {
      c.append(cardHead('Seed, disco e filtro de releases'));
      c.append(el('p', 'muted', mode === 'lan' ? 'Confira os padrões. O seed e a conta ficam neste host.' : 'Os valores seguros já estão preenchidos: pode continuar sem mexer em nada.'));
      const effect = alertBox('primary', 'O que esta escolha faz', M.AFTER_SEED_EFFECT[draft('AFTER_SEED')]);
      const effectText = effect.querySelector('.alert-body');
      for (const key of ['AFTER_SEED', 'DISK_RESERVE_GIB', 'DISK_RESERVE_PERCENT', 'ASC_ONLY_FREELEECH']) {
        const o = opt(key);
        const f = optionField(o, drafts, (v) => {
          if (v === null || v === M.textOf(o.value)) delete drafts[key]; else drafts[key] = v;
          if (key === 'AFTER_SEED') setText(effectText, M.AFTER_SEED_EFFECT[draft('AFTER_SEED')] ?? '');
        }, { noReset: true });
        c.append(f.root);
        if (key === 'AFTER_SEED') c.append(effect);
      }
      c.append(el('p', 'foot', 'O tracker manda: 72 h de seed ou ratio 1.0 (regra 13.1). Nenhum arquivo é apagado antes de o tracker confirmar.'));
      c.append(nav([button('Voltar', 'btn-ghost', () => go(prevOf())), button('Revisar', 'btn-primary', () => { go('revisar'); })]));
    }
    const draft = (key) => (drafts[key] ?? M.textOf(opt(key).value));

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
                state = out.state; drafts = {}; saved = true;
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

    function drawInstall(c) {
      c.append(cardHead('Instalar no Stremio'));
      if (state.pending.length) {
        c.append(alertBox('complete', 'Reinicie para aplicar', `${state.pending.join(', ')} só vale(m) depois de reiniciar. ${state.restartHint}`));
        c.append(el('p', 'muted', mode === 'lan'
          ? 'Depois de reiniciar, abra Configurações e crie a credencial de cada aparelho: a URL do addon depende do endereço novo.'
          : 'Depois de reiniciar, abra Configurações para criar a credencial e obter a URL do addon.'));
      } else {
        c.append(el('p', 'muted', mode === 'lan'
          ? 'Crie uma credencial para cada aparelho (TV, celular) e instale a URL no Stremio dele.'
          : 'Crie a credencial deste computador e instale a URL no Stremio.'));
      }
      c.append(alertBox('primary', 'Quase pronto', saved ? 'A configuração foi salva.' : 'Nada precisou mudar.'));
      c.append(nav([
        button('Voltar', 'btn-ghost', () => go('revisar')),
        button('Concluir assistente', 'btn-primary', async () => {
          try { await app().call('POST', 'wizard/complete', {}); app().nav('/configuracoes'); } catch (ex) { errBox.show('Não foi possível registrar a conclusão', [ex.message]); }
        }),
      ]));
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

  window.Views = Object.assign(window.Views ?? {}, { configuracoes, assistente });
})();
