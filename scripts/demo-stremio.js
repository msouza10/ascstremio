#!/usr/bin/env node
'use strict';

// Addon de demonstração para FOTOGRAFAR a tela do Stremio (issue #130) sem conta, sem ASC e sem
// credencial real. Reaproveita o addon, o provedor de fontes e a porta autenticada REAIS (assim os
// rótulos 🆓, os selos, "Pacote/Este episódio" e os avisos são os do produto); só o cliente do ASC e a
// ponte são falsos. Os vídeos apontam para um loopback onde nada escuta: a lista é fotografada, nada
// é tocado, baixado ou anunciado. Uso: node scripts/demo-stremio.js [--status]
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { getRouter } = require('stremio-addon-sdk');
const { createAddon } = require('../src/addon');
const { createAscProvider } = require('../src/asc-provider');
const { createAddonHandler } = require('../src/addon-auth');
const { CredentialStore, currentCredential, currentToken } = require('../src/credentials');
const { hostAllowed } = require('../src/safety');
const { snapshot: snapshotDoPainel } = require('./demo-capturas');

// Títulos de domínio público ou licença aberta, com o IMDb id que o Cinemeta reconhece.
const MOVIE_ID = 'tt0063350'; // Night of the Living Dead (1968), domínio público
const SERIES_ID = 'tt1748166'; // Pioneer One (2010), Creative Commons

const GB = 1024 ** 3;
// Porta 1 do loopback: nada escuta ali, então nenhuma URL de vídeo da demonstração toca em algo.
const VIDEO_BASE = 'http://127.0.0.1:1';
const PANEL_URL = 'http://127.0.0.1:7020';

const selos = (resolucao, fonte, ...extras) => [
  { label: resolucao, kind: 'resolution' }, { label: fonte, kind: 'source' },
  { label: 'Dual Áudio', kind: 'audio' }, ...extras.map((label) => ({ label, kind: 'video' })),
];

// Nomes de release inventados; o grupo "DEMO" não existe.
const MOVIE_ROWS = [
  { id: 9001, name: 'Night.of.the.Living.Dead.1968.1080p.BluRay.x264-DEMO', seeders: 42, leechers: 3, size: 7.4 * GB, timesCompleted: 311, freeleech: true, badges: selos('1080p', 'BluRay', 'x264') },
  { id: 9002, name: 'Night.of.the.Living.Dead.1968.2160p.REMUX.HEVC-DEMO', seeders: 18, leechers: 1, size: 48 * GB, timesCompleted: 94, freeleech: false, badges: selos('2160p', 'Remux', 'HEVC', 'HDR') },
  { id: 9003, name: 'Night.of.the.Living.Dead.1968.720p.WEB-DL.x264-DEMO', seeders: 2, leechers: 0, size: 2.1 * GB, timesCompleted: 12, freeleech: true, badges: selos('720p', 'WEB-DL', 'x264') },
];

const SERIES_ROWS = [
  { id: 9101, name: 'Pioneer.One.S01.1080p.WEB-DL-DEMO', seeders: 37, leechers: 2, size: 5 * GB, timesCompleted: 205, freeleech: true, badges: selos('1080p', 'WEB-DL', 'x264') },
  { id: 9102, name: 'Pioneer.One.S01E01.720p.WEB-DL-DEMO', seeders: 3, leechers: 0, size: 1.1 * GB, timesCompleted: 9, freeleech: false, badges: selos('720p', 'WEB-DL', 'x264') },
  // Formato que o addon não toca (nomes sem SxxExx): aparece como aviso quando nada mais serve.
  { id: 9103, name: 'Pioneer.One.Colecao.Legada-DEMO', seeders: 6, leechers: 0, size: 4 * GB, timesCompleted: 30, freeleech: true, badges: selos('480p', 'DVDRip') },
];

const p2 = (n) => String(n).padStart(2, '0');
const lista = (paths, size) => ({ files: paths.map((p) => ({ path: p, size })), total: paths.length, complete: true });
// Cinco episódios no pack (o sexto só existe no legado), para exercitar o aviso de "não suportado".
const SERIES_FILES = {
  9101: lista(Array.from({ length: 5 }, (_, i) => `Pioneer.One.S01.1080p.WEB-DL-DEMO/Pioneer.One.S01E${p2(i + 1)}.1080p.mkv`), 1 * GB),
  9102: lista(['Pioneer.One.S01E01.720p.mkv'], 1.1 * GB),
  9103: lista(Array.from({ length: 6 }, (_, i) => `Colecao/EP${p2(i + 1)}.avi`), 0.65 * GB),
};

// Cliente do ASC falso: só leitura, em memória. Baixar .torrent é impossível de propósito.
function fakeAsc() {
  return {
    onlyFreeleech: false, connected: true, saved: true,
    async search() { return MOVIE_ROWS; },
    async searchSeries() { return { rows: SERIES_ROWS, truncated: false }; },
    async releaseFiles(id) { return SERIES_FILES[id] ?? { files: [], total: null, complete: false }; },
    async originalLanguage() { return 'Inglês'; },
    async history() { return {}; },
    async download() { throw new Error('demonstração: nenhum .torrent é baixado'); },
  };
}

function fakeBridge() {
  return {
    entries: new Map(), vault: { get: () => null }, diskState: () => 'none', entryByAscId: () => null,
    lazyUrl: (id) => `${VIDEO_BASE}/a/${id}`,
    episodeUrl: (id, season, episode) => `${VIDEO_BASE}/e/${id}/${season}/${episode}`,
  };
}

// Instantâneo FICTÍCIO da conta para o catálogo "ASC — status": parte do usado nas capturas do
// painel e acrescenta avisos inventados para o cartão de atenção aparecer.
function statusSnapshot() {
  const dados = snapshotDoPainel();
  dados.stats = { ...dados.stats, ratio: 1.4 };
  dados.notices = ['Aviso de demonstração: reserva de disco abaixo do recomendado.'];
  dados.titles = dados.titles.map((t, i) => (i === 1
    ? { ...t, risk: 'warn', warnings: ['Seed de demonstração: faltam 18 h e o prazo termina em 2 dias.'] }
    : t));
  return dados;
}

function parseArgs(argv, env = process.env) {
  const out = { status: false, port: 0 };
  for (const arg of argv) {
    if (arg === '--status') out.status = true;
    else throw new Error(`argumento desconhecido: ${arg} (uso: demo-stremio.js [--status])`);
  }
  if (env.DEMO_STREMIO_PORT !== undefined && env.DEMO_STREMIO_PORT !== '') {
    const port = Number(env.DEMO_STREMIO_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('DEMO_STREMIO_PORT inválida (0 a 65535)');
    out.port = port;
  }
  return out;
}

async function startDemoStremio({ port = 0, status: comStatus = false } = {}) {
  // Pasta própria: nada de DATA_DIR da instalação pessoal, nada de credencial real.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-demo-stremio-'));
  const store = new CredentialStore({ file: path.join(dataDir, 'credentials.json') });
  const { token } = store.create({ name: 'demo-stremio', status: comStatus });
  const provider = createAscProvider(fakeAsc(), fakeBridge(), path.join(dataDir, 'torrents'));
  let origin = '';
  const status = comStatus ? {
    snapshot: statusSnapshot,
    // Os cartões saem sob o prefixo da credencial de quem pediu, como no addon real.
    get posterBase() { return `${origin}/${currentToken()}`; },
    panelUrl: PANEL_URL,
  } : null;
  const addon = createAddon({ remote: provider, status, statusAllowed: () => currentCredential()?.status === true });
  const handle = createAddonHandler({ addon, router: getRouter(addon), store, status });
  const server = http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host)) { res.writeHead(403); res.end(); return; }
    handle(req, res);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
  const realPort = server.address().port;
  origin = `http://127.0.0.1:${realPort}`;
  const base = `${origin}/${token}`;
  return {
    server, dataDir, port: realPort, base, manifestUrl: `${base}/manifest.json`,
    close: () => new Promise((resolve) => {
      server.close(() => { fs.rmSync(dataDir, { recursive: true, force: true }); resolve(); });
      server.closeAllConnections();
    }),
  };
}

async function main() {
  const opcoes = parseArgs(process.argv.slice(2));
  const demo = await startDemoStremio(opcoes);
  console.log('Addon de demonstração do Stremio (dados fictícios, só neste computador).');
  console.log(`Instale no Stremio (addon da comunidade): ${demo.manifestUrl}`);
  console.log(`Filme: ${MOVIE_ID} (Night of the Living Dead) · Série: ${SERIES_ID} (Pioneer One; S01E01 tem fontes, S01E06 mostra o aviso)`);
  if (opcoes.status) console.log('Catálogo "ASC — status" ligado, com instantâneo fictício.');
  console.log('As fontes apontam para um endereço sem serviço: só a lista é fotografada. Ctrl+C encerra e apaga a pasta temporária.');
  const fechar = () => demo.close().then(() => process.exit(0));
  process.once('SIGINT', fechar);
  process.once('SIGTERM', fechar);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { startDemoStremio, parseArgs, MOVIE_ID, SERIES_ID, MOVIE_ROWS, SERIES_ROWS };
