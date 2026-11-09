// Biblioteca local: lê os .torrent do ASC já baixados e expõe o que o addon
// precisa (info hash, nome, tamanho, arquivos de vídeo).
//
// Por que a partir do arquivo, e não do info hash: o Stremio não aceita .torrent
// de tracker privado, e sem o arquivo o motor teria que buscar metadados no
// swarm. Com o arquivo em mãos a ponte sobe instantânea e respeita a flag
// `private` do próprio torrent.

const fs = require('fs');
const path = require('path');
const { announceBaseOf } = require('./passkey');

const VIDEO_EXT = new Set([
  '.mkv', '.mp4', '.m4v', '.avi', '.mov', '.ts', '.m2ts', '.webm', '.wmv', '.mpg', '.mpeg',
]);

let parseTorrentModule;
function parseTorrent() {
  // parse-torrent é ESM; carrega uma vez e reutiliza.
  parseTorrentModule ??= import('parse-torrent').then((m) => m.default ?? m);
  return parseTorrentModule;
}

function isVideo(filePath) {
  return VIDEO_EXT.has(path.extname(filePath).toLowerCase());
}

// O filme de um release: o vídeo que DOMINA o torrent. Releases normais trazem
// extras pequenos (making-of, entrevistas, trailers) em .mkv ao lado do filme, e
// isso não os torna packs. Vários vídeos de tamanho parecido (trilogia, coleção,
// CD1/CD2) continuam sem filme principal. Devolve o arquivo ou null.
function mainVideo(files) {
  const videos = (files ?? []).filter((f) => f.isVideo).sort((a, b) => b.length - a.length);
  if (videos.length === 0) return null;
  if (videos.length === 1) return videos[0];
  const total = videos.reduce((sum, f) => sum + f.length, 0);
  const [first, second] = videos;
  return first.length >= 0.7 * total && first.length >= 4 * second.length ? first : null;
}

// Nome legível para a lista do Stremio, a partir do nome do release.
function displayName(entry) {
  const base = (mainVideo(entry.files) ?? entry.files.find((f) => f.isVideo))?.path ?? entry.name;
  return path.basename(base, path.extname(base)).replace(/[._]+/g, ' ').trim();
}

async function readTorrent(torrentPath) {
  const parse = await parseTorrent();
  const buffer = fs.readFileSync(torrentPath);
  const parsed = await parse(buffer);

  const files = (parsed.files ?? []).map((file, index) => {
    // Em torrent de arquivo único, parse-torrent devolve um item com path = name.
    const filePath = Array.isArray(file.path) ? file.path.join('/') : String(file.path ?? parsed.name);
    return {
      index,
      path: filePath,
      length: file.length,
      isVideo: isVideo(filePath),
    };
  });

  if (files.length === 0) {
    files.push({ index: 0, path: parsed.name, length: parsed.length, isVideo: isVideo(parsed.name) });
  }

  const announces = [].concat(parsed.announce ?? []).map(String);
  return {
    infoHash: parsed.infoHash,
    torrentPath,
    name: parsed.name,
    size: parsed.length,
    isPrivate: Boolean(parsed.private),
    trackers: announces.length,
    // Base do announce sem token: é só o host/rota do tracker. Serve para
    // reinjetar a passkey em memória no momento de abrir o torrent.
    announceBase: announceBaseOf(announces[0]),
    files,
  };
}

// Entrada de `readTorrent` -> entrada do catálogo (id, título, vídeos, tipo), ou null se o torrent
// não tem vídeo. Filme = um vídeo que domina o torrent (extras pequenos não contam); pack = vários
// de tamanho parecido (série/temporada). Também serve a torrents baixados depois da partida.
function describeEntry(entry) {
  const allVideos = (entry?.files ?? []).filter((f) => f.isVideo);
  if (allVideos.length === 0) return null;
  const main = mainVideo(entry.files);
  return {
    ...entry,
    id: `asc:${entry.infoHash}`,
    title: displayName(entry),
    videos: main ? [main] : allVideos,
    kind: main ? 'movie' : 'series',
  };
}

// Varre o diretório e monta o catálogo. Arquivos ilegíveis são ignorados com
// aviso, sem derrubar o addon.
async function loadLibrary(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const entries = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.torrent')) continue;
    const full = path.join(dir, name);
    try {
      const entry = await readTorrent(full);
      const described = describeEntry(entry);
      if (!described) continue; // sem vídeo: não interessa ao player
      entries.push(described);
    } catch {
      console.error(`[library] ignorado (não foi possível ler): ${path.basename(full)}`);
    }
  }

  entries.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  return entries;
}

module.exports = { loadLibrary, describeEntry, readTorrent, isVideo, mainVideo };
