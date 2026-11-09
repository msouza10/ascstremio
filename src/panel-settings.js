// Configurações pelo painel (issue #23): assistente depois do primeiro login e página
// permanente. Só lógica, sem HTTP: src/config-server.js faz a autorização (Host, Origin, CSRF,
// JSON, sessão) e traduz PanelError em resposta.
//
// Regras de desenho:
//   - O painel roda no MESMO processo que detém a trava da instância e abriu o settings.json:
//     escreve por settings.update com expectedRevision (o mesmo caminho e a mesma validação
//     da partida e do terminal). Não há segundo escritor nem rota administrativa na ponte.
//   - A lista de opções, os tipos e os limites vêm do esquema (settings.view); a UI não os
//     duplica. A prévia (dryRun) usa a mesma validação da gravação.
//   - O ambiente ORIGINAL da partida é a verdade para "definida pelo ambiente": process.env
//     recebe os valores do arquivo (settings.applyToEnv) e não serve para decidir origem.
//   - Segredos nunca saem: chaves `secret` só têm "definido ou não". O único valor secreto que
//     o painel devolve é o token de uma credencial recém-emitida, uma vez, na resposta da
//     emissão (depois só existe o verificador em disco).
//   - A conclusão do assistente vive em DATA_DIR/wizard.json, separada da sessão do ASC e do
//     settings.json: expirar a sessão ou atualizar o programa não refaz a configuração.
//   - Opções `risky` (pastas de dados) só pelo terminal com o aplicativo parado: trocar a pasta
//     exige travar o novo diretório, e quem segura a trava é este processo.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const settings = require('./settings');
const admin = require('./config-admin');
const network = require('./network');

const WIZARD_FILE = 'wizard.json';
const WIZARD_VERSION = 1;
const ORIGEM = { env: 'ambiente', file: 'arquivo', default: 'padrão' };
// Mudar qualquer uma destas altera endereço, porta ou quem alcança o aplicativo: a resposta
// traz instruções de recuperação.
const NETWORK_KEYS = new Set([
  'ASCSTREMIO_MODE', 'PORT', 'BRIDGE_PORT', 'CONFIG_PORT', 'TORRENT_PORT', 'LAN_ADVERTISE_HOST',
  'LAN_INTERFACE', 'BRIDGE_PUBLIC_URL', 'ADDON_PUBLIC_URL', 'ALLOWED_HOSTS',
]);
const MAX_CHANGES = 40;
const MAX_VALUE = 512;
const MAX_CREDENTIALS = 20;

class PanelError extends Error {
  constructor(status, code, message, problems = []) {
    super(message);
    this.name = 'PanelError';
    this.status = status;
    this.code = code;
    this.problems = problems;
  }
}

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function statusFor(code) {
  if (code === 'conflict' || code === 'busy') return 409;
  if (code === 'locked') return 403;
  if (code === 'io' || code === 'corrupt' || code === 'newer') return 500;
  return 422;
}

function fromSettingsError(err) {
  if (err instanceof PanelError) return err;
  if (err instanceof settings.SettingsError) {
    const msg = err.code === 'conflict'
      ? 'A configuração mudou desde que você a abriu (outra aba ou o terminal). Nada foi gravado; os valores que você digitou foram mantidos. Recarregue as opções e confira.'
      : err.problems[0] ?? err.message;
    return new PanelError(statusFor(err.code), err.code, msg, err.problems);
  }
  if (err instanceof admin.AdminError) return new PanelError(422, err.code, err.message, [err.message]);
  return err;
}

// dataDir: pasta de dados; bootEnv: cópia do ambiente ANTES de applyToEnv; running: valores
// efetivos em uso agora (cfg.values da partida); applyLive(key, value): aplica sem reiniciar
// (hoje só LOG_LEVEL), devolve true se aplicou; credentials: CredentialStore; addonBase: URL
// do addon que os aparelhos usam (cfg.derived.network.urls.addon).
function createPanelSettings({ dataDir, bootEnv, running, applyLive = () => false, credentials = null, addonBase = null, addSecret = () => {}, interfaces = undefined } = {}) {
  if (!dataDir || !bootEnv || !running) throw new Error('panel-settings: dataDir, bootEnv e running são obrigatórios');
  const live = { ...running };
  const wizardPath = path.join(dataDir, WIZARD_FILE);
  const resolve = () => settings.resolve({ dataDir, env: bootEnv, interfaces });

  // ------------------------------------------------------------ assistente
  function readWizard() {
    try {
      const doc = JSON.parse(fs.readFileSync(wizardPath, 'utf8'));
      if (!doc || typeof doc !== 'object' || !Number.isInteger(doc.version)) return {};
      return doc;
    } catch { return {}; } // ausente ou ilegível: o assistente volta a ser oferecido (inofensivo)
  }

  function writeWizard(doc) {
    const tmp = `${wizardPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, wizardPath);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nada a limpar */ }
      throw new PanelError(500, 'io', `Não foi possível registrar o assistente: ${err.message}`);
    }
  }

  function wizardState() {
    const w = readWizard();
    return {
      version: WIZARD_VERSION,
      completed: Boolean(w.completedAt),
      completedAt: w.completedAt ?? null,
      dismissed: Boolean(w.dismissedAt) && !w.completedAt,
      dismissedAt: w.dismissedAt ?? null,
      mode: w.mode ?? null,
    };
  }

  // 'complete' registra a conclusão; 'dismiss' registra "pular por enquanto" (não insistir).
  function wizardMark(action) {
    if (action !== 'complete' && action !== 'dismiss') throw new PanelError(400, 'invalid', 'Ação inválida.');
    const old = readWizard();
    const now = new Date().toISOString();
    const doc = { ...old, version: WIZARD_VERSION, mode: resolve().mode };
    if (action === 'complete') { doc.completedAt = now; delete doc.dismissedAt; } else if (!old.completedAt) doc.dismissedAt = now;
    writeWizard(doc);
    return wizardState();
  }

  // ----------------------------------------------------------------- estado
  function pendingKeys(snapshot) {
    const out = [];
    for (const entry of settings.SCHEMA) {
      if (!entry.restart || entry.secret) continue;
      if (!sameValue(live[entry.key], snapshot.values[entry.key])) out.push(entry.key);
    }
    return out;
  }

  function optionRows(snapshot) {
    const pending = new Set(pendingKeys(snapshot));
    return settings.view(snapshot, bootEnv).map((o) => {
      let editable = !o.locked;
      let reason = o.locked;
      if (!o.locked && o.risky) { editable = false; reason = 'só pelo terminal, com o aplicativo parado (npm run configurar): trocar pastas exige travar o novo diretório'; }
      if (o.secret) { editable = false; reason = 'segredo: nunca é exibido nem gravado pela configuração'; }
      const row = {
        ...o,
        origin: ORIGEM[o.source],
        overridden: o.source === 'env' && o.fileValue !== null,
        editable,
        reason: editable ? null : reason,
        pending: pending.has(o.key),
      };
      if (!o.secret) row.running = live[o.key] ?? null;
      return row;
    });
  }

  function restartHint(snapshot) {
    if (snapshot.container) return 'No contêiner: scripts/docker.sh run (ou docker compose restart ascstremio).';
    if (process.platform === 'win32') return 'No Windows: feche o AscStremio (ícone da bandeja) e abra de novo pelo atalho.';
    return 'No Linux com serviço: systemctl --user restart ascstremio. Sem serviço: pare o npm start (Ctrl+C) e rode de novo.';
  }

  function candidates(snapshot) {
    if (snapshot.container) return { list: [], note: 'No contêiner o programa só enxerga a interface interna: informe o endereço do host (LAN_ADVERTISE_HOST).' };
    const all = network.listCandidates(interfaces);
    return { list: all.filter((c) => c.usable && c.family === 'IPv4'), excluded: all.filter((c) => !c.usable || c.family !== 'IPv4').length, note: null };
  }

  function addonUrlInfo(snapshot) {
    const pending = pendingKeys(snapshot).filter((k) => NETWORK_KEYS.has(k));
    if (pending.length) return { url: null, reason: `Há mudanças de rede esperando reinício (${pending.join(', ')}). Reinicie e abra o assistente de novo para gerar a URL.` };
    if (!addonBase) return { url: null, reason: 'Sem endereço utilizável para os aparelhos: defina LAN_ADVERTISE_HOST.' };
    return { url: addonBase, reason: null };
  }

  function state() {
    const snapshot = resolve();
    const pending = pendingKeys(snapshot);
    return {
      revision: snapshot.revision,
      mode: snapshot.mode,
      runningMode: live.ASCSTREMIO_MODE,
      container: snapshot.container,
      ok: snapshot.ok,
      problems: snapshot.problems,
      warnings: snapshot.warnings,
      groups: settings.GROUPS,
      options: optionRows(snapshot),
      pending,
      restartHint: restartHint(snapshot),
      wizard: wizardState(),
      network: { ...candidates(snapshot), advertised: snapshot.derived.network.host, hostSource: snapshot.derived.network.hostSource },
      addon: addonUrlInfo(snapshot),
      credentials: credentials ? credentials.list() : [],
    };
  }

  // ------------------------------------------------------- prévia e gravação
  function cleanChanges(body) {
    if (!body || typeof body !== 'object' || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
      throw new PanelError(400, 'invalid', 'Informe a revisão lida (expectedRevision).');
    }
    const raw = body.changes;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PanelError(400, 'invalid', 'Nenhuma alteração informada.');
    const keys = Object.keys(raw);
    if (!keys.length) throw new PanelError(400, 'invalid', 'Nenhuma alteração informada.');
    if (keys.length > MAX_CHANGES) throw new PanelError(400, 'invalid', 'Alterações demais de uma vez.');
    const changes = {};
    for (const key of keys) {
      const v = raw[key];
      if (v !== null && (typeof v !== 'string' || v.length > MAX_VALUE)) throw new PanelError(400, 'invalid', `${key.slice(0, 64)}: o valor deve ser texto curto (ou null para voltar ao padrão).`);
      changes[key] = v === null ? null : v;
    }
    try { admin.assertWritable(keys); } catch (err) { throw fromSettingsError(err); }
    for (const key of keys) {
      const entry = settings.schemaEntry(key);
      if (entry.risky) throw new PanelError(403, 'terminal', `${key}: só pelo terminal, com o aplicativo parado (npm run configurar -- definir ${key}=...).`, [key]);
    }
    // Texto do formulário -> tipo do esquema (mesma conversão da CLI).
    const typedChanges = {};
    for (const key of keys) typedChanges[key] = changes[key] === null ? null : admin.typed(key, changes[key]);
    return { changes: typedChanges, expectedRevision: body.expectedRevision };
  }

  function recoveryFor(keys, after) {
    const net = keys.filter((k) => NETWORK_KEYS.has(k));
    if (!net.length) return null;
    const out = [];
    if (net.includes('CONFIG_PORT')) out.push(`Depois de reiniciar, o painel passa a abrir em http://127.0.0.1:${after.values.CONFIG_PORT}/ (hoje: ${live.CONFIG_PORT}).`);
    if (net.includes('ASCSTREMIO_MODE') && after.mode === 'lan') out.push('No modo LAN o painel continua só neste computador (127.0.0.1); addon e ponte passam a escutar na rede local.');
    out.push('Se depois de reiniciar o addon, a ponte ou o painel não abrirem: pare o aplicativo e desfaça no terminal '
      + `(npm run configurar -- remover ${net.join(' ')}; para voltar ao uso só neste computador: npm run configurar -- modo local) e inicie de novo.`);
    out.push('Se o settings.json ficar ilegível: npm run configurar -- recuperar. O painel não depende da rede local nem da sessão do ASC para essa correção.');
    return out;
  }

  function describeChanges(before, after, changed) {
    return changed.map((key) => {
      const entry = settings.schemaEntry(key);
      return {
        key,
        unit: entry.unit ?? null,
        from: before.values[key] ?? null,
        to: after.values[key] ?? null,
        restart: Boolean(entry.restart),
        // restart:false (LOG_LEVEL) vale na hora; as demais, só depois de reiniciar.
        risky: Boolean(entry.risky),
      };
    });
  }

  function run(body, dryRun) {
    const { changes, expectedRevision } = cleanChanges(body);
    const before = resolve();
    let out;
    try {
      out = settings.update({ dataDir, env: bootEnv, changes, expectedRevision, interfaces, dryRun });
    } catch (err) { throw fromSettingsError(err); }
    const diff = describeChanges(before, out.snapshot, out.changed);
    const newWarnings = out.snapshot.warnings.filter((w) => !before.warnings.includes(w));
    return { out, before, diff, newWarnings };
  }

  function preview(body) {
    const { out, diff, newWarnings } = run(body, true);
    return {
      revision: out.snapshot.revision,
      changes: diff,
      restart: out.restart,
      warnings: newWarnings,
      recovery: recoveryFor(out.changed, out.snapshot),
      saved: false,
    };
  }

  function save(body) {
    const { out, diff, newWarnings } = run(body, false);
    // Valores que valem na hora (restart:false): aplica e atualiza o "em uso".
    for (const key of out.changed) {
      const entry = settings.schemaEntry(key);
      if (!entry.restart && applyLive(key, out.snapshot.values[key])) live[key] = out.snapshot.values[key];
    }
    return {
      saved: out.changed.length > 0,
      revision: out.snapshot.revision,
      changes: diff,
      restart: out.changed.filter((k) => settings.schemaEntry(k).restart),
      warnings: newWarnings,
      recovery: recoveryFor(out.changed, out.snapshot),
      state: state(),
    };
  }

  // --------------------------------------------------------- credenciais
  function createCredential(body) {
    if (!credentials) throw new PanelError(503, 'unavailable', 'Credenciais indisponíveis.');
    if (!body || typeof body.name !== 'string') throw new PanelError(400, 'invalid', 'Informe o nome do aparelho.');
    if (credentials.list().filter((c) => !c.revokedAt).length >= MAX_CREDENTIALS) {
      throw new PanelError(422, 'limit', `Há ${MAX_CREDENTIALS} credenciais ativas. Revogue as que não usa (npm run credenciais -- revogar).`);
    }
    const info = addonUrlInfo(resolve());
    if (!info.url) throw new PanelError(409, 'restart', info.reason);
    let made;
    try { made = credentials.create({ name: body.name, status: false }); } catch (err) {
      throw new PanelError(422, 'invalid', err.message);
    }
    addSecret(made.token); // o token também fica redigido nos logs
    const manifest = `${info.url}/${made.token}/manifest.json`;
    return {
      credential: made.credential,
      token: made.token,
      manifestUrl: manifest,
      stremioUrl: manifest.replace(/^https?:\/\//, 'stremio://'),
      once: 'Este é o único momento em que o token aparece: copie agora. Depois só é possível revogar e emitir outro.',
    };
  }

  return { state, preview, save, wizardState, wizardMark, createCredential, listCredentials: () => (credentials ? credentials.list() : []) };
}

module.exports = { createPanelSettings, PanelError, NETWORK_KEYS, WIZARD_FILE };
