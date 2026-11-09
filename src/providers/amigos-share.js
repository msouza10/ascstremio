// Resolve um pedido por IMDb para um .torrent da biblioteca local.
//
// O ASC não entrega IMDb no .torrent, então o casamento é por título: pega o
// nome no Cinemeta e compara com o nome do release já normalizado. Só serve
// como atalho — o caminho principal é o catálogo local do addon.

function normalize(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function titleFor(imdbId, type) {
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) return null;
  const body = await response.json();
  return body?.meta?.name ?? null;
}

async function findStreams({ type, imdbId, season, episode }, { library = [], urlFor, humanSize } = {}) {
  // Pack de série exigiria mapear temporada/episódio para arquivo; por ora só filme.
  if (type !== 'movie' || !library.length) return [];

  const title = await titleFor(imdbId, 'movie');
  if (!title) return [];

  const wanted = normalize(title);
  const entry = library.find((item) => normalize(item.title) === wanted)
    ?? library.find((item) => normalize(item.title).includes(wanted));

  if (!entry) return [];

  const fileIdx = entry.videos[0].index;
  const file = entry.files[fileIdx];

  return [{
    name: 'ASC',
    title: `${entry.title}\n${humanSize ? humanSize(file.length) : ''} · ${entry.isPrivate ? 'tracker privado' : 'tracker público'}`.trim(),
    url: urlFor(entry.infoHash, fileIdx),
    behaviorHints: {
      notWebReady: true,
      filename: file.path.split('/').pop(),
      bingeGroup: `asc-${entry.infoHash}`,
    },
  }];
}

module.exports = { findStreams, normalize };
