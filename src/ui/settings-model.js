// Lógica pura das telas de configuração (assistente e página Configurações), sem DOM, para
// ser testada no Node. NÃO valida valores: tipos, limites e regras vêm do servidor (esquema
// único em src/settings.js); aqui só se compara o que foi digitado com o valor efetivo, se
// agrupa por assunto e se escreve o texto das prévias.
(() => {
  const AFTER_SEED_EFFECT = {
    delete: 'Depois que o tracker confirmar o seed, os arquivos do filme são APAGADOS deste computador para liberar disco (o .torrent fica). É o padrão.',
    stop: 'Depois que o tracker confirmar o seed, o seed é encerrado e os arquivos ficam no disco.',
    keep: 'O seed continua depois de cumprido e os arquivos ficam no disco (usa mais disco e rede, ajuda o tracker).',
  };

  // Texto do campo (o que aparece no input) para o valor efetivo vindo do servidor.
  function textOf(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
  }

  function kindOf(option) {
    if (option.type === 'enum') return 'enum';
    if (option.type === 'bool') return 'bool';
    if (option.type === 'int' || option.type === 'number') return 'number';
    return 'text';
  }

  // Valor para mostrar em lista/prévia. Segredo: só "definido".
  function display(option, value) {
    if (option.secret) return option.defined ? '(definido)' : '(não definido)';
    const t = textOf(value);
    if (t === '') return '(vazio)';
    return option.unit ? `${t} ${option.unit}` : t;
  }

  // drafts: { CHAVE: texto | null }; null = voltar ao padrão (remover do arquivo).
  // Só entra o que o operador de fato mudou e que pode ser editado.
  function buildChanges(options, drafts) {
    const changes = {};
    for (const o of options) {
      if (!o.editable || !Object.prototype.hasOwnProperty.call(drafts, o.key)) continue;
      const draft = drafts[o.key];
      if (draft === null) { if (o.source === 'file') changes[o.key] = null; continue; }
      // Campo opcional esvaziado = voltar ao padrão (remover do arquivo), nunca gravar texto vazio.
      if (String(draft).trim() === '' && textOf(o.default) === '') { if (o.source === 'file') changes[o.key] = null; continue; }
      if (String(draft).trim() === textOf(o.value)) continue;
      changes[o.key] = String(draft).trim();
    }
    return changes;
  }

  // Agrupa na ordem do esquema (GROUPS vem do servidor).
  function groupOptions(options, groups) {
    const order = Object.keys(groups);
    const by = new Map(order.map((k) => [k, { key: k, label: groups[k], options: [] }]));
    for (const o of options) (by.get(o.group) ?? by.set(o.group, { key: o.group, label: o.groupLabel ?? o.group, options: [] }).get(o.group)).options.push(o);
    return [...by.values()].filter((g) => g.options.length);
  }

  function originText(o) {
    if (o.secret) return o.defined ? 'definido no ambiente' : 'não definido';
    if (o.source === 'env') return o.overridden ? 'ambiente (sobrepõe o arquivo)' : 'ambiente';
    return o.origin ?? o.source;
  }

  // Associa problemas do servidor ("CHAVE: motivo" ou "settings.json: CHAVE: ...") ao campo.
  function problemsByKey(problems, options) {
    const keys = options.map((o) => o.key);
    const byKey = {};
    const general = [];
    for (const p of problems ?? []) {
      const key = keys.find((k) => new RegExp(`(^|[\\s:])${k}(?![A-Z0-9_])`).test(p));
      if (key) (byKey[key] ??= []).push(p); else general.push(p);
    }
    return { byKey, general };
  }

  function changeLine(c) {
    const from = textOf(c.from) === '' ? '(vazio)' : textOf(c.from);
    const to = textOf(c.to) === '' ? '(vazio)' : textOf(c.to);
    const u = c.unit ? ` ${c.unit}` : '';
    return `${c.key}: ${from}${u} → ${to}${u}`;
  }

  // O assistente é oferecido uma vez: depois de concluído ou adiado não insiste.
  function shouldOfferWizard(state) {
    return Boolean(state) && !state.wizard.completed && !state.wizard.dismissed;
  }

  // Etapas do assistente conforme o modo escolhido (a de endereço só existe na LAN). A de
  // revisão só existe quando há algo a gravar: "revisar" sem mudança não diz nada ao operador.
  function wizardSteps(mode, review = true) {
    const steps = mode === 'lan'
      ? ['modo', 'endereco', 'seed', 'revisar', 'instalar']
      : ['modo', 'seed', 'revisar', 'instalar'];
    return review ? steps : steps.filter((s) => s !== 'revisar');
  }

  // Valida o que o assistente guardou no sessionStorage antes de reaproveitar. O dado vem do
  // navegador (pode estar velho, corrompido ou ter sido editado), então nada é confiado: passo
  // inexistente volta ao início, e só entra rascunho de chave editável que ainda existe, com
  // valor texto ou null (voltar ao padrão). Nunca lança; sem dado válido devolve o estado inicial.
  function restoreWizard(raw, options, steps) {
    const vazio = { step: steps[0] ?? 'modo', drafts: {} };
    let data;
    try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return vazio; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return vazio;
    const step = steps.includes(data.step) ? data.step : vazio.step;
    const saved = data.drafts && typeof data.drafts === 'object' && !Array.isArray(data.drafts) ? data.drafts : {};
    const drafts = {};
    for (const o of options ?? []) {
      if (!o.editable || !Object.prototype.hasOwnProperty.call(saved, o.key)) continue;
      const v = saved[o.key];
      if (v === null || typeof v === 'string') drafts[o.key] = v;
    }
    return { step, drafts };
  }

  // Nome padrão do aparelho: no mesmo computador, o hostname dele (limite de 40 da credencial).
  function copyName(mode, hostname) {
    if (mode === 'lan') return 'Stremio da sala';
    const name = String(hostname ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 40).trim();
    return name || 'Stremio neste computador';
  }

  // Rótulos em linguagem humana das opções do assistente. A chave continua visível, pequena,
  // para quem usa o terminal; o texto do servidor (description) segue valendo nas Configurações.
  const FRIENDLY = {
    AFTER_SEED: {
      title: 'Depois de cumprir o seed',
      hint: 'O que fazer com o filme quando o tracker confirmar o seed.',
      values: { delete: 'Apagar os arquivos (padrão)', stop: 'Encerrar o seed e guardar os arquivos', keep: 'Continuar semeando', manual: 'Eu decido no painel' },
    },
    DISK_RESERVE_GIB: { title: 'Espaço livre a preservar', hint: 'Parte do disco que nenhum download novo pode usar. Deixe 0 para desligar.' },
    DISK_RESERVE_PERCENT: { title: 'Reserva em % do disco', hint: 'Outra forma de reservar espaço: vale a que guardar mais. Deixe 0 para usar só os GiB.' },
    ASC_ONLY_FREELEECH: {
      title: 'Quais releases mostrar',
      hint: 'Freeleech não gasta ratio.',
      values: { true: 'Só freeleech (recomendado)', false: 'Todos (os demais gastam ratio)' },
    },
    ASCSTREMIO_MODE: { title: 'Modo de uso' },
    LAN_ADVERTISE_HOST: { title: 'Endereço deste computador na rede' },
  };
  // URLs do addon a partir da base ATUAL e do token guardado na aba. A base muda com o modo LAN, o
  // endereço anunciado e a porta; guardar a URL pronta deixaria um endereço velho na tela.
  function addonUrls(base, token) {
    const manifestUrl = `${String(base).replace(/\/+$/, '')}/${token}/manifest.json`;
    return { manifestUrl, webUrl: `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}` };
  }

  const labelOf = (option) => FRIENDLY[option.key]?.title ?? option.key;
  const hintOf = (option) => FRIENDLY[option.key]?.hint ?? null;
  const valueLabel = (option, value) => FRIENDLY[option.key]?.values?.[value] ?? value;

  module_exports({ textOf, kindOf, display, buildChanges, groupOptions, originText, problemsByKey, changeLine, shouldOfferWizard, wizardSteps, restoreWizard, copyName, addonUrls, labelOf, hintOf, valueLabel, AFTER_SEED_EFFECT });

  function module_exports(api) {
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else window.SettingsModel = api;
  }
})();
