#!/usr/bin/env node
// Benchmark OFFLINE de reprodução e seek (issue #33). Mede ANTES de ajustar antecipação de leitura ou
// timeouts; não altera nada disso. Roda sob demanda (`npm run bench:reproducao`), nunca no CI normal.
//
// Monta, só em loopback e em diretórios temporários, um swarm de dois clientes WebTorrent:
//   semeador  semeia um arquivo SINTÉTICO (bytes pseudoaleatórios gerados na hora), com taxa de upload
//             limitada (--seed-rate-kib) e conexão opcionalmente atrasada (--connect-delay-ms);
//   ponte     a Bridge REAL do projeto, que abre o torrent e serve HTTP com Range;
//   player    um cliente HTTP que lê a ponte em Range sequencial e com saltos (seeks) e fecha cada resposta
//             depois de --read-mib, como um player faz ao saltar.
// Não usa rede externa, conta, passkey, tracker nem torrent real. Veja docs/manutencao.md (como ler).
//
// Exemplos:
//   npm run bench:reproducao
//   npm run bench:reproducao -- --size-mib 128 --seed-rate-kib 4096,1024,256 --pattern seeks --seeks 4
//   npm run bench:reproducao -- --format table --connect-delay-ms 3000 --first-byte-timeout-ms 2000

'use strict';

// Saída útil só em stdout (JSON/tabela): o ruído da ponte e do motor vai para stderr.
if (require.main === module) {
  console.log = console.error;
  console.info = console.error;
  process.env.LOG_LEVEL ??= 'error';
}

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const MiB = 1024 * 1024;
const DEFAULTS = {
  'size-mib': 64, // tamanho do arquivo sintético
  'piece-kib': 256, // tamanho de peça do torrent
  'seed-rate-kib': '0', // upload do semeador em KiB/s (0 = sem limite); lista separada por vírgula = uma rodada cada
  pattern: 'seeks', // sequential = um Range aberto; seeks = o primeiro + saltos
  seeks: 3, // quantidade de saltos (pattern seeks)
  'read-mib': 8, // quanto o player lê em cada Range antes de fechar
  'connect-delay-ms': 0, // atraso até o semeador "aparecer" (simula peers ausentes)
  'first-byte-timeout-ms': 30000, // timeout do primeiro trecho da ponte (o padrão real é 60000)
  'client-timeout-ms': 60000, // o player simulado desiste de um Range sem resposta depois disso (status 0)
  'stall-ms': 1000, // limite que a medição usa para chamar uma espera de stall
  'seed-value': 1, // semente do gerador pseudoaleatório (mesmos saltos e mesmos bytes)
  format: 'json', // json | table
  out: '', // grava o resultado também neste arquivo
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m || !(m[1] in DEFAULTS)) throw new Error(`opção desconhecida: ${a}`);
    const raw = m[2] ?? argv[++i];
    if (raw === undefined) throw new Error(`falta o valor de --${m[1]}`);
    opts[m[1]] = typeof DEFAULTS[m[1]] === 'number' ? Number(raw) : raw;
    if (typeof DEFAULTS[m[1]] === 'number' && !Number.isFinite(opts[m[1]])) throw new Error(`valor inválido em --${m[1]}: ${raw}`);
  }
  if (!['json', 'table'].includes(opts.format)) throw new Error('--format deve ser json ou table');
  if (!['sequential', 'seeks'].includes(opts.pattern)) throw new Error('--pattern deve ser sequential ou seeks');
  if (opts['size-mib'] < 2 || opts['read-mib'] <= 0) throw new Error('--size-mib >= 2 e --read-mib > 0');
  return opts;
}

// xorshift32: determinístico e barato. Os bytes (incompressíveis) e os saltos dependem só da semente.
function prng(seed) {
  let x = (seed >>> 0) || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
}

function writeSynthetic(file, bytes, seed) {
  const next = prng(seed);
  const fd = fs.openSync(file, 'w');
  try {
    const buf = Buffer.alloc(MiB);
    for (let done = 0; done < bytes; done += buf.length) {
      for (let i = 0; i < buf.length; i += 4) buf.writeUInt32LE(next(), i);
      fs.writeSync(fd, buf, 0, Math.min(buf.length, bytes - done));
    }
  } finally { fs.closeSync(fd); }
}

function unionBytes(steps) {
  const ranges = steps.map((s) => [s.start, s.start + s.bytes]).sort((a, b) => a[0] - b[0]);
  let total = 0; let end = -1;
  for (const [a, b] of ranges) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lê `limit` bytes de um Range e fecha (o player fechou ou saltou). Mede no lado do cliente.
function readRange(port, urlPath, start, limit, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let firstByteMs = null; let bytes = 0; let status = 0; let finished = false;
    const done = (extra = {}) => {
      if (finished) return;
      finished = true;
      const total = performance.now() - t0;
      const streamMs = firstByteMs === null ? 0 : total - firstByteMs;
      resolve({
        start, status, bytes, firstByteMs: firstByteMs === null ? null : Math.round(firstByteMs),
        totalMs: Math.round(total), mibPerS: streamMs > 0 ? Number((bytes / MiB / (streamMs / 1000)).toFixed(2)) : null, ...extra,
      });
    };
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false, headers: { Range: `bytes=${start}-` } }, (res) => {
      status = res.statusCode;
      res.on('data', (chunk) => {
        if (firstByteMs === null) firstByteMs = performance.now() - t0;
        bytes += chunk.length;
        if (bytes >= limit) { res.destroy(); done(); }
      });
      res.on('end', () => done());
      res.on('close', () => done());
      res.on('error', () => done());
    });
    req.on('error', () => done({ error: true }));
    setTimeout(() => { if (!finished) { req.destroy(); done({ timedOut: true }); } }, timeoutMs).unref();
  });
}

async function runOnce(opts, seedRateKiB) {
  const { Bridge } = require('../src/bridge');
  const { SeedVault } = require('../src/seedvault');
  const { CredentialStore } = require('../src/credentials');
  const WebTorrent = (await import('webtorrent')).default;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-reproducao-'));
  const torrentDir = path.join(root, 'torrents');
  const storeDir = path.join(root, 'store');
  fs.mkdirSync(torrentDir); fs.mkdirSync(storeDir);
  const file = path.join(root, 'sintetico.mkv');
  const sizeBytes = Math.round(opts['size-mib'] * MiB);
  writeSynthetic(file, sizeBytes, opts['seed-value']);

  const quiet = { dht: false, lsd: false, utPex: false, natUpnp: false, natPmp: false, tracker: false, torrentPort: 0 };
  const seeder = new WebTorrent({ ...quiet, uploadLimit: seedRateKiB > 0 ? Math.round(seedRateKiB * 1024) : -1 });
  seeder.on('error', () => {});
  let bridge = null; let rssMax = 0; let sampler = null;
  try {
    await new Promise((resolve) => seeder.once('listening', resolve));
    const torrent = await new Promise((resolve) => seeder.seed(file, { announce: [], pieceLength: opts['piece-kib'] * 1024, private: false }, resolve));
    fs.writeFileSync(path.join(torrentDir, 'asc-1.torrent'), torrent.torrentFile);
    const infoHash = torrent.infoHash;

    const credentials = new CredentialStore({ file: path.join(root, 'credentials.json') });
    const { token } = credentials.create({ name: 'bench' });
    bridge = new Bridge({
      torrentDir, storeDir, port: 0, publicUrl: 'http://127.0.0.1/', credentials,
      vault: new SeedVault({ file: path.join(root, 'vault.json') }),
      firstByteTimeoutMs: opts['first-byte-timeout-ms'],
      streamMetrics: { stallMs: opts['stall-ms'] },
      freeSpace: () => ({ free: 1e15, total: 1e15 }), // o benchmark não depende do disco livre da máquina
      resumeOnStart: false,
    });
    await bridge.start();
    const port = bridge.server.address().port;
    bridge.client.on('torrent', (t) => {
      const connect = () => { try { t.addPeer(`127.0.0.1:${seeder.torrentPort}`); } catch { /* torrent já destruído */ } };
      if (opts['connect-delay-ms'] > 0) setTimeout(connect, opts['connect-delay-ms']).unref?.(); else connect();
    });

    const urlPath = `/s/${infoHash}/0?k=${token}`;
    sampler = setInterval(() => { rssMax = Math.max(rssMax, process.memoryUsage().rss); }, 100);
    const t0 = performance.now();

    // HEAD nunca baixa nem abre o torrent.
    await new Promise((resolve) => http.request({ host: '127.0.0.1', port, path: urlPath, method: 'HEAD', agent: false }, (r) => { r.resume(); r.on('end', resolve); }).end());
    const afterHead = (bridge.client.torrents[0]?.downloaded) ?? 0;

    // Plano de leituras: início e (opcionalmente) saltos alternando frente/trás, alinhados a 1 MiB.
    const read = Math.round(opts['read-mib'] * MiB);
    const next = prng(opts['seed-value'] + 7);
    const starts = [0];
    if (opts.pattern === 'seeks') {
      const slots = Math.max(1, Math.floor((sizeBytes - read) / MiB));
      for (let i = 0; i < opts.seeks; i++) {
        const prev = starts[starts.length - 1];
        let pos = (next() % slots) * MiB;
        if (Math.abs(pos - prev) < 8 * MiB) pos = (prev + sizeBytes / 2) % (slots * MiB) | 0; // garante um salto de verdade
        starts.push(Math.floor(pos / MiB) * MiB);
      }
    }
    const steps = [];
    for (const start of starts) steps.push(await readRange(port, urlPath, start, read, opts['client-timeout-ms']));
    const wallMs = performance.now() - t0;

    // Depois que o player fecha, o download não pode continuar (sem prefetch indefinido).
    await sleep(500);
    const t = bridge.client.torrents[0];
    const closedA = t?.downloaded ?? 0;
    await sleep(2000);
    const closedB = t?.downloaded ?? 0;

    const servido = steps.reduce((s, x) => s + x.bytes, 0);
    // Bytes DISTINTOS lidos pelo player (união dos intervalos): reler um trecho já baixado não gera rede.
    const unicos = unionBytes(steps);
    const ttfb = steps.map((s) => s.firstByteMs).filter((v) => v !== null).sort((a, b) => a - b);
    const snap = bridge.snapshot().streaming;
    return {
      params: {
        sizeMiB: opts['size-mib'], pieceKiB: opts['piece-kib'], seedRateKiB, pattern: opts.pattern, seeks: opts.pattern === 'seeks' ? opts.seeks : 0,
        readMiB: opts['read-mib'], connectDelayMs: opts['connect-delay-ms'], firstByteTimeoutMs: opts['first-byte-timeout-ms'], clientTimeoutMs: opts['client-timeout-ms'], stallMs: opts['stall-ms'], seedValue: opts['seed-value'],
      },
      env: { node: process.version, platform: process.platform, cpus: os.cpus().length },
      result: {
        wallMs: Math.round(wallMs),
        responses: steps.length,
        statuses: steps.map((s) => s.status),
        servedMiB: Number((servido / MiB).toFixed(2)),
        meanMiBps: Number((servido / MiB / (wallMs / 1000)).toFixed(2)),
        clientFirstByteMs: { p50: pct(ttfb, 0.5), p95: pct(ttfb, 0.95), max: ttfb.at(-1) ?? null },
        // Medido pela própria ponte (src/stream-metrics.js): é o que o painel/log mostram em produção.
        bridge: {
          timeouts504: snap.timeouts504, stalls: snap.stalls.count, stallMaxMs: snap.stalls.maxMs, stallP95Ms: snap.stalls.p95Ms, stallTotalMs: snap.stalls.totalMs,
          firstByteP50Ms: snap.firstByte.p50Ms, firstByteP95Ms: snap.firstByte.p95Ms, kinds: snap.kinds, outcomes: snap.outcomes,
        },
        downloadedMiB: Number(((t?.downloaded ?? 0) / MiB).toFixed(2)),
        extraMiB: Number((((t?.downloaded ?? 0) - unicos) / MiB).toFixed(2)), // baixado da rede além dos bytes distintos que o player leu
        headDownloadedBytes: afterHead,
        downloadedAfterCloseBytes: closedB - closedA,
        rssMaxMiB: Number((rssMax / MiB).toFixed(1)), // do processo inteiro (semeador + ponte + player), não só da ponte
      },
      steps,
    };
  } finally {
    if (sampler) clearInterval(sampler);
    if (bridge) { bridge.server?.closeAllConnections?.(); await bridge.stop().catch(() => {}); }
    await new Promise((resolve) => seeder.destroy(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function table(runs) {
  const cols = [
    ['seed KiB/s', (r) => r.params.seedRateKiB || 'livre'],
    ['padrão', (r) => `${r.params.pattern}${r.params.seeks ? `+${r.params.seeks}` : ''}`],
    ['1º byte p50/p95 ms', (r) => `${r.result.bridge.firstByteP50Ms ?? '-'}/${r.result.bridge.firstByteP95Ms ?? '-'}`],
    ['stalls', (r) => r.result.bridge.stalls],
    ['stall máx ms', (r) => r.result.bridge.stallMaxMs],
    ['504 (ponte)', (r) => r.result.bridge.timeouts504],
    ['status no player', (r) => r.result.statuses.join(',')],
    ['MiB/s', (r) => r.result.meanMiBps],
    ['extra MiB', (r) => r.result.extraMiB],
    ['após fechar (2 s) B', (r) => r.result.downloadedAfterCloseBytes],
    ['RSS máx MiB', (r) => r.result.rssMaxMiB],
  ];
  const rows = [cols.map((c) => c[0]), ...runs.map((r) => cols.map((c) => String(c[1](r))))];
  const w = cols.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(w[i])).join('  ')).join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.error(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    console.error('\nOpções (padrão):'); for (const [k, v] of Object.entries(DEFAULTS)) console.error(`  --${k} (${JSON.stringify(v)})`);
    return;
  }
  const rates = String(opts['seed-rate-kib']).split(',').map((s) => Number(s.trim()));
  if (rates.some((n) => !Number.isFinite(n) || n < 0)) throw new Error('--seed-rate-kib: números >= 0 separados por vírgula');
  const runs = [];
  for (const rate of rates) runs.push(await runOnce(opts, rate));
  const text = opts.format === 'table' ? table(runs) : JSON.stringify(runs.length === 1 ? runs[0] : runs, null, 2);
  if (opts.out) fs.writeFileSync(opts.out, `${text}\n`);
  process.stdout.write(`${text}\n`);
}

if (require.main === module) {
  main().then(() => process.exit(0), (err) => { console.error(`bench: ${err.message}`); process.exit(1); });
}

module.exports = { parseArgs, prng, pct };
