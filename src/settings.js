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
  caminhos: 'Credenciais e caminhos',
  rede: 'Rede e Stremio',
  seed: 'Seed, energia e transferência',
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
    description: 'Endereço (IPv4, IPv6 ou nome DNS estável, sem esquema, porta ou caminho) que os outros aparelhos usam para chegar aqui, nas URLs de instalação e de vídeo. Só vale no modo LAN. Não muda a escuta nem o Host aceito além deste próprio nome.',
  },
  {
    key: 'LAN_INTERFACE', type: 'ifname', default: null, group: 'rede', access: 'advanced', restart: true,
    description: 'Interface de rede (ex.: enp3s0, Wi-Fi) de onde tirar o endereço anunciado no modo LAN quando há várias. LAN_ADVERTISE_HOST, se definida, prevalece; as URLs públicas explícitas também.',
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
    key: 'AFTER_SEED', type: 'enum', values: ['delete', 'stop', 'keep'], default: 'delete', group: 'seed', access: 'editable', restart: true,
    description: 'Depois de o tracker confirmar o seed: delete apaga os arquivos, stop encerra e preserva, keep continua semeando.',
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
    description: 'Meta local de seed; não altera a obrigação imposta pelo tracker (regra 13.1).',
  },
  {
    key: 'KEEP_AWAKE', type: 'enum', values: ['auto', 'off'], default: 'auto', group: 'seed', access: 'advanced', restart: true,
    description: 'off desliga o bloqueio de suspensão enquanto há seed pendente.',
  },
  {
    key: 'BRIDGE_UPLOAD_LIMIT', type: 'int', min: -1, default: -1, unit: 'B/s', group: 'seed', access: 'advanced', restart: true,
    description: 'Limite de upload em bytes por segundo. -1 = sem limite.',
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
      if ((entry.min !== undefined && n < entry.min) || (entry.max !== undefined && n > entry.max)) {
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
    warnings.push('Modo LAN: addon e ponte escutam fora do loopback; o acesso exige a credencial de instalação (sem TLS: o token trafega em HTTP na rede local). Use só em rede doméstica confiável e para os seus próprios aparelhos; o painel continua restrito a este computador.');
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
// Retorna { snapshot, changed, restart }: restart lista as chaves alteradas que só valem ao reiniciar.
function update({ dataDir = resolveDataDir(process.env), env = process.env, changes, expectedRevision, interfaces = undefined } = {}) {
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
