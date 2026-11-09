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

  // Etapas do assistente conforme o modo escolhido (a de endereço só existe na LAN).
  function wizardSteps(mode) {
    return mode === 'lan'
      ? ['modo', 'endereco', 'seed', 'revisar', 'instalar']
      : ['modo', 'seed', 'revisar', 'instalar'];
  }

  function copyName(mode) { return mode === 'lan' ? 'Stremio da sala' : 'Stremio neste computador'; }

  module_exports({ textOf, kindOf, display, buildChanges, groupOptions, originText, problemsByKey, changeLine, shouldOfferWizard, wizardSteps, copyName, AFTER_SEED_EFFECT });

  function module_exports(api) {
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else window.SettingsModel = api;
  }
})();
