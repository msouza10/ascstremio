// Decisão individual depois do seed: o tracker precisa confirmar novamente antes de
// encerrar ou apagar. A trava de manutenção também impede um play durante a operação.
const hnr = require('./hnr-guard');
const files = require('./retention');
const { verifySeedFiles } = require('./seed-verify');

async function manageSeed(bridge, infoHash, action) {
  const fail = (status, error) => Object.assign(new Error(error), { status, expose: true });
  if (!/^[0-9a-f]{40}$/.test(infoHash) || !['keep', 'stop', 'delete', 'resume'].includes(action)) {
    throw fail(400, 'Conteúdo ou ação inválida.');
  }
  const entry = bridge.vault.get(infoHash);
  const lib = bridge.entries.get(infoHash);
  if (!entry || !lib) throw fail(404, 'Conteúdo fora da biblioteca.');
  if (bridge.loading.has(infoHash) || bridge.retention.isRetiring(infoHash)) throw fail(409, 'Há uma operação em andamento.');
  if ((bridge.streams.get(infoHash) ?? 0) > 0 || bridge.limiter.hasKeyPrefix(`s:${infoHash}:`)) {
    throw fail(409, 'Aguarde a reprodução e a sessão recente terminarem.');
  }
  if (action === 'resume') return resumeSeed(bridge, infoHash, entry, fail);
  bridge.retention.retiring.add(infoHash);
  try {
    const since = bridge.vault.now();
    let checked;
    try { checked = await bridge.trackerCheck?.([infoHash], { force: true }); } catch { /* falha fechada abaixo */ }
    const confirmed = () => hnr.trackerConfirmed(entry) && !entry.tracker.hitAndRun && entry.tracker.checkedAt >= since;
    if (!checked || checked.failed || checked.semRegistro || !checked.checked) throw fail(503, 'Não foi possível confirmar o seed no tracker. Nada foi removido.');
    if (!confirmed()) throw fail(409, 'O tracker ainda não confirmou o cumprimento do seed.');
    const busy = () => bridge.loading.has(infoHash) || (bridge.streams.get(infoHash) ?? 0) > 0 || bridge.limiter.hasKeyPrefix(`s:${infoHash}:`);
    if (busy()) throw fail(409, 'Conteúdo em uso.');
    const torrent = bridge.client?.torrents.find((t) => t.infoHash === infoHash);
    if (torrent && (!torrent.ready || !torrent.done)) throw fail(409, 'Aguarde a conclusão ou verificação dos arquivos.');
    if (action === 'keep') {
      if (!torrent) throw fail(409, 'O seed já está parado. Os arquivos foram preservados.');
      bridge.vault.setSeedChoice(infoHash, 'keep');
      return { action, message: 'Seed mantido. Os arquivos não serão apagados automaticamente.' };
    }
    // Inspeciona o título inteiro antes de parar o motor; arquivos compartilhados ou
    // fora do armazenamento nunca são apagados por uma ação individual.
    const paths = (lib.files ?? []).map((f) => f.path);
    const inspect = () => {
      const root = files.realRoot(bridge.storeDir);
      if (!paths.length || paths.some((p) => !files.inspectFile(root, p).ok)) throw fail(409, 'Não foi possível validar os arquivos para exclusão.');
      for (const [other, otherLib] of bridge.entries) {
        if (other === infoHash) continue;
        const shared = new Set((otherLib.files ?? []).map((f) => files.pathKey(f.path)));
        if (paths.some((p) => shared.has(files.pathKey(p)))) throw fail(409, 'Arquivos compartilhados com outro conteúdo não podem ser excluídos.');
      }
    };
    if (action === 'delete') inspect();
    if (torrent) {
      await new Promise((resolve, reject) => torrent.destroy({ destroyStore: false }, (err) => err ? reject(fail(503, 'Não foi possível parar o seed.')) : resolve()));
      bridge.completing.delete(infoHash);
      bridge.startedAt.delete(infoHash);
      bridge.lastTick.delete(infoHash);
    }
    // O destroy é assíncrono: reconfere o estado antes de tocar nos arquivos.
    if (!confirmed() || busy()) throw fail(409, 'O estado mudou. Os arquivos foram preservados.');
    // Uma exclusão parcial (arquivo em uso no Windows, por exemplo) também é
    // uma decisão de parar. Grave antes do primeiro unlink: uma queda ou falha
    // não pode fazer a conclusão em segundo plano baixar os dados novamente.
    bridge.vault.setSeedChoice(infoHash, 'stop');
    bridge.vault.markReleased(infoHash, 'stop');
    if (action === 'delete') {
      inspect();
      const result = files.removeFiles(bridge.storeDir, paths);
      bridge.duCache = null;
      if (result.failed.length) throw fail(409, 'O seed foi parado, mas alguns arquivos não puderam ser removidos. Confira o disco e tente novamente.');
    }
    bridge.vault.setSeedChoice(infoHash, action);
    bridge.vault.markReleased(infoHash, action);
    return { action, message: action === 'delete' ? 'Seed encerrado e arquivos excluídos.' : 'Seed encerrado. Arquivos preservados para assistir depois.' };
  } finally {
    bridge.retention.retiring.delete(infoHash);
  }
}

async function resumeSeed(bridge, infoHash, entry, fail) {
  if (!entry.completedAt || entry.seedChoice !== 'stop' || entry.releasedAs !== 'stop'
    || !bridge.client || bridge.client.torrents.some(t => t.infoHash === infoHash)) {
    throw fail(409, 'Só é possível voltar a semear um conteúdo parado com arquivos preservados.');
  }
  const idle = () => {
    if (bridge.loading.has(infoHash) || (bridge.streams.get(infoHash) ?? 0) > 0 || bridge.limiter.hasKeyPrefix(`s:${infoHash}:`)
      || bridge.limiter.hasKeyPrefix(`a:${hnr.ascIdFromPath(entry.torrentPath)}`)) throw fail(409, 'Conteúdo em uso.');
    const sessions = bridge.limiter.snapshot();
    if (sessions.maxSessions > 0 && sessions.active >= sessions.maxSessions) throw fail(409, 'Aguarde uma vaga de reprodução antes de verificar os arquivos.');
  };
  const confirm = async () => {
    const since = bridge.vault.now();
    let result;
    try { result = await bridge.trackerCheck?.([infoHash], { force: true }); } catch { /* recusa abaixo */ }
    if (!result?.checked || result.failed || result.semRegistro) throw fail(503, 'Não foi possível confirmar o seed no tracker. Nada foi retomado.');
    if (!hnr.trackerConfirmed(entry) || entry.tracker.hitAndRun || entry.tracker.checkedAt < since) throw fail(409, 'O tracker ainda não confirmou o cumprimento do seed.');
    idle();
  };
  // A mesma trava bloqueia play, exclusão e retenção enquanto o pedido aguarda a fila.
  bridge.retention.retiring.add(infoHash);
  try {
    return await bridge.withResumeSlot(async () => {
      idle();
      await confirm();
      const verified = await verifySeedFiles(bridge, infoHash);
      // A leitura pode demorar muitos minutos: a confirmação anterior não basta.
      await confirm();
      verified.unchanged();
      bridge.admitTorrent(infoHash);
      const previous = { seedChoice: entry.seedChoice, releasedAs: entry.releasedAs, releasedAt: entry.releasedAt };
      try {
        const torrent = await bridge.getTorrent(infoHash, { seedResume: true, torrentData: verified.data });
        idle();
        if (!torrent.ready || !torrent.done || !hnr.trackerConfirmed(entry) || entry.tracker.hitAndRun) throw fail(409, 'O estado mudou durante a abertura. O seed continua parado.');
        bridge.vault.setSeedChoice(infoHash, 'keep');
        return { action: 'resume', message: 'Seed retomado. Os arquivos não serão apagados automaticamente.' };
      } catch (err) {
        Object.assign(entry, previous);
        const opened = bridge.client.torrents.find(t => t.infoHash === infoHash);
        if (opened) await new Promise((resolve, reject) => opened.destroy({ destroyStore: false }, e => e ? reject(fail(503, 'Não foi possível encerrar a retomada. Confira o painel.')) : resolve()));
        bridge.completing.delete(infoHash); bridge.startedAt.delete(infoHash); bridge.lastTick.delete(infoHash);
        if (err.expose) throw err;
        throw fail(503, 'Não foi possível retomar o seed. Os arquivos foram preservados.');
      }
    });
  } finally { bridge.retention.retiring.delete(infoHash); }
}

module.exports = { manageSeed };
