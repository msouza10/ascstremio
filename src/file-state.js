// Estado de cada arquivo de um torrent, para o painel mostrar o que há em disco por episódio.
//
// Duas fontes, e a diferença importa:
// - Motor aberto: o WebTorrent conta só peças VERIFICADAS (`file.downloaded`), então o resultado é
//   exato e pode ser chamado de `completo`.
// - Só disco: o arquivo é esparso (o streaming grava onde o player pediu), então o tamanho aparente
//   engana: um arquivo que o player levou até o fim parece cheio. Vale o espaço realmente alocado
//   (`blocks`), e mesmo cheio é só `provavel`: sem conferir as peças não dá para afirmar integridade.
// Quem decide algo irreversível (oferecer offline, apagar) não deve confiar em `provavel`.
const fs = require('node:fs');
const path = require('node:path');

// Folga para o arredondamento do sistema de arquivos (blocos de 4 KiB por arquivo).
const BLOCK_SLACK = 64 * 1024;

const STATES = ['completo', 'provavel', 'parcial', 'ausente'];

// Bytes realmente gravados de um arquivo, limitados ao tamanho dele. No Windows não há `blocks`: vale
// o tamanho do arquivo, que nesse caso não prova nada além de a pré-alocação existir.
function bytesOnDisk(fullPath, length, statFn = fs.statSync) {
  try {
    const st = statFn(fullPath);
    if (!st.isFile()) return 0;
    const raw = typeof st.blocks === 'number' ? st.blocks * 512 : st.size;
    return Math.max(0, Math.min(length, raw));
  } catch { return 0; }
}

// files: [{ index, path, length, isVideo }]; torrent: objeto do motor ou null.
// Devolve uma linha por arquivo, na ordem do torrent.
function fileStates({ files, torrent = null, storeDir, statFn = fs.statSync }) {
  const open = Boolean(torrent?.ready && Array.isArray(torrent.files));
  return (files ?? []).map((file, i) => {
    const length = file.length || 0;
    const base = { index: file.index ?? i, length, isVideo: Boolean(file.isVideo) };
    if (open && torrent.files[i] && torrent.files[i].length === length) {
      const have = Math.max(0, Math.min(length, torrent.files[i].downloaded ?? 0));
      const state = length === 0 || have >= length ? 'completo' : have > 0 ? 'parcial' : 'ausente';
      return { ...base, onDisk: have, state, verified: true };
    }
    const have = bytesOnDisk(path.join(storeDir, file.path), length, statFn);
    // A folga só vale para quem tem algo gravado: sem ela, um arquivo pequeno que nem existe
    // (menor que a folga) pareceria cheio.
    const cheio = length === 0 || (have > 0 && have + BLOCK_SLACK >= length);
    const state = cheio ? 'provavel' : have > 0 ? 'parcial' : 'ausente';
    return { ...base, onDisk: have, state, verified: false };
  });
}

module.exports = { fileStates, bytesOnDisk, STATES, BLOCK_SLACK };
