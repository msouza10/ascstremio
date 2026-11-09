#!/usr/bin/env node
// Gestão das credenciais de instalação do addon (veja docs/seguranca.md).
//   npm run credenciais -- listar
//   npm run credenciais -- criar "Sala" [--status]     (emite e mostra a URL UMA vez)
//   npm run credenciais -- garantir                    (cria "Stremio local" só se não houver nenhuma ativa)
//   npm run credenciais -- rotacionar <id>             (emite outra igual e revoga a antiga)
//   npm run credenciais -- revogar <id>
//
// Fala com a ponte em execução pelas rotas administrativas, usando o token administrativo
// de DATA_DIR/admin-key (o mesmo DATA_DIR do aplicativo). Nunca grava credentials.json: só o
// processo que detém a trava da instância escreve nele, via as rotas /credentials. O token de reprodução só aparece
// na saída do terminal que o emitiu; não é gravado em log nem em arquivo.

const fs = require('fs');
const path = require('path');

const USO = 'uso: credenciais listar | criar <nome> [--status] | garantir | rotacionar <id> | revogar <id>';

function config(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'private'));
  // Portas e URL do addon seguem a configuração central (ambiente > settings.json > padrão).
  // Se ela estiver quebrada, cai no ambiente: a CLI só precisa achar a ponte.
  let v = {};
  try { v = require('./settings').resolve({ dataDir, env }).values ?? {}; } catch { /* usa o ambiente */ }
  const bridgePort = v.BRIDGE_PORT || env.BRIDGE_PORT || 7010;
  const addon = String(v.ADDON_PUBLIC_URL || env.ADDON_PUBLIC_URL || `http://127.0.0.1:${v.PORT || env.PORT || 7000}`).replace(/\/$/, '');
  return { dataDir, bridge: `http://127.0.0.1:${bridgePort}`, addon };
}

async function call(cfg, method, route, doFetch) {
  let token;
  try { token = fs.readFileSync(path.join(cfg.dataDir, 'admin-key'), 'utf8').trim(); } catch {
    throw new Error(`não achei ${path.join(cfg.dataDir, 'admin-key')}: o aplicativo já foi iniciado com este DATA_DIR?`);
  }
  let res;
  try {
    res = await doFetch(`${cfg.bridge}${route}`, { method, headers: { 'X-Admin-Token': token } });
  } catch {
    throw new Error(`a ponte não respondeu em ${cfg.bridge}: o aplicativo está em execução?`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `a ponte recusou (HTTP ${res.status})`);
  return body;
}

const installUrl = (cfg, token) => `${cfg.addon}/${token}/manifest.json`;
const date = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

function showIssued(cfg, out, { credential, token }) {
  out(`Credencial ${credential.id} ("${credential.name}")${credential.status ? ', com acesso ao catálogo de status' : ''}.`);
  out('Instale no Stremio esta URL (ela não será mostrada de novo; trate como senha):');
  out(installUrl(cfg, token));
}

async function run(argv, { env = process.env, doFetch = fetch, out = console.log } = {}) {
  const cfg = config(env);
  const [cmd, ...args] = argv;
  const flags = args.filter((a) => a.startsWith('--'));
  const pos = args.filter((a) => !a.startsWith('--'));
  const enc = encodeURIComponent;
  if (cmd === 'listar') {
    const { credentials } = await call(cfg, 'GET', '/credentials', doFetch);
    if (credentials.length === 0) out('Nenhuma credencial emitida.');
    for (const c of credentials) {
      out(`${c.id}  ${c.revokedAt ? `revogada em ${date(c.revokedAt)}` : 'ativa'}  ${c.status ? 'status' : '      '}  criada em ${date(c.createdAt)}  "${c.name}"`);
    }
    return 0;
  }
  if (cmd === 'criar' && pos.length === 1) {
    showIssued(cfg, out, await call(cfg, 'POST', `/credentials?name=${enc(pos[0])}${flags.includes('--status') ? '&status=1' : ''}`, doFetch));
    return 0;
  }
  if (cmd === 'garantir') {
    const { credentials } = await call(cfg, 'GET', '/credentials', doFetch);
    if (credentials.some((c) => !c.revokedAt)) {
      out('Já existe credencial ativa (o token só é mostrado na emissão). Para outro aparelho: credenciais criar "<nome>".');
      return 0;
    }
    showIssued(cfg, out, await call(cfg, 'POST', `/credentials?name=${enc('Stremio local')}`, doFetch));
    return 0;
  }
  if (cmd === 'rotacionar' && pos.length === 1) {
    showIssued(cfg, out, await call(cfg, 'POST', `/credentials/rotate?id=${enc(pos[0])}`, doFetch));
    out(`A credencial ${pos[0]} foi revogada.`);
    return 0;
  }
  if (cmd === 'revogar' && pos.length === 1) {
    await call(cfg, 'POST', `/credentials/revoke?id=${enc(pos[0])}`, doFetch);
    out(`Credencial ${pos[0]} revogada: as URLs dela deixam de funcionar agora, inclusive vídeos abertos.`);
    return 0;
  }
  out(USO);
  return 2;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`erro: ${err.message}`); process.exit(1); });
}

module.exports = { run, config, installUrl };
