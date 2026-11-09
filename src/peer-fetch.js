// Coleta por info_hash: baixa usando apenas o hash, sem cookie do site,
// sem passkey e sem .torrent salvo. O tracker privado não participa.
//
// O que isso resolve: o arquivo por si só não contém a credencial; quem pega
// o magnet/hash baixa da rede pública, e o registro que sobra é o do swarm
// (IP do nó, cliente, volume) — não o de uma conta no ASC.
//
// O que isso NÃO resolve: o tracker privado continua com o log do download
// feito com a sua sessão/passkey. Anonimato perante o site não existe.

const fs = require('fs');
const path = require('path');

// Trackers públicos usados quando não se quer depender de DHT apenas.
// Trackers de terceiros mudam de status com frequência: falhas aqui são
// esperadas e não indicam erro do código.
const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];

let webTorrentModule;
function loadWebTorrent() {
  webTorrentModule ??= import('webtorrent').then((m) => m.default ?? m);
  return webTorrentModule;
}

const INFO_HASH_RE = /^[0-9a-f]{40}$/i;

// Aceita info_hash puro ou magnet e devolve { infoHash, trackers }.
function parseSource(source) {
  const input = String(source || '').trim();
  if (INFO_HASH_RE.test(input)) return { infoHash: input.toLowerCase(), trackers: [] };

  const magnet = /(?:^|\?)magnet:/.test(input) ? input : `magnet:${input}`;
  const hash = /xt=urn:btih:([0-9a-f]{40})/i.exec(magnet);
  if (!hash) throw new Error('fonte inválida: use info_hash de 40 hex ou magnet com btih');
  const tr = [...magnet.matchAll(/[?&]tr=([^&]+)/g)]
    .map((m) => decodeURIComponent(m[1].replace(/\+/g, ' ')));
  return { infoHash: hash[1].toLowerCase(), trackers: tr };
}

async function fetchByHash(source, {
  outDir = path.join(process.cwd(), 'private', 'downloads'),
  trackers = PUBLIC_TRACKERS,
  dht = true,
  timeoutMs = 5 * 60 * 1000,
  uploadLimit = -1,
  onProgress = () => {},
} = {}) {
  const { infoHash, trackers: magnetTrackers } = parseSource(source);
  const announce = [...new Set([...trackers, ...magnetTrackers])];
  if (announce.length === 0 && !dht) {
    throw new Error('sem tracker e com DHT desligado não há como descobrir peers');
  }

  const WebTorrent = await loadWebTorrent();
  fs.mkdirSync(outDir, { recursive: true });

  const client = new WebTorrent({ dht, lsd: false, utPex: false, uploadLimit, natUpnp: false, natPmp: false });
  const firstError = new Promise((resolve) => client.once('error', (err) => resolve(err)));

  const torrent = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(new Error('timeout ao resolver metadados no swarm')), timeoutMs);
    const t = client.add(infoHash, { path: outDir, announce }, (ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
    t.on('metadata', () => clearTimeout(timer));
    firstError.then((err) => { clearTimeout(timer); resolve(err); });
  });

  if (torrent instanceof Error) {
    await new Promise((r) => client.destroy(r));
    throw torrent;
  }

  const intervalo = setInterval(() => {
    onProgress({
      name: torrent.name,
      progress: Number(torrent.progress.toFixed(4)),
      downloaded: torrent.downloaded,
      uploaded: torrent.uploaded,
      peers: torrent.numPeers,
    });
  }, 5000);

  const resultado = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    torrent.on('done', () => {
      clearTimeout(timer);
      resolve({
        name: torrent.name,
        path: path.join(outDir, torrent.name),
        bytes: torrent.downloaded,
        peers: torrent.numPeers,
        timeout: false,
      });
    });
  });

  clearInterval(intervalo);
  const uploaded = torrent.uploaded;
  const peers = torrent.numPeers;
  const files = (torrent.files || []).map((f) => f.path);

  // Sai do swarm assim que termina: sem seed contínuo, sem announce pendente.
  await new Promise((r) => client.destroy(r));
  return { infoHash, uploaded, peers, files, ...resultado };
}

module.exports = { fetchByHash, parseSource, PUBLIC_TRACKERS };

if (require.main === module) {
  const [source] = process.argv.slice(2);
  if (!source) {
    console.error('uso: node src/peer-fetch.js <info_hash-ou-magnet> [pasta]');
    process.exit(1);
  }
  fetchByHash(source, {
    outDir: process.argv[3] || path.join(process.cwd(), 'private', 'downloads'),
    onProgress: (p) => console.log(`  … ${p.progress * 100}% peers=${p.peers}`),
  })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err) => {
      console.error(`falhou: ${err.message}`);
      process.exit(2);
    });
}
