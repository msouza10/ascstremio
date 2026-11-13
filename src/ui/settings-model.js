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
    PORT: { title: 'Porta do addon Stremio' },
    BRIDGE_PORT: { title: 'Porta da ponte de vídeo' },
    TORRENT_PORT: { title: 'Porta de entrada de peers', hint: '0 deixa o sistema escolher uma porta livre.' },
    STATUS_CATALOG: {
      title: 'Catálogo de status no Stremio',
      values: { on: 'Mostrar (padrão)', off: 'Ocultar o catálogo e seus alertas' },
    },
    BACKGROUND_COMPLETE: {
      title: 'Conclusão automática em segundo plano',
      values: { off: 'Desligada (padrão)', auto: 'Concluir sozinho os freeleech elegíveis parados' },
    },
    SEED_REQUIRED_HOURS: { title: 'Meta local de seed', hint: 'Não altera a obrigação imposta pelo tracker.' },
    KEEP_AWAKE: {
      title: 'Evitar suspensão durante o seed',
      values: { auto: 'Bloquear a suspensão enquanto há seed pendente (padrão)', off: 'Não bloquear' },
    },
    BRIDGE_UPLOAD_LIMIT: { title: 'Limite de upload', hint: '-1 = sem limite. 0 desliga o envio.' },
    BRIDGE_STREAM_UPLOAD_LIMIT: { title: 'Teto de upload durante a reprodução', hint: '-1 = não reduz o upload ao assistir.' },
    RESUME_CONCURRENCY: { title: 'Seeds retomados ao mesmo tempo na partida' },
    // Não é automática: no modo "preview" nada é removido sozinho; a limpeza é manual e confirmada.
    RETENTION_MODE: {
      title: 'Limpeza da biblioteca por orçamento',
      hint: 'Nada é removido sozinho: com a prévia ligada, a limpeza é manual e confirmada (npm run retencao).',
      values: { off: 'Desligada (padrão)', preview: 'Mostrar prévia e permitir execução manual' },
    },
    RETENTION_BUDGET_GIB: { title: 'Orçamento de disco dos filmes' },
    RETENTION_MAX_TITLES: { title: 'Máximo de títulos com dados no disco', hint: '0 = sem limite.' },
    RETENTION_MIN_AGE_DAYS: { title: 'Dias sem uso antes de poder limpar' },
    PLAYBACK_MAX_SESSIONS: { title: 'Máximo de reproduções simultâneas', hint: '0 = sem limite.' },
    PLAYBACK_MAX_PER_CREDENTIAL: { title: 'Reproduções simultâneas por credencial', hint: '0 = sem limite.' },
    PLAYBACK_SESSION_GRACE_SECONDS: { title: 'Tempo para liberar a vaga de uma reprodução parada' },
    ALERTS_ENABLED: { title: 'Alertas por webhook', values: { true: 'Ligados', false: 'Desligados (padrão)' } },
    LOG_LEVEL: { title: 'Nível de detalhe dos logs' },
    LOG_RETENTION_DAYS: { title: 'Dias de retenção dos logs' },
    // Opções avançadas e de ambiente: o título só diz o que a opção é, sem prometer efeito além da descrição.
    DATA_DIR: { title: 'Pasta de dados do programa', hint: 'Só pelo ambiente. Mudar não move os dados existentes.' },
    ASC_TORRENT_DIR: { title: 'Pasta da biblioteca de .torrent', hint: 'Mudar não move os arquivos existentes.' },
    BRIDGE_STORE: { title: 'Pasta dos vídeos recebidos', hint: 'Mudar não move os arquivos nem libera o seed dos que ficaram.' },
    PASSKEY: { title: 'Passkey do tracker (em memória)', hint: 'Segredo: nunca é gravada nem exibida.' },
    PASSKEY_FILE: { title: 'Arquivo de passkey do leitor', hint: 'Opção do leitor de passkey; o programa principal usa DATA_DIR/passkey.txt.' },
    ANNOUNCE_BASE: { title: 'Base de announce do tracker', hint: 'Segredo, só pelo ambiente. Vazio usa a do ASC.' },
    CONFIG_PORT: { title: 'Porta do painel' },
    BRIDGE_ALLOW_LAN: { title: 'Acesso pela rede local (opção antiga)', hint: 'Valor 1 equivale a ASCSTREMIO_MODE=lan. Prefira o modo de uso.' },
    ASCSTREMIO_CONTAINER: { title: 'Execução em contêiner', hint: 'Definida pela imagem do contêiner.' },
    BRIDGE_PUBLIC_URL: { title: 'URL pública da ponte', hint: 'Vazio = calculada pela interface. Não muda a interface de escuta.' },
    ADDON_PUBLIC_URL: { title: 'URL pública do addon', hint: 'Base do addon e das imagens do catálogo de status. Vazio = calculada pela interface.' },
    ALLOWED_HOSTS: { title: 'Nomes DNS adicionais aceitos', hint: 'Aceitos no cabeçalho Host pelo addon e pela ponte, separados por vírgula.' },
    LAN_INTERFACE: { title: 'Interface de rede para o modo LAN', hint: 'Usada para tirar o endereço anunciado quando há várias interfaces.' },
    CONFIG_ALLOW_LAN: {
      title: 'Administração do painel pela rede local',
      hint: 'Desligada por padrão; só no modo lan e com senha de administração. Ativação só pelo terminal.',
      values: { true: 'Habilitada', false: 'Desligada (padrão)' },
    },
    CONFIG_PUBLIC_URL: { title: 'Endereço https do painel atrás de proxy', hint: 'Origem exata do painel no seu proxy reverso, sem caminho.' },
    CONFIG_ADMIN_HTTP_CLEAR: {
      title: 'Aceitar senha de administração em HTTP sem criptografia',
      hint: 'Quem vê o tráfego da rede lê a senha e a sessão.',
      values: { true: 'Aceito o risco', false: 'Não aceito (padrão)' },
    },
    CONFIG_BIND_ADDRESS: { title: 'Endereço IPv4 de escuta do painel na rede local', hint: 'Nunca 0.0.0.0.' },
    CONFIG_SESSION_IDLE_MINUTES: { title: 'Minutos de inatividade que encerram a sessão de administração' },
    CONFIG_SESSION_MAX_HOURS: { title: 'Horas de duração máxima da sessão de administração', hint: 'Vale mesmo com uso contínuo.' },
    DEMO_MODE: {
      title: 'Fonte de demonstração',
      hint: 'Adiciona uma fonte de demonstração externa.',
      values: { true: 'Adicionar a fonte de demonstração', false: 'Não adicionar (padrão)' },
    },
    BACKGROUND_IDLE_MINUTES: { title: 'Minutos de inatividade antes da conclusão automática' },
    BRIDGE_UPLOAD_RESTORE_SECONDS: { title: 'Segundos sem reprodução antes de voltar ao teto normal de upload', hint: 'Só vale com o teto de upload durante a reprodução.' },
    ALERT_WEBHOOK_URL: { title: 'URL do webhook de alertas', hint: 'Segredo: só pelo ambiente; nunca é exibida.' },
    ALERT_WEBHOOK_URL_FILE: { title: 'Arquivo com a URL do webhook', hint: 'Arquivo protegido (0600) com a URL completa. Só pelo ambiente.' },
    ALERT_WEBHOOK_TOKEN: { title: 'Token do webhook de alertas', hint: 'Segredo, opcional: enviado no cabeçalho Authorization.' },
    ALERT_WEBHOOK_FORMAT: {
      title: 'Formato da mensagem do webhook',
      values: { json: 'JSON com o evento estruturado (padrão)', text: 'Texto simples só com a mensagem (ex.: tópico do ntfy)' },
    },
    ALERT_WEBHOOK_ALLOWED_HOSTS: { title: 'Hosts aprovados para o webhook', hint: 'Hosts exatos, sem curinga. Obrigatório ao habilitar os alertas.' },
    ALERT_WEBHOOK_ALLOW_PRIVATE: {
      title: 'Permitir webhook em rede privada',
      hint: 'Inclui http:// na rede privada. Loopback, link-local e metadata continuam proibidos.',
      values: { true: 'Permitir', false: 'Não permitir (padrão)' },
    },
    ALERT_HNR_WITHIN_HOURS: { title: 'Horas restantes de seed que disparam alerta', hint: 'Alerta quando o prazo confirmado pelo tracker está a este tempo ou menos.' },
    ALERT_DISK_FREE_GIB: { title: 'Alerta de pouco espaço livre (GiB)', hint: '0 desliga. Distinto da reserva de espaço para novos downloads.' },
    ALERT_TRACKER_FAILURE_MINUTES: { title: 'Minutos de falha do tracker antes de alertar', hint: 'Contados desde a primeira falha explícita sem recuperação.' },
    ALERT_NO_PEERS_MINUTES: { title: 'Minutos sem peers nem progresso antes de alertar', hint: 'Vale para download em conclusão; seed ocioso não conta.' },
    ALERT_COOLDOWN_MINUTES: { title: 'Minutos entre alertas repetidos', hint: 'Intervalo mínimo para repetir o mesmo alerta enquanto a condição continua aberta.' },
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

  // Normaliza para a busca: sem acento e sem diferenciar maiúsculas ("Reprodução" casa "reproducao").
  const fold = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // Casa a consulta com o título humano, a chave ou a descrição. Cada palavra digitada precisa
  // aparecer em algum deles; consulta vazia casa tudo.
  function matchesQuery(option, query) {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = fold(`${labelOf(option)} ${option.key} ${FRIENDLY[option.key]?.hint ?? ''} ${option.description ?? ''}`);
    return words.every((w) => hay.includes(w));
  }

  const filterOptions = (options, query) => options.filter((o) => matchesQuery(o, query));

  module_exports({ matchesQuery, filterOptions, textOf, kindOf, display, buildChanges, groupOptions, originText, problemsByKey, changeLine, shouldOfferWizard, wizardSteps, restoreWizard, copyName, addonUrls, labelOf, hintOf, valueLabel, AFTER_SEED_EFFECT });

  function module_exports(api) {
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else window.SettingsModel = api;
  }
})();
