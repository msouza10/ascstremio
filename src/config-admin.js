// Operações de configuração para quem administra a instalação (terminal hoje; o assistente
// web da issue #23 deve reutilizar este módulo). Aqui só há lógica, sem entrada/saída:
// a apresentação (texto, JSON, menu) fica em src/configurar-cli.js.
//
// Regras:
//   - Leitura (inspecionar, diagnosticar) nunca escreve e funciona com o serviço ligado.
//   - Escrita só com a TRAVA DA INSTÂNCIA (src/instance-lock.js): se o serviço (ou outro
//     processo) usa a pasta de dados, a escrita é recusada. A CLI nunca é um segundo escritor
//     por trás do processo que abriu o cofre de seed e o cliente torrent. Não há rota
//     administrativa de configuração no serviço; parar o serviço, alterar e iniciar é o caminho.
//   - Toda alteração passa por settings.update com expectedRevision (mesma validação da partida).
//   - Nada aqui lê, grava ou devolve segredo: chaves `secret` só existem no ambiente.
//   - Não depende da sessão do ASC: serve para consertar rede/painel com a sessão expirada.

const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('./settings');
const { acquireInstance, LockError, LOCK_NAME } = require('./instance-lock');

const SERVICE_ENV = 'service.env';
const KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

class AdminError extends Error {
  // code: 'instance' | 'secret' | 'unknown' | 'usage' | 'nothing' | ...
  constructor(code, message) {
    super(message);
    this.name = 'AdminError';
    this.code = code;
  }
}

// O serviço Linux recebe as variáveis de DATA_DIR/service.env (EnvironmentFile do systemd).
// Para o terminal enxergar o mesmo ambiente do serviço, lê-se esse arquivo: formato
// CHAVE=VALOR por linha, "#"/";" comentam, aspas externas são removidas. Só chaves do esquema.
function readServiceEnv(dataDir) {
  const file = path.join(dataDir, SERVICE_ENV);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { file, exists: false, vars: {} }; }
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (!m || !KEY_RE.test(m[1]) || !settings.schemaEntry(m[1])) continue;
    let v = m[2];
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1);
    vars[m[1]] = v;
  }
  return { file, exists: true, vars };
}

function instanceStatus(dataDir) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(dataDir, LOCK_NAME), 'utf8')); } catch { return { active: false }; }
  if (!data || !Number.isInteger(data.pid)) return { active: false };
  const base = { pid: data.pid, hostname: data.hostname ?? null, startedAt: data.startedAt ?? null };
  if (data.hostname !== os.hostname()) return { ...base, active: true, certain: false };
  try { process.kill(data.pid, 0); } catch (err) {
    if (err.code === 'ESRCH') return { active: false, stale: true, ...base };
  }
  return { ...base, active: true, certain: true };
}

// Ambiente efetivo da CLI: o do processo, com as variáveis do service.env por cima (é o que o
// serviço enxerga). `dataDir` vem de DATA_DIR no ambiente, como na partida.
function context({ env = process.env } = {}) {
  const dataDir = settings.resolveDataDir(env);
  const svc = readServiceEnv(dataDir);
  const merged = { ...env, ...svc.vars };
  merged.DATA_DIR = env.DATA_DIR; // DATA_DIR só pelo ambiente do processo
  if (merged.DATA_DIR === undefined) delete merged.DATA_DIR;
  return { dataDir, env: merged, serviceEnv: svc };
}

const ORIGEM = { env: 'ambiente', file: 'arquivo', default: 'padrão' };

// Estado completo para exibir: opções (sem segredos), problemas, avisos, instância.
function inspect(opts = {}) {
  const ctx = context(opts);
  const snapshot = settings.resolve({ dataDir: ctx.dataDir, env: ctx.env });
  const doServiceEnv = new Set(Object.keys(ctx.serviceEnv.vars));
  const options = settings.view(snapshot, ctx.env).map((o) => ({
    ...o,
    origin: ORIGEM[o.source],
    viaServiceEnv: o.source === 'env' && doServiceEnv.has(o.key) && (opts.env ?? process.env)[o.key] === undefined,
    overridden: o.source === 'env' && o.fileValue !== null,
  }));
  const fileBroken = !snapshot.fileExists && fs.existsSync(snapshot.file);
  return {
    ctx,
    snapshot,
    options,
    instance: instanceStatus(ctx.dataDir),
    fileBroken,
  };
}

// Texto da linha de comando -> valor tipado que settings.update espera.
function typed(key, text) {
  const entry = settings.schemaEntry(key);
  const t = String(text).trim();
  if (entry && (entry.type === 'int' || entry.type === 'number')) return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
  if (entry && entry.type === 'bool') {
    if (t.toLowerCase() === 'true') return true;
    if (t.toLowerCase() === 'false') return false;
  }
  return String(text);
}

// Recusa cedo e sem ecoar valores: segredos, desconhecidas e somente leitura.
function assertWritable(keys) {
  for (const key of keys) {
    const entry = settings.schemaEntry(key);
    const nome = String(key).slice(0, 64);
    if (!entry) throw new AdminError('unknown', `${nome}: opção desconhecida (veja "listar").`);
    if (entry.secret) {
      throw new AdminError('secret', `${key}: é segredo e nunca é aceito por argumento nem gravado na configuração. `
        + 'A passkey vai em passkey.txt (scripts/docker.sh passkey no contêiner) ou em PASSKEY no ambiente.');
    }
  }
}

// Diretórios a travar: os efetivos, trocados pelos novos quando a alteração os muda.
function dirsToLock(ctx, snapshot, changes) {
  const dataDir = ctx.dataDir;
  const pick = (key, fallback) => (typeof changes?.[key] === 'string' && changes[key] ? changes[key] : (snapshot.values[key] || fallback));
  return {
    dataDir,
    torrentDir: path.resolve(pick('ASC_TORRENT_DIR', path.join(dataDir, 'torrents'))),
    storeDir: path.resolve(pick('BRIDGE_STORE', path.join(dataDir, 'cache'))),
  };
}

// Executa fn com a instalação travada. Instância ativa => AdminError('instance').
function withInstance(ctx, snapshot, changes, fn) {
  let held;
  try {
    held = acquireInstance(dirsToLock(ctx, snapshot, changes));
  } catch (err) {
    if (err instanceof LockError) {
      throw new AdminError('instance', `${err.message} A configuração só pode ser alterada com o aplicativo parado `
        + '(pare o serviço, altere e inicie de novo); consultar continua funcionando com ele ligado.');
    }
    throw err;
  }
  try { return fn(); } finally { held.release(); }
}

// changes: { CHAVE: valor tipado | null (remover) }. expectedRevision opcional (padrão: a lida agora).
function change({ env = process.env, changes, expectedRevision } = {}) {
  assertWritable(Object.keys(changes || {}));
  const ctx = context({ env });
  const snapshot = settings.resolve({ dataDir: ctx.dataDir, env: ctx.env });
  const expected = Number.isInteger(expectedRevision) ? expectedRevision : snapshot.revision;
  return withInstance(ctx, snapshot, changes, () => {
    const out = settings.update({ dataDir: ctx.dataDir, env: ctx.env, changes, expectedRevision: expected });
    return { ...out, ctx };
  });
}

// Arquivo settings.json ilegível, de versão futura ou com conteúdo inválido: renomeia (nunca
// apaga) para settings.json.quebrado-<data>, para a próxima partida usar ambiente + padrões.
// Problemas vindos do ambiente não são tocados: a correção é no service.env/Compose.
function recover({ env = process.env } = {}) {
  const ctx = context({ env });
  const snapshot = settings.resolve({ dataDir: ctx.dataDir, env: ctx.env });
  const prefixo = `${settings.FILE_NAME}: `;
  const doArquivo = !snapshot.fileExists && fs.existsSync(snapshot.file)
    ? true
    : snapshot.problems.some((p) => p.startsWith(prefixo));
  if (!doArquivo) {
    throw new AdminError('nothing', 'O arquivo de configuração não tem problema; nada a recuperar.'
      + (snapshot.problems.length ? ' Os problemas restantes vêm do ambiente: corrija no service.env/Compose.' : ''));
  }
  return withInstance(ctx, snapshot, null, () => {
    const marca = new Date().toISOString().replace(/[:.]/g, '-');
    const destino = `${snapshot.file}.quebrado-${marca}`;
    try { fs.renameSync(snapshot.file, destino); } catch (err) {
      throw new AdminError('io', `Não foi possível mover ${snapshot.file}: ${err.message}`);
    }
    return { moved: snapshot.file, backup: destino, after: settings.resolve({ dataDir: ctx.dataDir, env: ctx.env }) };
  });
}

module.exports = {
  AdminError,
  SERVICE_ENV,
  readServiceEnv,
  instanceStatus,
  context,
  inspect,
  typed,
  assertWritable,
  change,
  recover,
};
