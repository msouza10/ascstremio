// Identidade de episódios a partir dos nomes de arquivo de um .torrent.
//
// Por que existe: o ASC mistura episódio avulso, temporada e série completa, e a ordem da página
// do site NÃO é o índice do torrent. Aqui só se lê o nome do arquivo; o índice devolvido é sempre
// o real (`file.index`), nunca uma posição de lista. Na dúvida (nomes que se contradizem, pasta
// de outra temporada, vários SxxExx no mesmo nome) devolve null: ambiguidade recusa o mapeamento
// automático em vez de adivinhar. Também não converte numeração de release para a do player
// (S23E1180 do One Piece não é o 23:25 do Cinemeta): extrai o que está escrito, e só isso.

// S01E07, S01.E07, S01 E07, S23E1180 e duplo (S01E01E02, S01E01-E02, S01E01-02). O segundo número
// só vale com "E" ou com hífen colado e sem virar resolução (`.1080p` e `-720p` não são episódio).
const EPISODE = /(?<![a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,4})(?:[ ._-]?e(\d{1,4})|-(\d{1,3})(?![0-9pi]))?(?![0-9])/gi;
// Pastas: "Temporada 02", "Season 2", "S02".
const SEASON_DIR = /^(?:(?:temporada|season)[ ._-]*(\d{1,2})|s(\d{1,2}))$/i;
const MAX_DOUBLE = 20; // E01-E40 não é episódio duplo, é outra coisa

function pathParts(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
}

// Temporada declarada pelas pastas do caminho, ou null se nenhuma diz nada.
// Pastas que declaram temporadas diferentes entre si também contam como ambíguas.
function seasonFromFolders(parts) {
  const seasons = new Set();
  for (const dir of parts.slice(0, -1)) {
    const match = SEASON_DIR.exec(dir.trim());
    if (match) seasons.add(Number(match[1] ?? match[2]));
  }
  if (seasons.size === 0) return { season: null };
  return seasons.size === 1 ? { season: [...seasons][0] } : { conflict: true };
}

// `{ season, episode, episodeEnd?, confidence, source }` ou null.
// `confidence`: 'alta' quando uma pasta de temporada confirma o nome do arquivo; 'media' quando
// só o nome do arquivo diz (caso comum de release de episódio avulso).
function parseEpisode(filePath) {
  const parts = pathParts(filePath);
  const name = parts.at(-1);
  if (!name) return null;

  const matches = [...name.matchAll(EPISODE)];
  if (matches.length !== 1) return null; // nenhum ou vários SxxExx: ambíguo

  const [, s, e, endE, endDash] = matches[0];
  const season = Number(s);
  const episode = Number(e);
  if (!(episode > 0)) return null;

  let episodeEnd;
  const end = endE ?? endDash;
  if (end !== undefined) {
    episodeEnd = Number(end);
    if (!(episodeEnd > episode) || episodeEnd - episode > MAX_DOUBLE) return null;
  }

  const folders = seasonFromFolders(parts);
  if (folders.conflict) return null;
  if (folders.season !== null && folders.season !== season) return null; // pasta e arquivo discordam

  return {
    season,
    episode,
    ...(episodeEnd ? { episodeEnd } : {}),
    confidence: folders.season === null ? 'media' : 'alta',
    source: 'arquivo',
  };
}

function episodeKey(season, episode) {
  return `${season}:${episode}`;
}

// Índice dos vídeos de um torrent. `files` vem de `readTorrent` (`{ index, path, length, isVideo }`).
// Estrutura simples (sem Map), porque entra na entrada da biblioteca e pode ser serializada.
//   episodes:  vídeos com identidade, no índice REAL do torrent (episódio duplo tem episodeEnd)
//   conflicts: chaves "T:E" que mais de um arquivo diz ser (releases com versões misturadas)
//   unmatched: índices de vídeos sem identidade segura (pasta legada, nome ambíguo, extras)
//   auxiliary: índices dos que não são vídeo (imagens, legendas, nfo)
function buildEpisodeIndex(files) {
  const episodes = [];
  const unmatched = [];
  const auxiliary = [];
  const owners = new Map(); // chave -> índices dos arquivos que a reivindicam

  for (const file of files ?? []) {
    if (!file.isVideo) { auxiliary.push(file.index); continue; }
    const id = parseEpisode(file.path);
    if (!id) { unmatched.push(file.index); continue; }
    episodes.push({ index: file.index, path: file.path, length: file.length, ...id });
    const last = id.episodeEnd ?? id.episode;
    for (let n = id.episode; n <= last; n += 1) {
      const key = episodeKey(id.season, n);
      owners.set(key, [...(owners.get(key) ?? []), file.index]);
    }
  }

  const conflicts = [...owners].filter(([, list]) => new Set(list).size > 1).map(([key]) => key);
  return { episodes, conflicts, unmatched, auxiliary };
}

// Arquivo de um episódio: `{ file }`, `{ conflict: true }` (mais de um candidato: recusar) ou null.
function findEpisode(index, season, episode) {
  const key = episodeKey(season, episode);
  if (index?.conflicts?.includes(key)) return { conflict: true };
  const file = (index?.episodes ?? []).find((f) => f.season === season
    && episode >= f.episode && episode <= (f.episodeEnd ?? f.episode));
  return file ? { file } : null;
}

// ---- Escopo declarado no NOME do release (antes de ler a lista de arquivos) ----------------------
// Serve para poupar consultas: "Show S02" não pode ser a fonte de S01E03. Só descarta o que o nome
// contradiz com clareza; nome sem escopo, com intervalo de temporadas ("S01-S05") ou ambíguo fica
// como candidato, e quem decide é a lista de arquivos. O nome é do uploader e pode estar errado,
// por isso isto nunca AFIRMA que o episódio existe.
const ANY_EPISODE = /(?<![a-z0-9])s\d{1,2}[ ._-]?e\d/i;
const SEASON_ONLY = /(?<![a-z0-9])s(\d{1,2})(?![0-9a-z])/gi;
const SEASON_WORD = /(?:temporada|season)[ ._-]*(\d{1,2})(?![0-9])|(?<![0-9])(\d{1,2})\s*[ªº]?\s*temporada/gi;
// Resolução (`1080p`, `720p`) colada ao hífen não é fim de intervalo: `(?![0-9pi])`.
const SEASON_RANGE = /(?<![a-z0-9])s\d{1,2}\s*[-–~]\s*s?\d{1,2}(?![0-9a-z])|temporadas?\s*\d{1,2}\s*(?:[-–~]|a|ao|e)\s*\d{1,2}(?![0-9pi])/i;

// `{ season, episode, episodeEnd? }` (episódio), `{ season, episode: null }` (temporada) ou null (não diz).
function scopeOfName(name) {
  const text = String(name ?? '');
  if (SEASON_RANGE.test(text)) return null;
  if (ANY_EPISODE.test(text)) {
    const id = parseEpisode(text);
    return id ? { season: id.season, episode: id.episode, ...(id.episodeEnd ? { episodeEnd: id.episodeEnd } : {}) } : null;
  }
  const seasons = new Set();
  for (const m of text.matchAll(SEASON_ONLY)) seasons.add(Number(m[1]));
  for (const m of text.matchAll(SEASON_WORD)) seasons.add(Number(m[1] ?? m[2]));
  return seasons.size === 1 ? { season: [...seasons][0], episode: null } : null;
}

// O nome contradiz o episódio pedido? true só quando o escopo do nome é claro e é outro.
function nameExcludes(name, season, episode) {
  const scope = scopeOfName(name);
  if (!scope) return false;
  if (scope.season !== season) return true;
  if (scope.episode === null) return false;
  return !(episode >= scope.episode && episode <= (scope.episodeEnd ?? scope.episode));
}

module.exports = { parseEpisode, buildEpisodeIndex, findEpisode, episodeKey, scopeOfName, nameExcludes };
