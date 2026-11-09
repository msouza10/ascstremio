const { addonBuilder } = require('stremio-addon-sdk');
const amigosShare = require('./providers/amigos-share');
const log = require('./logger').logger.child('addon');
const statusKit = require('./stremio-status');

const CATALOG_ID = 'asc';

function parseVideoId(type, id) {
  if (type === 'movie' && /^tt\d+$/.test(id)) return { type, imdbId: id };
  if (type === 'series') {
    const match = /^(tt\d+):(\d+):(\d+)$/.exec(id);
    if (match) {
      const season = Number(match[2]);
      const episode = Number(match[3]);
      if (Number.isSafeInteger(season) && Number.isSafeInteger(episode) && episode > 0) {
        return { type, imdbId: match[1], season, episode };
      }
    }
  }
  return null;
}

// Ids do catálogo local: asc:<infoHash> (filme) ou asc:<infoHash>:<fileIdx>.
function parseLocalId(id) {
  const match = /^asc:([0-9a-f]{40})(?::(\d+))?$/.exec(String(id));
  if (!match) return null;
  return { infoHash: match[1], fileIdx: match[2] === undefined ? null : Number(match[2]) };
}

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// Pôster é opcional: busca no Cinemeta pelo nome e ignora qualquer falha.
let cinemetaCache = new Map();
async function findPoster(title, type = 'movie') {
  const key = `${type}:${title}`;
  if (cinemetaCache.has(key)) return cinemetaCache.get(key);
  let poster = null;
  try {
    const url = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(title)}.json`;
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (response.ok) {
      const body = await response.json();
      const first = body?.metas?.[0];
      if (first?.poster) poster = first.poster;
    }
  } catch {
    // sem rede ou sem resultado: segue sem pôster
  }
  cinemetaCache.set(key, poster);
  return poster;
}

// `localEntries` (opcional): função que devolve a biblioteca ATUAL (inclui o que foi baixado depois
// da partida), cada item com `disk` ('full' | 'partial' | 'none'). Sem ela vale o `library` fixo.
// `status` (opcional): { snapshot(), posterBase, panelUrl } — liga o catálogo "ASC — status".
function createAddon({ provider = amigosShare, demo = false, library = [], localEntries = null, bridgeUrl = null, remote = null, status = null, statusAllowed = () => true } = {}) {
  // `statusAllowed` decide por requisição se o cliente enxerga ratio/avisos de status. Em produção
  // o index.js liga isso à credencial (negado por padrão); o padrão aberto serve só aos testes.
  const showStatus = () => Boolean(status) && statusAllowed();
  // Item sem nenhum dado em disco (arquivo removido) não é anunciado como disponível.
  const currentLibrary = () => (localEntries ? localEntries().filter((entry) => entry.disk !== 'none') : library);
  const findLocal = (infoHash) => currentLibrary().find((entry) => entry.infoHash === infoHash);
  const urlFor = bridgeUrl ?? ((infoHash, idx) => `http://127.0.0.1:7010/s/${infoHash}/${idx}`);

  const builder = new addonBuilder({
    id: 'local.amigosshare.stremio',
    version: '0.4.0',
    name: 'ASC — biblioteca local',
    description: 'Reproduz os .torrent do ASC direto no Stremio, por streaming sob demanda.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['asc:', 'ascfilm:', 'tt', ...(status ? [statusKit.STATUS_PREFIX] : [])],
    catalogs: [
      ...(status ? [{ type: 'movie', id: 'asc-status', name: 'ASC — status' }] : []),
      ...(remote ? [{ type: 'movie', id: 'asc-online', name: 'ASC — filmes', extra: [{ name: 'search', isRequired: false }] }] : []),
      { type: 'movie', id: CATALOG_ID, name: 'ASC (local)' },
      { type: 'series', id: CATALOG_ID, name: 'ASC (local)' },
    ],
    behaviorHints: { adult: false },
  });

  // Itens de status vêm do estado atual da ponte; falha de leitura não derruba o catálogo.
  const statusItems = () => {
    try { return statusKit.buildItems(status.snapshot(), { panelUrl: status.panelUrl }); } catch (err) { log.warn(`status indisponível: ${err?.message ?? err}`); return []; }
  };
  // Aviso de fontes online indisponíveis. Só abre o painel (externalUrl); não promete nada além
  // dos arquivos locais completos listados abaixo dele.
  const offlineNotice = (offline, locais) => {
    return [{
      name: '⚠ ASC indisponível',
      description: `Fontes online indisponíveis: ${offline.message}.\n${locais ? `Abaixo, ${locais} arquivo(s) já baixado(s) neste computador.` : 'Nenhum arquivo deste filme está completo neste computador.'}\nToque para abrir o ${showStatus() && status.panelUrl ? 'painel' : 'site'}.`,
      // Painel só para quem pode ver o status; para os demais, o próprio site (sem dado da conta).
      externalUrl: showStatus() && status.panelUrl ? `${status.panelUrl}/` : 'https://amigos-share.club/',
    }];
  };
  // Aviso de risco crítico no topo das fontes de filmes ASC.
  const withAlert = (streams) => {
    if (!showStatus() || !Array.isArray(streams)) return streams;
    try { const a = statusKit.alertStream(status.snapshot(), status.panelUrl); return a ? [a, ...streams] : streams; } catch { return streams; }
  };

  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    log.debug(`catálogo pedido: ${type}/${id}${extra?.search ? ' (com busca)' : ''}`);
    if (type === 'movie' && id === 'asc-status') {
      return showStatus() ? { metas: statusKit.catalogMetas(statusItems(), status.posterBase), cacheMaxAge: 0 } : { metas: [], cacheMaxAge: 0 };
    }
    if (remote && type === 'movie' && id === 'asc-online') {
      // ASC fora do ar não derruba o catálogo: lista vazia (o motivo aparece nas fontes por IMDb).
      try { return { metas: await remote.catalog(extra?.search || ''), cacheMaxAge: 0 }; } catch (err) {
        log.warn(`catálogo online indisponível: ${err?.message ?? err}`);
        return { metas: [], cacheMaxAge: 0 };
      }
    }
    const metas = currentLibrary()
      .filter((entry) => entry.kind === type)
      .map((entry) => ({
        id: entry.id,
        type,
        name: entry.title,
        description: `${humanSize(entry.size)} · teste de streaming ASC · ${entry.videos.length} arquivo(s)${entry.disk === 'partial' ? ' · incompleto neste computador' : ''}`,
      }));

    return { metas, cacheMaxAge: 0 };
  });

  builder.defineMetaHandler(async ({ type, id }) => {
    log.debug(`meta pedido: ${type}/${id}`);
    if (String(id).startsWith(statusKit.STATUS_PREFIX)) return showStatus() ? { meta: statusKit.metaFor(statusItems(), id, status.posterBase), cacheMaxAge: 0 } : { meta: null };
    if (remote && type === 'movie' && /^ascfilm:\d+$/.test(id)) return { meta: remote.meta(id.slice(8)) };
    const local = parseLocalId(id);
    if (local) {
      const entry = findLocal(local.infoHash);
      if (!entry) return { meta: null };

      const poster = await findPoster(entry.title, type);
      const meta = {
        id: entry.id,
        type,
        name: entry.title,
        description: `${entry.name}\n${humanSize(entry.size)} · streaming ASC`,
        ...(poster ? { poster } : {}),
      };

      // Pack com vários episódios: cada arquivo vira um vídeo selecionável.
      if (entry.videos.length > 1) {
        meta.videos = entry.videos.map((file, i) => ({
          id: `${entry.id}:${file.index}`,
          title: file.path.split('/').pop(),
          season: 1,
          episode: i + 1,
        }));
      }

      return { meta };
    }

    return { meta: null };
  });

  builder.defineStreamHandler(async ({ type, id }) => {
    log.debug(`stream pedido pelo Stremio: ${type}/${id}`);
    if (String(id).startsWith(statusKit.STATUS_PREFIX)) return { streams: showStatus() ? statusKit.statusStreams(status.panelUrl) : [], cacheMaxAge: 0 };
    if (remote && type === 'movie' && /^ascfilm:\d+$/.test(id)) return { streams: withAlert(await remote.streamsFor(id.slice(8))), cacheMaxAge: 0 };
    // 1) Item do catálogo local: caminho principal.
    const local = parseLocalId(id);
    if (local) {
      const entry = findLocal(local.infoHash);
      if (!entry) return { streams: [], cacheMaxAge: 0 };

      const fileIdx = local.fileIdx ?? entry.videos[0].index;
      if (!entry.videos.some(file => file.index === fileIdx)) return { streams: [], cacheMaxAge: 0 };
      const file = entry.files[fileIdx];
      const filename = file?.path?.split('/').pop() ?? entry.name;

      return {
        streams: [{
          name: 'ASC',
          title: `${entry.title}\n${humanBytesFor(file?.length ?? entry.size)} · streaming ASC`,
          url: urlFor(entry.infoHash, fileIdx),
          behaviorHints: {
            // http:// e MKV: sem isso o player web recusa a fonte.
            notWebReady: true,
            filename,
            bingeGroup: `asc-${entry.infoHash}`,
          },
        }],
        cacheMaxAge: 0,
      };
    }

    // 2) Pedido por IMDb: só se houver .torrent correspondente na biblioteca.
    const video = parseVideoId(type, id);
    if (video && !demo) {
      try {
        if (remote?.lookup) {
          // Com o ASC indisponível, `lookup` cai para os arquivos locais completos e diz por quê.
          const { streams, offline } = await remote.lookup(video);
          const shown = offline ? [...offlineNotice(offline, streams.length), ...streams] : streams;
          return { streams: withAlert(shown), cacheMaxAge: 0 };
        }
        const streams = remote ? await remote.findStreams(video) : await provider.findStreams(video, { library: currentLibrary(), urlFor, humanSize });
        if (Array.isArray(streams)) return { streams: remote ? withAlert(streams) : streams, cacheMaxAge: 0 };
      } catch (err) {
        // O corpo das respostas do provedor não vai ao log; só o motivo (o logger ainda redige segredos).
        log.warn(`falha ao consultar streams de ${type}/${id}: ${err?.message ?? err}`);
      }
    }

    if (demo && type === 'movie' && id === 'tt1254207') {
      return {
        streams: [{
          name: 'Demonstração',
          description: 'Big Buck Bunny — vídeo público de teste',
          url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
          behaviorHints: { filename: 'BigBuckBunny.mp4' },
        }],
        cacheMaxAge: 0,
      };
    }

    return { streams: [], cacheMaxAge: 0 };
  });

  return builder.getInterface();
}

function humanBytesFor(bytes) {
  return humanSize(bytes);
}

module.exports = { createAddon, parseVideoId, parseLocalId, humanSize };
