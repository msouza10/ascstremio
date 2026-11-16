// A ordem física do .torrent não é a ordem dos episódios. A seleção de streaming do motor tem
// prioridade própria; estas seleções de prioridade zero completam o que vem à frente e só depois
// voltam ao que ficou para trás. Intervalos não se sobrepõem, inclusive nas peças compartilhadas entre arquivos.
const { buildEpisodeIndex } = require('./episodes');

function completionPlan(torrent, entry, position) {
  const count = torrent.pieces?.length ?? 0;
  if (!count) return [];
  const files = torrent.files ?? [];
  // Sem posição utilizável (nem arquivo atual com bytes) vale o torrent inteiro, na ordem física.
  if (!position || !(files[position.fileIdx]?.length > 0) || !(torrent.pieceLength > 0)) return [[0, count - 1]];
  const { fileIdx, start } = position;
  const episodes = buildEpisodeIndex(entry?.files ?? []).episodes
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const current = episodes.findIndex((f) => f.index === fileIdx);
  const ordered = current >= 0 ? episodes.map((f) => f.index) : files.map((_, i) => i);
  const pivot = ordered.indexOf(fileIdx);
  const next = ordered.slice(pivot + 1);
  const previous = ordered.slice(0, pivot);
  let offset = 0;
  const ranges = files.map((file) => {
    const range = [offset, offset + file.length - 1];
    offset += file.length;
    return range;
  });
  const own = ranges[fileIdx];
  const point = own[0] + Math.min(Math.max(0, start), files[fileIdx].length - 1);
  const bytes = [[point, own[1]], ...next.map((i) => ranges[i]),
    [own[0], point - 1], ...previous.map((i) => ranges[i]),
    ...ranges.filter((_, i) => i !== fileIdx && !ordered.includes(i))];
  const plan = [];
  for (const [from, to] of bytes) {
    if (to < from) continue;
    let pending = [[Math.floor(from / torrent.pieceLength), Math.min(count - 1, Math.floor(to / torrent.pieceLength))]];
    for (const [usedFrom, usedTo] of plan) {
      pending = pending.flatMap(([a, b]) => {
        if (b < usedFrom || a > usedTo) return [[a, b]];
        return [...(a < usedFrom ? [[a, usedFrom - 1]] : []), ...(b > usedTo ? [[usedTo + 1, b]] : [])];
      });
    }
    plan.push(...pending);
  }
  return plan;
}

const activePlans = new WeakMap();

function selectCompletion(torrent, plan) {
  // O WebTorrent mescla até intervalos adjacentes. Selecionar todos de uma vez perde a ordem;
  // portanto só liberamos a próxima etapa quando TODAS as peças da atual estão verificadas.
  const state = {};
  activePlans.set(torrent, state);
  let index = 0;
  const advance = () => {
    if (torrent.destroyed || activePlans.get(torrent) !== state) return;
    while (index < plan.length) {
      const [from, to] = plan[index];
      let missing = false;
      for (let piece = from; piece <= to; piece += 1) {
        if (!torrent.bitfield?.get(piece)) { missing = true; break; }
      }
      if (missing) break;
      index += 1;
    }
    // A API pública preserva os iteradores de streaming ao remover seleções de fundo.
    torrent.deselect?.(0, torrent.pieces.length - 1);
    if (index >= plan.length) return;
    const [from, to] = plan[index];
    let queued = false;
    let cursor = from;
    torrent.select(from, to, 0, () => {
      if (queued) return;
      queued = true;
      // A notificação vem durante a coleta de seleções do motor: só alterar depois da coleta.
      queueMicrotask(() => {
        queued = false;
        if (activePlans.get(torrent) !== state || torrent.destroyed) return;
        while (cursor <= to && torrent.bitfield?.get(cursor)) cursor += 1;
        if (cursor > to) advance();
      });
    });
  };
  advance();
}

module.exports = { completionPlan, selectCompletion };
