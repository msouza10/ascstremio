// Exclusão de UM episódio de um pack, por decisão do usuário. Segue a mesma invariante de
// `seed-actions`: não se para o seed nem se apaga arquivo antes de o TRACKER confirmar o cumprimento
// (13.1), lido de novo agora; sem resposta, recusa. Pack que nunca concluiu não tem obrigação de seed,
// então não há o que confirmar. O estado não pode ficar divergente: o motor é parado antes de apagar, a
// decisão é gravada ANTES do unlink e nada volta a baixar sozinho enquanto houver exclusão.
const files = require('./retention');
const hnr = require('./hnr-guard');
const { isPackEntry } = require('./library');

const fail = (status, error) => Object.assign(new Error(error), { status, expose: true });

async function excludeFile(bridge, infoHash, fileIdx) {
  if (!/^[0-9a-f]{40}$/.test(infoHash) || !Number.isInteger(fileIdx) || fileIdx < 0) throw fail(400, 'Conteúdo ou episódio inválido.');
  const entry = bridge.vault.get(infoHash);
  const lib = bridge.entries.get(infoHash);
  if (!entry || !lib) throw fail(404, 'Conteúdo fora da biblioteca.');
  if (!isPackEntry(lib)) throw fail(409, 'Só é possível excluir episódios de um pack. Para um filme, use a exclusão do torrent.');
  const file = lib.files?.[fileIdx];
  if (!file?.isVideo) throw fail(404, 'Episódio fora do torrent.');
  if (bridge.loading.has(infoHash) || bridge.retention.isRetiring(infoHash)) throw fail(409, 'Há uma operação em andamento.');
  const busy = () => bridge.loading.has(infoHash) || (bridge.streams.get(infoHash) ?? 0) > 0 || bridge.limiter.hasKeyPrefix(`s:${infoHash}:`);
  if (busy()) throw fail(409, 'Aguarde a reprodução e a sessão recente terminarem.');

  bridge.retention.retiring.add(infoHash);
  try {
    // Valida antes de parar o motor: caminho seguro, sem link, e arquivo que nenhum outro conteúdo usa.
    const root = files.realRoot(bridge.storeDir);
    if (!files.inspectFile(root, file.path).ok) throw fail(409, 'Não foi possível validar o arquivo para exclusão.');
    const key = files.pathKey(file.path);
    for (const [other, otherLib] of bridge.entries) {
      if (other !== infoHash && (otherLib.files ?? []).some((f) => files.pathKey(f.path) === key)) {
        throw fail(409, 'O arquivo é compartilhado com outro conteúdo e não pode ser excluído.');
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
    bridge.vault.setExcluded(infoHash, fileIdx, true);
    bridge.vault.setBackground(infoHash, false);
    const result = files.removeFiles(bridge.storeDir, [file.path]);
    bridge.duCache = null;
    if (result.failed.length) throw fail(409, 'A exclusão foi registrada, mas o arquivo não pôde ser removido (em uso?). Tente de novo.');
    return {
      infoHash, file: fileIdx, bytes: result.bytes,
      message: 'Episódio excluído. O seed deste pack fica parado até você baixar o que falta.',
    };
  } finally {
    bridge.retention.retiring.delete(infoHash);
  }
}

module.exports = { excludeFile };
