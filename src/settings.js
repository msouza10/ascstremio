// Contrato central de configuração (issue #19): um esquema único, validado do mesmo
// jeito por inicialização, painel e terminal.
//
// Precedência (da mais forte para a mais fraca):
//   1. ambiente (systemd, Compose, shell): sempre vence e nunca é sobrescrito;
//   2. arquivo persistente DATA_DIR/settings.json (escrito por update());
//   3. padrão do esquema.
//
// Quem só usa variáveis de ambiente não precisa mudar nada: sem arquivo, o resultado é
// idêntico ao de antes. O arquivo nunca contém segredos (passkey, cookies, senhas, tokens):
// chaves marcadas `secret` só existem no ambiente/arquivos próprios e jamais saem daqui em claro.
//
// Fail-closed: valor inválido, arquivo corrompido ou de versão desconhecida e combinação
// insegura (ex.: LAN em contêiner sem URLs públicas) recusam a partida em vez de cair em
// padrões que mudariam o comportamento (AFTER_SEED=delete apaga arquivos, por exemplo).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const network = require('./network');

const FILE_NAME = 'settings.json';
const FILE_VERSION = 1;
const MAX_FILE_BYTES = 256 * 1024;
const LOCK_STALE_MS = 30_000;
const KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

// Erro com lista de problemas legíveis (em português) e um código estável para a UI/CLI:
// 'invalid' | 'conflict' | 'locked' | 'unknown' | 'secret' | 'corrupt' | 'newer' | 'busy' | 'io'.
class SettingsError extends Error {
  constructor(code, problems) {
    const list = Array.isArray(problems) ? problems : [String(problems)];
    super(list.join(' '));
    this.name = 'SettingsError';
    this.code = code;
    this.problems = list;
  }
}

const GROUPS = {
  modo: 'Modo de uso',
  conta: 'Conta e catálogo',
  caminhos: 'Credenciais e caminhos',
  rede: 'Rede e Stremio',
  administracao: 'Administração pela LAN',
  seed: 'Seed, energia e transferência',
  disco: 'Disco',
  reproducao: 'Reproduções simultâneas',
  alertas: 'Alertas por webhook',
  logs: 'Logs',
};

// Cada entrada: key (nome da variável de ambiente), type, default, group, description,
// access ('editable' | 'advanced' | 'readonly'), restart (true = só vale após reiniciar),
// e opcionais: unit, min, max, values (enum), secret, risky, envOnly (nunca vai ao arquivo).
// `default` pode ser função de ({ dataDir }).
const SCHEMA = Object.freeze([
  {
    key: 'ASCSTREMIO_MODE', type: 'enum', values: ['local', 'lan'], default: 'local', group: 'modo',
    access: 'editable', restart: true,
    description: 'local: tudo neste computador (padrão, escuta só em loopback). lan: este computador é o host pessoal dos seus outros aparelhos; não abre o painel, não vira serviço compartilhado.',
  },
  {
    key: 'ASC_ONLY_FREELEECH', type: 'bool', default: true, group: 'conta', access: 'editable', restart: false,
    description: 'true (padrão) lista e baixa só releases freeleech: o download deles não conta no ratio. false mostra todos os releases e o download dos que não são freeleech gasta ratio. Vale na hora, sem novo login.',
  },
  {
    key: 'DATA_DIR', type: 'path', default: null, group: 'caminhos', access: 'readonly', envOnly: true, restart: true, risky: true,
    description: 'Pasta de dados (sessão, passkey, cofre, logs). Só pelo ambiente: é onde este arquivo mora. Mudar não move os dados.',
  },
  {
    key: 'ASC_TORRENT_DIR', type: 'path', default: ({ dataDir }) => path.join(dataDir, 'torrents'), group: 'caminhos',
    access: 'advanced', restart: true, risky: true,
    description: 'Biblioteca local de .torrent. Mudar não move os arquivos existentes.',
  },
  {
    key: 'BRIDGE_STORE', type: 'path', default: ({ dataDir }) => path.join(dataDir, 'cache'), group: 'caminhos',
    access: 'advanced', restart: true, risky: true,
    description: 'Onde ficam vídeos e dados recebidos. Mudar não move os arquivos nem libera o seed dos que ficaram.',
  },
  {
    key: 'PASSKEY', type: 'string', default: null, group: 'caminhos', access: 'readonly', envOnly: true, secret: true, restart: true,
    description: 'Passkey do tracker em memória (precede passkey.txt). Segredo: nunca é gravada nem exibida.',
  },
  {
    key: 'PASSKEY_FILE', type: 'path', default: null, group: 'caminhos', access: 'readonly', envOnly: true, restart: true,
    description: 'Opção do leitor de passkey; o programa principal usa DATA_DIR/passkey.txt.',
  },
  {
    key: 'ANNOUNCE_BASE', type: 'string', default: null, group: 'caminhos', access: 'readonly', envOnly: true, secret: true, restart: true,
    description: 'Base de announce usada para injetar a passkey em memória. Vazio = a do ASC. Só pelo ambiente: uma URL de tracker pode carregar credencial e não vai ao arquivo.',
  },
  {
    key: 'PORT', type: 'int', min: 1, max: 65535, default: 7000, group: 'rede', access: 'editable', restart: true,
    description: 'Porta do addon Stremio.',
  },
  {
    key: 'BRIDGE_PORT', type: 'int', min: 1, max: 65535, default: 7010, group: 'rede', access: 'editable', restart: true,
    description: 'Porta da ponte de vídeo.',
  },
  {
    key: 'CONFIG_PORT', type: 'int', min: 1, max: 65535, default: 7020, group: 'rede', access: 'advanced', restart: true,
    description: 'Porta do painel (sempre acessado por http://127.0.0.1:<porta>).',
  },
  {
    key: 'TORRENT_PORT', type: 'int', min: 0, max: 65535, default: 0, group: 'rede', access: 'advanced', restart: true,
    description: 'Porta de entrada de peers. 0 = o sistema escolhe uma livre.',
  },
  {
    key: 'BRIDGE_ALLOW_LAN', type: 'string', default: null, group: 'rede', access: 'readonly', envOnly: true, restart: true,
    description: 'Variável antiga: 1 equivale a ASCSTREMIO_MODE=lan. Preferir ASCSTREMIO_MODE.',
  },
  {
    key: 'ASCSTREMIO_CONTAINER', type: 'string', default: null, group: 'rede', access: 'readonly', envOnly: true, restart: true,
    description: 'Definido pela imagem do contêiner (1): escuta em 0.0.0.0 dentro dele; a porta é publicada só no 127.0.0.1 do host.',
  },
  {
    key: 'BRIDGE_PUBLIC_URL', type: 'url', default: null, group: 'rede', access: 'advanced', restart: true,
    description: 'URL da ponte nas fontes (proxy, DNS local). Vazio = calculada pela interface. Não muda a interface de escuta.',
  },
  {
    key: 'ADDON_PUBLIC_URL', type: 'url', default: null, group: 'rede', access: 'advanced', restart: true,
    description: 'Base do addon/imagens do catálogo de status. Vazio = calculada pela interface.',
  },
  {
    key: 'ALLOWED_HOSTS', type: 'hostlist', default: '', group: 'rede', access: 'advanced', restart: true,
    description: 'Nomes DNS adicionais aceitos no cabeçalho Host por addon e ponte (anti DNS rebinding), separados por vírgula.',
  },
  {
    key: 'LAN_ADVERTISE_HOST', type: 'advhost', default: null, group: 'rede', access: 'advanced', restart: true,
    description: 'Endereço (IPv4 ou nome DNS estável; IPv6 ainda não, pois a escuta é só IPv4, sem esquema, porta ou caminho) que os outros aparelhos usam para chegar aqui, nas URLs de instalação e de vídeo. Só vale no modo LAN. Não muda a escuta nem o Host aceito além deste próprio nome.',
  },
  {
    key: 'LAN_INTERFACE', type: 'ifname', default: null, group: 'rede', access: 'advanced', restart: true,
    description: 'Interface de rede (ex.: enp3s0, Wi-Fi) de onde tirar o endereço anunciado no modo LAN quando há várias. LAN_ADVERTISE_HOST, se definida, prevalece; as URLs públicas explícitas também.',
  },
  {
    key: 'CONFIG_ALLOW_LAN', type: 'bool', default: false, group: 'administracao', access: 'advanced', restart: true, risky: true,
    description: 'true habilita a administração do painel pela LAN (opcional, desligada por padrão, só no modo lan e com senha de administração definida). Só pelo terminal: npm run admin-painel -- ativar. Sem as pré-condições, a administração remota continua desligada e o painel local segue funcionando.',
  },
  {
    key: 'CONFIG_PUBLIC_URL', type: 'url', default: null, group: 'administracao', access: 'advanced', restart: true, risky: true,
    description: 'Origem https exata do painel atrás do seu proxy reverso (ex.: https://painel.casa.lan), sem caminho. Com ela o painel escuta só em 127.0.0.1 (o proxy roda neste computador) e o cookie de sessão é Secure. Vazio = HTTP em claro na LAN, que exige CONFIG_ADMIN_HTTP_CLEAR=true.',
  },
  {
    key: 'CONFIG_ADMIN_HTTP_CLEAR', type: 'bool', default: false, group: 'administracao', access: 'advanced', restart: true, risky: true,
    description: 'Confirma que você aceita a senha de administração trafegar em HTTP sem criptografia na sua rede local (sem CONFIG_PUBLIC_URL https). Quem vê o tráfego da rede lê a senha e a sessão.',
  },
  {
    key: 'CONFIG_BIND_ADDRESS', type: 'advhost', default: null, group: 'administracao', access: 'advanced', restart: true, risky: true,
    description: 'IPv4 deste computador onde o painel escuta para a LAN. Vazio = o IPv4 de LAN_ADVERTISE_HOST. Obrigatório se LAN_ADVERTISE_HOST for um nome DNS. Nunca 0.0.0.0.',
  },
  {
    key: 'CONFIG_SESSION_IDLE_MINUTES', type: 'int', min: 5, max: 120, default: 30, unit: 'min', group: 'administracao', access: 'advanced', restart: true,
    description: 'Inatividade que encerra a sessão de administração.',
  },
  {
    key: 'CONFIG_SESSION_MAX_HOURS', type: 'int', min: 1, max: 24, default: 12, unit: 'h', group: 'administracao', access: 'advanced', restart: true,
    description: 'Duração absoluta da sessão de administração, mesmo com uso contínuo.',
  },
  {
    key: 'STATUS_CATALOG', type: 'enum', values: ['on', 'off'], default: 'on', group: 'rede', access: 'editable', restart: true,
    description: 'off remove o catálogo "ASC — status" e seus alertas do Stremio.',
  },
  {
    key: 'DEMO_MODE', type: 'bool', default: false, group: 'rede', access: 'advanced', restart: true,
    description: 'true adiciona uma fonte de demonstração externa.',
  },
  {
    key: 'AFTER_SEED', type: 'enum', values: ['delete', 'stop', 'keep', 'manual'], default: 'delete', group: 'seed', access: 'editable', restart: true,
    description: 'Depois de o tracker confirmar o seed: delete apaga os arquivos, stop encerra e preserva, keep continua semeando, manual mantém o seed até você decidir no painel.',
  },
  {
    key: 'BACKGROUND_COMPLETE', type: 'enum', values: ['off', 'auto'], default: 'off', group: 'seed', access: 'editable', restart: true,
    description: 'auto conclui sozinho apenas freeleech elegíveis que ficaram parados.',
  },
  {
    key: 'BACKGROUND_IDLE_MINUTES', type: 'number', min: 1, default: 10, unit: 'min', group: 'seed', access: 'advanced', restart: true,
    description: 'Inatividade antes da conclusão automática.',
  },
  {
    key: 'SEED_REQUIRED_HOURS', type: 'number', min: 0, default: 72, unit: 'h', group: 'seed', access: 'advanced', restart: true,
    description: 'Meta local de seed; não altera a obrigação imposta pelo tracker.',
  },
  {
    key: 'KEEP_AWAKE', type: 'enum', values: ['auto', 'off'], default: 'auto', group: 'seed', access: 'advanced', restart: true,
    description: 'off desliga o bloqueio de suspensão enquanto há seed pendente.',
  },
  {
    key: 'BRIDGE_UPLOAD_LIMIT', type: 'int', min: -1, default: -1, unit: 'B/s', group: 'seed', access: 'advanced', restart: true,
    description: 'Limite de upload em bytes por segundo. -1 = sem limite. 0 desliga o envio e é respeitado como está (afeta o ratio).',
  },
  {
    key: 'BRIDGE_STREAM_UPLOAD_LIMIT', type: 'int', min: 16384, special: [-1], default: -1, unit: 'B/s', group: 'seed', access: 'advanced', restart: true,
    description: 'Teto de upload enquanto há reprodução ativa; vale o menor entre este e BRIDGE_UPLOAD_LIMIT. -1 = não reduz (padrão). Mínimo 16384 (16 KiB/s); com seed pendente o piso efetivo é 65536 (64 KiB/s). Nunca zera o envio.',
  },
  {
    key: 'BRIDGE_UPLOAD_RESTORE_SECONDS', type: 'int', min: 0, max: 300, default: 15, unit: 's', group: 'seed', access: 'advanced', restart: true,
    description: 'Espera sem reprodução (depois da carência da sessão) antes de voltar ao teto normal de upload. Só vale com BRIDGE_STREAM_UPLOAD_LIMIT.',
  },
  {
    key: 'RESUME_CONCURRENCY', type: 'int', min: 1, max: 8, default: 1, unit: 'torrents', group: 'seed', access: 'advanced', restart: true,
    description: 'Quantos seeds pendentes são abertos (e verificados em disco) ao mesmo tempo na partida. 1 = um por vez, na ordem de risco de seed (padrão). Mais paralelismo só ajuda se o disco aguenta: meça pelo tempo de retomada no painel antes de subir.',
  },
  {
    key: 'DISK_RESERVE_GIB', type: 'number', min: 0, max: 1048576, default: 2, unit: 'GiB', group: 'disco', access: 'editable', restart: true,
    description: 'Reserva de espaço livre no volume de BRIDGE_STORE que nenhum novo download pode consumir (streaming, conclusão e retomada). 0 desliga a parte absoluta. Vale a maior entre esta e DISK_RESERVE_PERCENT.',
  },
  {
    key: 'DISK_RESERVE_PERCENT', type: 'number', min: 0, max: 90, default: 0, unit: '%', group: 'disco', access: 'editable', restart: true,
    description: 'Reserva em percentual do tamanho do volume de BRIDGE_STORE. 0 desliga. Vale a maior entre esta e DISK_RESERVE_GIB; sem conseguir medir o volume, novos downloads são recusados.',
  },
  {
    key: 'RETENTION_MODE', type: 'enum', values: ['off', 'preview'], default: 'off', group: 'disco', access: 'editable', restart: true,
    description: 'Retenção por orçamento (issue #27). off = desligada (padrão). preview = habilita a prévia e a execução MANUAL e confirmada (npm run retencao); nada é removido sozinho. Só candidatos que o tracker confirmou cumpridos, sem uso e parados há RETENTION_MIN_AGE_DAYS.',
  },
  {
    key: 'RETENTION_BUDGET_GIB', type: 'number', min: 0, max: 1048576, default: 0, unit: 'GiB', group: 'disco', access: 'editable', restart: true,
    description: 'Orçamento de disco dos filmes da biblioteca. Acima dele, a prévia lista os mais antigos por último uso que já cumpriram o seed. 0 = sem orçamento de espaço.',
  },
  {
    key: 'RETENTION_MAX_TITLES', type: 'int', min: 0, max: 100000, default: 0, unit: 'títulos', group: 'disco', access: 'editable', restart: true,
    description: 'Máximo de títulos da biblioteca com dados em disco. 0 = sem limite. Vale em conjunto com RETENTION_BUDGET_GIB; sem nenhum dos dois a retenção não seleciona nada.',
  },
  {
    key: 'RETENTION_MIN_AGE_DAYS', type: 'int', min: 1, max: 3650, default: 30, unit: 'dias', group: 'disco', access: 'editable', restart: true,
    description: 'Um título só é candidato depois de tantos dias sem uso (reprodução) desde o último uso ou, sem reprodução registrada, desde que o tracker confirmou o seed.',
  },
  {
    key: 'PLAYBACK_MAX_SESSIONS', type: 'int', min: 0, max: 1000, default: 0, unit: 'sessões', group: 'reproducao', access: 'editable', restart: true,
    description: 'Máximo de reproduções simultâneas no total (uma por credencial e filme; HEAD, seeks e reconexões não contam). 0 = sem limite. O excesso recebe 429 com Retry-After antes de qualquer download.',
  },
  {
    key: 'PLAYBACK_MAX_PER_CREDENTIAL', type: 'int', min: 0, max: 1000, default: 0, unit: 'sessões', group: 'reproducao', access: 'editable', restart: true,
    description: 'Máximo de reproduções simultâneas por credencial de instalação. 0 = sem limite. Vale em conjunto com PLAYBACK_MAX_SESSIONS.',
  },
  {
    key: 'PLAYBACK_SESSION_GRACE_SECONDS', type: 'int', min: 5, max: 3600, default: 30, unit: 's', group: 'reproducao', access: 'advanced', restart: true,
    description: 'Tempo sem requisições para uma reprodução expirar e liberar a vaga. Cobre o intervalo entre fechar um Range e abrir outro num seek.',
  },
  {
    key: 'ALERTS_ENABLED', type: 'bool', default: false, group: 'alertas', access: 'editable', restart: false,
    description: 'Liga os alertas operacionais por webhook (desligado por padrão). Exige ALERT_WEBHOOK_ALLOWED_HOSTS e um destino configurado (painel, npm run alertas ou ambiente).',
  },
  {
    key: 'ALERT_WEBHOOK_URL', type: 'string', default: null, group: 'alertas', access: 'readonly', envOnly: true, secret: true, restart: true,
    description: 'URL do destino (pode conter token). Segredo: só pelo ambiente; nunca é gravada no settings.json nem exibida. Alternativas: ALERT_WEBHOOK_URL_FILE ou o painel/CLI (arquivo 0600).',
  },
  {
    key: 'ALERT_WEBHOOK_URL_FILE', type: 'path', default: null, group: 'alertas', access: 'readonly', envOnly: true, restart: true,
    description: 'Arquivo protegido (0600) com a URL completa do destino. Só pelo ambiente.',
  },
  {
    key: 'ALERT_WEBHOOK_TOKEN', type: 'string', default: null, group: 'alertas', access: 'readonly', envOnly: true, secret: true, restart: true,
    description: 'Token bearer opcional enviado no cabeçalho Authorization. Segredo: só pelo ambiente (ou painel/CLI, em arquivo 0600).',
  },
  {
    key: 'ALERT_WEBHOOK_FORMAT', type: 'enum', values: ['json', 'text'], default: 'json', group: 'alertas', access: 'editable', restart: false,
    description: 'json envia o evento estruturado; text envia só a mensagem (text/plain), adequado ao tópico do ntfy.',
  },
  {
    key: 'ALERT_WEBHOOK_ALLOWED_HOSTS', type: 'hostlist', default: '', group: 'alertas', access: 'editable', restart: false,
    description: 'Hosts exatos aprovados para o destino (obrigatório ao habilitar). Sem curinga.',
  },
  {
    key: 'ALERT_WEBHOOK_ALLOW_PRIVATE', type: 'bool', default: false, group: 'alertas', access: 'advanced', restart: false, risky: false,
    description: 'Permite destino em rede privada (RFC1918) e http:// nela. Loopback, link-local, metadata e o próprio aplicativo continuam proibidos.',
  },
  {
    key: 'ALERT_HNR_WITHIN_HOURS', type: 'number', min: 1, max: 720, default: 48, unit: 'h', group: 'alertas', access: 'advanced', restart: false,
    description: 'Alerta quando o prazo de seed confirmado pelo tracker está a este tempo ou menos.',
  },
  {
    key: 'ALERT_DISK_FREE_GIB', type: 'number', min: 0, max: 1048576, default: 10, unit: 'GiB', group: 'alertas', access: 'advanced', restart: false,
    description: 'Alerta de disco baixo abaixo deste espaço livre (0 desliga). Distinto da reserva de admissão.',
  },
  {
    key: 'ALERT_TRACKER_FAILURE_MINUTES', type: 'number', min: 1, max: 1440, default: 15, unit: 'min', group: 'alertas', access: 'advanced', restart: false,
    description: 'Tempo desde a primeira falha explícita do tracker sem recuperação. Não aumenta as consultas ao ASC.',
  },
  {
    key: 'ALERT_NO_PEERS_MINUTES', type: 'number', min: 1, max: 1440, default: 15, unit: 'min', group: 'alertas', access: 'advanced', restart: false,
    description: 'Tempo de um download em conclusão sem peers nem progresso. Seed ocioso não conta.',
  },
  {
    key: 'ALERT_COOLDOWN_MINUTES', type: 'number', min: 5, max: 10080, default: 60, unit: 'min', group: 'alertas', access: 'advanced', restart: false,
    description: 'Intervalo mínimo para repetir o mesmo alerta enquanto a condição continua aberta.',
  },
  {
    key: 'LOG_LEVEL', type: 'enum', values: ['debug', 'info', 'warn', 'error'], default: 'debug', group: 'logs', access: 'editable', restart: false,
    description: 'Nível mínimo registrado.',
  },
  {
    key: 'LOG_RETENTION_DAYS', type: 'int', min: 1, default: 14, unit: 'dias', group: 'logs', access: 'advanced', restart: true,
    description: 'Retenção dos arquivos diários de log.',
  },
]);

const BY_KEY = new Map(SCHEMA.map((entry) => [entry.key, entry]));

// ---------------------------------------------------------------------------
// Conversão e validação de um valor isolado. Devolvem { value } ou { error }.

function hostOk(name) {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(name);
}

// `fromEnv`: o valor chega como texto; no arquivo JSON os tipos precisam ser os certos.
function coerce(entry, raw, fromEnv) {
  const { key, type } = entry;
  const fail = (msg) => ({ error: `${key}: ${msg}` });
  const range = () => `${entry.min !== undefined ? ` ≥ ${entry.min}` : ''}${entry.max !== undefined ? ` e ≤ ${entry.max}` : ''}`;
  switch (type) {
    case 'int':
    case 'number': {
      let n = raw;
      if (fromEnv) n = String(raw).trim() === '' ? NaN : Number(raw);
      else if (typeof raw !== 'number') return fail('deve ser um número.');
      if (!Number.isFinite(n) || (type === 'int' && !Number.isInteger(n))) {
        return fail(type === 'int' ? 'deve ser um inteiro.' : 'deve ser um número.');
      }
      const especial = (entry.special ?? []).includes(n); // valor sentinela permitido fora da faixa (ex.: -1)
      if (!especial && ((entry.min !== undefined && n < entry.min) || (entry.max !== undefined && n > entry.max))) {
        return fail(`deve ser um ${type === 'int' ? 'inteiro' : 'número'}${range()}.`);
      }
      return { value: n };
    }
    case 'bool': {
      if (typeof raw === 'boolean') return { value: raw };
      const t = String(raw).trim().toLowerCase();
      if (fromEnv && (t === 'true' || t === 'false')) return { value: t === 'true' };
      return fail('deve ser true ou false.');
    }
    case 'enum': {
      const t = String(raw).trim().toLowerCase();
      if (typeof raw !== 'string' || !entry.values.includes(t)) return fail(`deve ser ${entry.values.join(', ')}.`);
      return { value: t };
    }
    case 'url': {
      if (typeof raw !== 'string') return fail('deve ser uma URL em texto.');
      try {
        const u = new URL(raw.trim());
        if (!['http:', 'https:'].includes(u.protocol)) return fail('deve começar com http:// ou https://.');
        if (u.username || u.password) return fail('não pode conter usuário ou senha na URL.');
        return { value: raw.trim().replace(/\/+$/, '') };
      } catch { return fail('URL inválida.'); }
    }
    case 'hostlist': {
      if (typeof raw !== 'string') return fail('deve ser texto com nomes separados por vírgula.');
      const names = raw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      const bad = names.find((n) => !hostOk(n));
      if (bad) return fail(`"${bad.slice(0, 40)}" não é um nome de host válido (sem curinga, porta ou esquema).`);
      return { value: names.join(',') };
    }
    case 'advhost': {
      const r = network.parseHost(raw);
      return r.error ? fail(r.error) : { value: r.host };
    }
    case 'ifname': {
      const r = network.parseInterfaceName(raw);
      return r.error ? fail(r.error) : { value: r.name };
    }
    case 'path': {
      if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) return fail('deve ser um caminho não vazio.');
      return { value: raw };
    }
    default: {
      if (typeof raw !== 'string') return fail('deve ser texto.');
      return { value: raw };
    }
  }
}

// ---------------------------------------------------------------------------
// Arquivo persistente.

function filePath(dataDir) { return path.join(dataDir, FILE_NAME); }

// Lê o arquivo. { exists:false } quando ausente; lança SettingsError se corrompido ou de versão futura.
function readFile(dataDir) {
  const file = filePath(dataDir);
  let text;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE_BYTES) throw new SettingsError('corrupt', `${file} é grande demais para ser uma configuração.`);
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof SettingsError) throw err;
    if (err.code === 'ENOENT') return { exists: false, revision: 0, values: {}, extra: {} };
    throw new SettingsError('io', `Não foi possível ler ${file}: ${err.message}`);
  }
  let doc;
  try { doc = JSON.parse(text); } catch {
    throw new SettingsError('corrupt', `${file} não é um JSON válido. Corrija ou renomeie o arquivo; nada foi alterado.`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !doc.values || typeof doc.values !== 'object' || Array.isArray(doc.values)) {
    throw new SettingsError('corrupt', `${file} não tem o formato esperado. Corrija ou renomeie o arquivo; nada foi alterado.`);
  }
  if (!Number.isInteger(doc.version) || doc.version < 1) {
    throw new SettingsError('corrupt', `${file} sem versão de esquema válida.`);
  }
  if (doc.version > FILE_VERSION) {
    throw new SettingsError('newer', `${file} foi gravado por uma versão mais nova (esquema ${doc.version}; esta entende ${FILE_VERSION}). Atualize o programa; nada foi alterado.`);
  }
  const revision = Number.isInteger(doc.revision) && doc.revision >= 0 ? doc.revision : 0;
  const values = {};
  const extra = {}; // chaves desconhecidas são preservadas ao regravar (downgrade não perde dados)
  for (const [k, v] of Object.entries(doc.values)) {
    if (!KEY_RE.test(k)) continue;
    if (BY_KEY.has(k)) values[k] = v; else extra[k] = v;
  }
  return { exists: true, revision, values, extra };
}

// Escrita atômica: arquivo temporário na mesma pasta, fsync e rename. Modo 0600 (no
// Windows o modo é ignorado). Não deixa lixo se algo falhar.
function writeFileAtomic(dataDir, revision, values, extra) {
  const file = filePath(dataDir);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const doc = { version: FILE_VERSION, revision, updatedAt: new Date().toISOString(), values: { ...extra, ...values } };
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, `${JSON.stringify(doc, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows/volume sem chmod */ }
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* já fechado */ } }
    try { fs.rmSync(tmp, { force: true }); } catch { /* nada a limpar */ }
    throw new SettingsError('io', `Não foi possível gravar ${file}: ${err.message}`);
  }
}

// Trava curta entre processos (CLI e serviço) para o ciclo ler-comparar-gravar.
function withLock(dataDir, fn) {
  const lock = path.join(dataDir, `${FILE_NAME}.lock`);
  let fd;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; } catch (err) {
      if (err.code !== 'EEXIST') throw new SettingsError('io', `Não foi possível travar a configuração: ${err.message}`);
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; }
      } catch { /* sumiu: tenta de novo */ continue; }
      throw new SettingsError('busy', 'Outra alteração de configuração está em andamento. Tente de novo.');
    }
  }
  if (fd === undefined) throw new SettingsError('busy', 'Outra alteração de configuração está em andamento. Tente de novo.');
  try { return fn(); } finally {
    try { fs.closeSync(fd); } catch { /* já fechado */ }
    try { fs.rmSync(lock, { force: true }); } catch { /* já removido */ }
  }
}

// ---------------------------------------------------------------------------
// Resolução: ambiente > arquivo > padrão, mais as regras de combinação.

function envText(env, key) {
  const raw = env[key];
  return raw === undefined || raw === null || String(raw) === '' ? null : String(raw);
}

function resolveDataDir(env) {
  return path.resolve(envText(env, 'DATA_DIR') || path.join(__dirname, '..', 'private'));
}

// Não lança: devolve { ok, problems, warnings, ... } para que o terminal (#20) consiga
// mostrar e consertar uma configuração quebrada. Use load() na partida.
// `interfaces` (os.networkInterfaces simulado nos testes) e `strictNetwork` (endereço escolhido
// que não é do host vira problema, usado ao salvar; na partida é só aviso: ver src/network.js).
function resolve({ dataDir = resolveDataDir(process.env), env = process.env, file = undefined, interfaces = undefined, strictNetwork = false } = {}) {
  const problems = [];
  const warnings = [];
  let disk = file;
  if (disk === undefined) {
    try { disk = readFile(dataDir); } catch (err) {
      if (!(err instanceof SettingsError)) throw err;
      problems.push(...err.problems);
      disk = { exists: false, revision: 0, values: {}, extra: {}, broken: true };
    }
  }

  const values = {};
  const sources = {};
  const fileValues = {}; // o que o arquivo tem (já validado), mesmo quando o ambiente o sobrepõe
  const present = {}; // segredos e chaves só de ambiente: só "definido ou não"

  for (const entry of SCHEMA) {
    const { key } = entry;
    const fromEnvText = envText(env, key);

    // Chave só de ambiente (inclusive segredo) no arquivo é erro, mesmo que o valor seja ignorado.
    if (key in disk.values && entry.envOnly) {
      problems.push(`${FILE_NAME}: ${key} não pode ser definida no arquivo de configuração (só pelo ambiente). Remova-a do arquivo.`);
    }
    if (entry.secret) { present[key] = fromEnvText !== null; sources[key] = fromEnvText !== null ? 'env' : 'default'; continue; }

    if (key in disk.values) {
      if (!entry.envOnly) {
        const r = coerce(entry, disk.values[key], false);
        if (r.error) problems.push(`${FILE_NAME}: ${r.error}`); else fileValues[key] = r.value;
      }
    }

    if (fromEnvText !== null) {
      if (entry.envOnly && entry.type === 'string') { values[key] = fromEnvText; sources[key] = 'env'; continue; }
      const r = coerce(entry, fromEnvText, true);
      if (r.error) { problems.push(`Ambiente: ${r.error}`); sources[key] = 'env'; continue; }
      values[key] = r.value; sources[key] = 'env';
    } else if (key in fileValues) {
      values[key] = fileValues[key]; sources[key] = 'file';
    } else {
      sources[key] = 'default';
      if (key === 'DATA_DIR') values[key] = dataDir;
      else values[key] = typeof entry.default === 'function' ? entry.default({ dataDir }) : entry.default;
    }
  }
  values.DATA_DIR = dataDir;

  // --- modo e combinações --------------------------------------------------
  const legacyLan = values.BRIDGE_ALLOW_LAN === '1';
  if (values.BRIDGE_ALLOW_LAN && !['0', '1'].includes(values.BRIDGE_ALLOW_LAN)) {
    warnings.push('BRIDGE_ALLOW_LAN: só o valor 1 liga a LAN; qualquer outro é tratado como desligado.');
  }
  if (legacyLan && sources.ASCSTREMIO_MODE !== 'default' && values.ASCSTREMIO_MODE === 'local') {
    problems.push('Contradição: BRIDGE_ALLOW_LAN=1 pede LAN, mas ASCSTREMIO_MODE=local. Defina só um dos dois (prefira ASCSTREMIO_MODE).');
  }
  const mode = legacyLan ? 'lan' : values.ASCSTREMIO_MODE;
  const container = values.ASCSTREMIO_CONTAINER === '1';

  const ports = [['PORT', values.PORT], ['BRIDGE_PORT', values.BRIDGE_PORT], ['CONFIG_PORT', values.CONFIG_PORT]];
  if (values.TORRENT_PORT) ports.push(['TORRENT_PORT', values.TORRENT_PORT]);
  const seen = new Map();
  for (const [k, p] of ports) {
    if (seen.has(p)) problems.push(`Porta ${p} repetida em ${seen.get(p)} e ${k}: cada serviço precisa da sua.`);
    else seen.set(p, k);
  }

  const plan = network.evaluate({
    mode, container, strict: strictNetwork,
    ports: { addon: values.PORT, bridge: values.BRIDGE_PORT },
    advertiseHost: values.LAN_ADVERTISE_HOST, interfaceName: values.LAN_INTERFACE,
    bridgeUrl: values.BRIDGE_PUBLIC_URL, addonUrl: values.ADDON_PUBLIC_URL,
    interfaces: mode === 'lan' && !container ? (interfaces ?? network.systemInterfaces()) : {},
  });
  problems.push(...plan.problems);
  warnings.push(...plan.warnings);
  if (mode === 'lan') {
    warnings.push('Modo LAN: addon e ponte escutam fora do loopback; o acesso exige a credencial de instalação (sem TLS: o token trafega em HTTP na rede local). Use só em rede doméstica confiável e para os seus próprios aparelhos; o painel continua restrito a este computador, salvo a administração pela LAN (opcional, CONFIG_ALLOW_LAN).');
  }

  if (values.ALERTS_ENABLED === true) {
    if (!String(values.ALERT_WEBHOOK_ALLOWED_HOSTS || '').trim()) {
      problems.push('ALERTS_ENABLED: informe ALERT_WEBHOOK_ALLOWED_HOSTS com o host exato do destino antes de habilitar.');
    }
    if (!require('./alerts').destinationPresent({ dataDir, env })) {
      problems.push('ALERTS_ENABLED: configure o destino antes de habilitar (npm run alertas -- definir, painel ou ALERT_WEBHOOK_URL).');
    }
  }

  const bindHost = container || mode === 'lan' ? '0.0.0.0' : '127.0.0.1';
  return {
    ok: problems.length === 0,
    problems,
    warnings,
    dataDir,
    file: filePath(dataDir),
    fileExists: Boolean(disk.exists),
    revision: disk.revision,
    values,
    sources,
    fileValues,
    present,
    extra: disk.extra || {},
    mode,
    container,
    derived: { bindHost, mode, network: plan },
  };
}

// Para a partida: lança SettingsError('invalid') com todos os problemas de uma vez.
function load(opts = {}) {
  const snap = resolve(opts);
  if (!snap.ok) throw new SettingsError('invalid', snap.problems);
  return snap;
}

// ---------------------------------------------------------------------------
// Alteração: valida o resultado inteiro antes de tocar o disco.

// changes: { CHAVE: valor } ; valor null remove do arquivo (volta ao padrão/ambiente).
// expectedRevision é obrigatório (controle otimista de concorrência: use snap.revision).
// dryRun: true valida tudo e devolve o resultado sem gravar nada.
// Retorna { snapshot, changed, restart }: restart lista as chaves alteradas que só valem ao reiniciar.
function update({ dataDir = resolveDataDir(process.env), env = process.env, changes, expectedRevision, interfaces = undefined, dryRun = false } = {}) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new SettingsError('invalid', 'Nenhuma alteração informada.');
  if (!Number.isInteger(expectedRevision)) throw new SettingsError('invalid', 'expectedRevision é obrigatório (use a revisão lida).');

  const keys = Object.keys(changes);
  const refused = [];
  for (const key of keys) {
    const entry = BY_KEY.get(key);
    if (!entry) { refused.push(['unknown', `${key}: opção desconhecida.`]); continue; }
    if (entry.secret) { refused.push(['secret', `${key}: segredos nunca são gravados na configuração.`]); continue; }
    if (entry.envOnly || entry.access === 'readonly') { refused.push(['locked', `${key}: somente leitura (${entry.envOnly ? 'definida só pelo ambiente' : 'não editável'}).`]); continue; }
    if (envText(env, key) !== null) { refused.push(['locked', `${key}: definida pelo ambiente (systemd/Compose/shell); altere lá. O arquivo não a sobrescreve.`]); }
  }
  if (refused.length) throw new SettingsError(refused[0][0], refused.map((r) => r[1]));

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return withLock(dataDir, () => {
    const disk = readFile(dataDir);
    if (disk.revision !== expectedRevision) {
      throw new SettingsError('conflict', `A configuração mudou (revisão ${disk.revision}, esperada ${expectedRevision}). Releia e tente de novo.`);
    }
    const antes = resolve({ dataDir, env, file: disk, interfaces, strictNetwork: true }).problems;
    // Nunca regrava por cima de um arquivo com problema próprio (ex.: segredo gravado à mão): conserte antes.
    const doArquivo = antes.filter((p) => p.startsWith(`${FILE_NAME}: `));
    if (doArquivo.length) throw new SettingsError('invalid', doArquivo);
    const before = new Set(antes);
    const next = { ...disk.values };
    const changed = [];
    for (const key of keys) {
      const v = changes[key];
      if (v === null) { if (key in next) { delete next[key]; changed.push(key); } continue; }
      const r = coerce(BY_KEY.get(key), v, false);
      if (r.error) throw new SettingsError('invalid', r.error);
      if (next[key] !== r.value) { next[key] = r.value; changed.push(key); }
    }
    const candidate = { ...disk, values: next };
    const after = resolve({ dataDir, env, file: candidate, interfaces, strictNetwork: true });
    const fresh = after.problems.filter((p) => !before.has(p));
    if (fresh.length) throw new SettingsError('invalid', fresh); // nada gravado
    // dryRun: mesma validação e mesmos conflitos, sem gravar (prévia do painel antes de salvar).
    if (dryRun) return { snapshot: after, changed, restart: changed.filter((k) => BY_KEY.get(k).restart), dryRun: true };
    if (changed.length === 0) return { snapshot: after, changed, restart: [] };
    writeFileAtomic(dataDir, disk.revision + 1, next, disk.extra);
    const snapshot = resolve({ dataDir, env, interfaces });
    return { snapshot, changed, restart: changed.filter((k) => BY_KEY.get(k).restart) };
  });
}

// ---------------------------------------------------------------------------
// Leitura sanitizada (para painel, CLI e logs): nunca devolve segredos.

function view(snapshot, env = process.env) {
  return SCHEMA.map((entry) => {
    const { key } = entry;
    const source = snapshot.sources[key];
    let locked = null;
    if (entry.envOnly || entry.access === 'readonly') locked = entry.envOnly ? 'definida só pelo ambiente' : 'não editável';
    else if (source === 'env') locked = 'definida pelo ambiente (systemd/Compose/shell)';
    const base = {
      key,
      group: entry.group,
      groupLabel: GROUPS[entry.group],
      type: entry.type,
      unit: entry.unit ?? null,
      values: entry.values ?? null,
      min: entry.min ?? null,
      max: entry.max ?? null,
      access: entry.access,
      restart: entry.restart,
      risky: Boolean(entry.risky),
      secret: Boolean(entry.secret),
      description: entry.description,
      source,
      locked,
    };
    if (entry.secret) return { ...base, defined: Boolean(snapshot.present[key]), value: null, default: null, fileValue: null };
    const def = typeof entry.default === 'function' ? entry.default({ dataDir: snapshot.dataDir }) : entry.default;
    return {
      ...base,
      value: snapshot.values[key] ?? null,
      default: key === 'DATA_DIR' ? null : def ?? null,
      fileValue: key in snapshot.fileValues ? snapshot.fileValues[key] : null,
    };
  });
}

// Ponte para leitores antigos que ainda consultam process.env (safety, bridge, keepawake):
// copia só o que veio do arquivo (o ambiente já está lá e nunca é sobrescrito).
function applyToEnv(snapshot, env = process.env) {
  for (const [key, value] of Object.entries(snapshot.fileValues)) {
    if (snapshot.sources[key] !== 'file') continue;
    env[key] = String(value);
  }
  if (snapshot.mode === 'lan' && env.BRIDGE_ALLOW_LAN !== '1') env.BRIDGE_ALLOW_LAN = '1';
  return env;
}

module.exports = {
  SCHEMA,
  GROUPS,
  FILE_NAME,
  FILE_VERSION,
  SettingsError,
  schemaEntry: (key) => BY_KEY.get(key) ?? null,
  resolveDataDir,
  filePath,
  resolve,
  load,
  update,
  view,
  applyToEnv,
};
