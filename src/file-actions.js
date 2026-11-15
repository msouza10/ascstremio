// Exclusão de UM episódio de um pack, por decisão do usuário. Segue a mesma invariante de
// `seed-actions`: não se para o seed nem se apaga arquivo antes de o TRACKER confirmar o cumprimento
// (13.1), lido de novo agora; sem resposta, recusa. Pack que nunca concluiu não tem obrigação de seed,
// então não há o que confirmar. O estado não pode ficar divergente: o motor é parado antes de apagar, a
// decisão é gravada ANTES do unlink e nada volta a baixar sozinho enquanto houver exclusão.
const files = require('./retention');
const hnr = require('./hnr-guard');
const { isPackEntry } = require('./library');
const { buildEpisodeIndex } = require('./episodes');

const fail = (status, error) => Object.assign(new Error(error), { status, expose: true });

// Episódios de uma temporada, no índice real do torrent. A identidade vem do servidor (nomes de
// arquivo do .torrent), nunca de uma lista enviada pelo painel.
function seasonIndices(lib, season) {
  const index = lib.episodes ?? buildEpisodeIndex(lib.files);
  return index.episodes.filter((e) => e.season === season).map((e) => e.index);
}

function excludeFile(bridge, infoHash, fileIdx) {
  if (!Number.isInteger(fileIdx) || fileIdx < 0) return Promise.reject(fail(400, 'Conteúdo ou episódio inválido.'));
  return excludeFiles(bridge, infoHash, () => [fileIdx], 'Episódio fora do torrent.');
}

function excludeSeason(bridge, infoHash, season) {
  if (!Number.isInteger(season) || season < 0 || season > 99) return Promise.reject(fail(400, 'Temporada inválida.'));
  return excludeFiles(bridge, infoHash, (lib) => seasonIndices(lib, season), 'Temporada fora do torrent.');
}

// `pick(lib)` devolve os índices a excluir. Uma operação, uma consulta ao tracker, um stop do motor.
async function excludeFiles(bridge, infoHash, pick, notFound) {
  if (!/^[0-9a-f]{40}$/.test(infoHash)) throw fail(400, 'Conteúdo ou episódio inválido.');
  const entry = bridge.vault.get(infoHash);
  const lib = bridge.entries.get(infoHash);
  if (!entry || !lib) throw fail(404, 'Conteúdo fora da biblioteca.');
  if (!isPackEntry(lib)) throw fail(409, 'Só é possível excluir episódios de um pack. Para um filme, use a exclusão do torrent.');
  const indices = [...new Set(pick(lib))];
  const selected = indices.map((i) => lib.files?.[i]);
  if (indices.length === 0 || selected.some((f) => !f?.isVideo)) throw fail(404, notFound);
  if (bridge.loading.has(infoHash) || bridge.retention.isRetiring(infoHash)) throw fail(409, 'Há uma operação em andamento.');
  const busy = () => bridge.loading.has(infoHash) || (bridge.streams.get(infoHash) ?? 0) > 0 || bridge.limiter.hasKeyPrefix(`s:${infoHash}:`);
  if (busy()) throw fail(409, 'Aguarde a reprodução e a sessão recente terminarem.');

  bridge.retention.retiring.add(infoHash);
  try {
    // Valida antes de parar o motor: caminho seguro, sem link, e arquivo que nenhum outro conteúdo usa.
    const root = files.realRoot(bridge.storeDir);
    for (const file of selected) {
      if (!files.inspectFile(root, file.path).ok) throw fail(409, 'Não foi possível validar o arquivo para exclusão.');
      const key = files.pathKey(file.path);
      for (const [other, otherLib] of bridge.entries) {
        if (other !== infoHash && (otherLib.files ?? []).some((f) => files.pathKey(f.path) === key)) {
          throw fail(409, 'O arquivo é compartilhado com outro conteúdo e não pode ser excluído.');
        }
      }
    }
    // Com conclusão registrada há obrigação de seed: o tracker precisa confirmar o cumprimento agora.
    const exigeTracker = Boolean(entry.completedAt);
    const desde = bridge.vault.now();
    const confirmado = () => hnr.trackerConfirmed(entry) && !entry.tracker.hitAndRun && entry.tracker.checkedAt >= desde;
    if (exigeTracker) {
      let consulta;
      try { consulta = await bridge.trackerCheck?.([infoHash], { force: true }); } catch { /* falha fechada abaixo */ }
      if (!consulta || consulta.failed || consulta.semRegistro || !consulta.checked) throw fail(503, 'Não foi possível confirmar o seed no tracker. Nada foi removido.');
      if (!confirmado()) throw fail(409, 'O tracker ainda não confirmou o cumprimento do seed. Excluir um episódio agora pararia o seed deste pack com a obrigação de 72 h aberta; tente depois da confirmação.');
    }
    const torrent = bridge.client?.torrents.find((t) => t.infoHash === infoHash);
    if (torrent && !torrent.ready) throw fail(409, 'Aguarde o torrent terminar de abrir.');
    if (torrent) {
      // O motor acha que as peças ainda existem: parar antes de apagar evita ler arquivo que sumiu.
      await new Promise((resolve, reject) => torrent.destroy({ destroyStore: false }, (err) => err ? reject(fail(503, 'Não foi possível parar o torrent.')) : resolve()));
      bridge.completing.delete(infoHash);
      bridge.startedAt.delete(infoHash);
      bridge.lastTick.delete(infoHash);
      bridge.packFiles.delete(infoHash);
    }
    // O destroy é assíncrono: reconfere o estado antes de tocar no arquivo.
    if (busy() || (exigeTracker && !confirmado())) throw fail(409, 'O estado mudou. O arquivo foi preservado.');
    // Grava a decisão antes do primeiro unlink: uma queda ou falha não pode fazer a conclusão em
    // segundo plano baixar o episódio de volta sozinha.
    for (const i of indices) bridge.vault.setExcluded(infoHash, i, true);
    bridge.vault.setBackground(infoHash, false);
    const result = files.removeFiles(bridge.storeDir, selected.map((f) => f.path));
    bridge.duCache = null;
    if (result.failed.length) throw fail(409, 'A exclusão foi registrada, mas o arquivo não pôde ser removido (em uso?). Tente de novo.');
    return {
      infoHash, file: indices.length === 1 ? indices[0] : undefined, files: indices, count: result.removed, bytes: result.bytes,
      message: `${result.removed === 1 ? 'Episódio excluído' : `${result.removed} episódios excluídos`}. O seed deste pack fica parado até você baixar o que falta.`,
    };
  } finally {
    bridge.retention.retiring.delete(infoHash);
  }
}

// Concluir só parte de um pack (um episódio ou uma temporada): baixa esses arquivos em prioridade
// baixa. NÃO é a conclusão do torrent inteiro: não liga `backgroundComplete` e não abre a obrigação
// de 72 h (13.1), que só nasce quando o torrent fecha. Cada arquivo paga a própria reserva de disco
// (admitTorrent) e o pedido não persiste: depois de um reinício, vale a política normal do pack.
async function completeFiles(bridge, infoHash, scope) {
  const { file, season } = scope ?? {};
  if ((file === undefined) === (season === undefined)) throw fail(400, 'Escolha um episódio ou uma temporada.');
  if (file !== undefined && (!Number.isInteger(file) || file < 0)) throw fail(400, 'Episódio inválido.');
  if (season !== undefined && (!Number.isInteger(season) || season < 0 || season > 99)) throw fail(400, 'Temporada inválida.');
  const lib = bridge.entries.get(infoHash);
  if (!lib || !bridge.vault.get(infoHash)) throw fail(404, 'Conteúdo fora da biblioteca.');
  if (!isPackEntry(lib)) throw fail(409, 'Só é possível concluir parte de um pack. Para um filme, conclua o torrent.');
  const indices = file !== undefined ? [file] : seasonIndices(lib, season);
  if (indices.length === 0 || indices.some((i) => !lib.files?.[i]?.isVideo)) throw fail(404, file !== undefined ? 'Episódio fora do torrent.' : 'Temporada fora do torrent.');

  // Pedido explícito: o que o usuário excluiu daqui volta a ser baixado; as outras exclusões ficam.
  for (const i of indices) bridge.vault.setExcluded(infoHash, i, false);
  const torrent = await bridge.getTorrent(infoHash, { fileIdx: indices[0] });
  for (const i of indices.slice(1)) bridge.admitTorrent(infoHash, i);
  for (const i of indices) torrent.files?.[i]?.select?.(0);
  return { infoHash, name: torrent.name, files: indices, count: indices.length, freeleech: bridge.isFreeleech(infoHash),
    message: indices.length === 1 ? 'Baixando o episódio em segundo plano.' : `Baixando ${indices.length} episódios em segundo plano.` };
}

module.exports = { excludeFile, excludeSeason, completeFiles };
