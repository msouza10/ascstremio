// Verificação por peças de arquivos de um torrent, SEM o motor: confere o SHA-1 de cada peça que
// toca o arquivo contra o .torrent. Tamanho aparente e blocos alocados não provam integridade
// (arquivo esparso de streaming pode estar cheio de zeros); só o hash prova, e só então um arquivo
// pode ser chamado de `completo` fora do motor.
//
// Conservador de propósito: peça de borda compartilhada com um arquivo vizinho que não está em
// disco não se confirma, e o arquivo fica sem prova (nunca "ok" por palpite). Só leitura: não
// baixa, não anuncia, não escreve.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const files = require('./retention');

const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

// meta: { pieceLength, pieces: [sha1 hex], files: [{ path, length }], length }
function coherent(meta) {
  if (!meta || !Number.isSafeInteger(meta.pieceLength) || meta.pieceLength <= 0 || !Array.isArray(meta.pieces) || !Array.isArray(meta.files)) return false;
  const total = meta.files.reduce((sum, f) => sum + (f.length || 0), 0);
  return Number.isSafeInteger(total) && meta.pieces.length === Math.ceil(total / meta.pieceLength);
}

// Devolve Map(índice -> true|false) para cada índice pedido. `onRead({ piece })` é só para teste/medida.
async function verifyFilesByPieces({ meta, storeDir, fileIdxs, onRead = null }) {
  const result = new Map();
  const wanted = [...new Set(fileIdxs ?? [])];
  if (!coherent(meta)) { for (const i of wanted) result.set(i, false); return result; }

  let root;
  try { root = files.realRoot(storeDir); } catch { for (const i of wanted) result.set(i, false); return result; }

  const pl = meta.pieceLength;
  const starts = [];
  let total = 0;
  for (const f of meta.files) { starts.push(total); total += f.length; }

  const handles = new Map(); // índice -> FileHandle | null (indisponível)
  const pieceOk = new Map(); // peça -> boolean (cada peça é lida uma vez)

  async function handleOf(i) {
    if (handles.has(i)) return handles.get(i);
    let handle = null;
    try {
      const info = files.inspectFile(root, meta.files[i].path);
      if (info.ok && info.exists) {
        const full = path.join(root, files.safeRelative(meta.files[i].path));
        const opened = await fs.promises.open(full, READ_FLAGS);
        // O descritor aberto também precisa ser um arquivo comum do tamanho esperado ou maior.
        const st = await opened.stat();
        if (st.isFile() && st.size >= meta.files[i].length) handle = opened; else await opened.close();
      }
    } catch { handle = null; }
    handles.set(i, handle);
    return handle;
  }

  async function checkPiece(p) {
    if (pieceOk.has(p)) return pieceOk.get(p);
    const from = p * pl;
    const to = Math.min(from + pl, total);
    const hash = createHash('sha1');
    let ok = true;
    for (let i = 0; i < meta.files.length && ok; i += 1) {
      const fStart = starts[i];
      const fEnd = fStart + meta.files[i].length;
      if (fEnd <= from || fStart >= to || meta.files[i].length === 0) continue;
      const handle = await handleOf(i);
      if (!handle) { ok = false; break; }
      const start = Math.max(from, fStart);
      const end = Math.min(to, fEnd);
      const buf = Buffer.alloc(end - start);
      try {
        const { bytesRead } = await handle.read(buf, 0, buf.length, start - fStart);
        if (bytesRead !== buf.length) ok = false; else hash.update(buf);
      } catch { ok = false; }
    }
    onRead?.({ piece: p });
    const good = ok && hash.digest('hex') === meta.pieces[p];
    pieceOk.set(p, good);
    return good;
  }

  try {
    for (const i of wanted) {
      const f = meta.files[i];
      if (!f || !Number.isInteger(i) || i < 0) { result.set(i, false); continue; }
      if (f.length === 0) { result.set(i, Boolean((await handleOf(i)) || files.inspectFile(root, f.path).exists)); continue; }
      const first = Math.floor(starts[i] / pl);
      const last = Math.floor((starts[i] + f.length - 1) / pl);
      let good = true;
      for (let p = first; p <= last && good; p += 1) good = await checkPiece(p);
      result.set(i, good);
    }
  } finally {
    for (const h of handles.values()) await h?.close().catch(() => {});
  }
  return result;
}

// ---- Verificação de um pack pela ponte ---------------------------------------------------------------
const { isPackEntry } = require('./library');
const { fileStates } = require('./file-state');

const fail = (status, error) => Object.assign(new Error(error), { status, expose: true });

// Identidade do arquivo como estava quando foi provado: se tamanho ou data mudarem, a prova caduca.
function stampOf(storeDir, filePath) {
  try { const st = fs.statSync(path.join(storeDir, filePath)); return `${st.size}:${st.mtimeMs}`; } catch { return null; }
}

async function defaultLoadMeta(torrentPath) {
  const { default: parse } = await import('parse-torrent');
  const meta = await parse(await fs.promises.readFile(torrentPath));
  return {
    pieceLength: meta.pieceLength, pieces: meta.pieces, length: meta.length,
    files: (meta.files ?? []).map((f) => ({ path: Array.isArray(f.path) ? f.path.join('/') : String(f.path ?? meta.name), length: f.length })),
  };
}

// Confere por peças os vídeos de um pack que estão em disco com tamanho "provável" e grava a prova
// na memória da ponte (não persiste: reverifica após reinício). Torrent no motor já é exato.
async function verifyPack(bridge, infoHash) {
  if (!/^[0-9a-f]{40}$/.test(infoHash)) throw fail(400, 'Conteúdo inválido.');
  const lib = bridge.entries.get(infoHash);
  if (!lib) throw fail(404, 'Conteúdo fora da biblioteca.');
  if (!isPackEntry(lib)) throw fail(409, 'A verificação por peças é só para packs.');
  if ((bridge.client?.torrents ?? []).some((t) => t.infoHash === infoHash) || bridge.loading.has(infoHash)) throw fail(409, 'O torrent está aberto no motor: o estado já vem das peças verificadas.');
  if (bridge.retention.isRetiring(infoHash) || bridge.verifying.has(infoHash)) throw fail(409, 'Há uma operação em andamento.');
  bridge.verifying.add(infoHash);
  try {
    const meta = await bridge.loadPieceMeta(lib.torrentPath);
    if (meta.files.length !== lib.files.length || meta.files.some((f, i) => files.pathKey(f.path) !== files.pathKey(lib.files[i].path) || f.length !== lib.files[i].length)) {
      throw fail(409, 'O .torrent não confere com o conteúdo da biblioteca. Nada foi verificado.');
    }
    const alvo = fileStates({ files: lib.files, storeDir: bridge.storeDir })
      .filter((s) => s.isVideo && s.state === 'provavel').map((s) => s.index);
    // O carimbo é tirado ANTES da leitura: mudança durante a verificação invalida a prova.
    const stamps = new Map(alvo.map((i) => [i, stampOf(bridge.storeDir, lib.files[i].path)]));
    const result = await verifyFilesByPieces({ meta, storeDir: bridge.storeDir, fileIdxs: alvo });
    const proof = bridge.pieceProof.get(infoHash) ?? new Map();
    let ok = 0; let failed = 0;
    for (const [i, good] of result) {
      proof.set(i, { ok: good, stamp: stamps.get(i) });
      if (good) ok += 1; else failed += 1;
    }
    bridge.pieceProof.set(infoHash, proof);
    return { infoHash, ok, failed, message: failed
      ? `${ok} episódio(s) confirmado(s) por peças e ${failed} sem prova (incompleto, corrompido ou com borda de peça faltando).`
      : `${ok} episódio(s) confirmado(s) por peças.` };
  } finally { bridge.verifying.delete(infoHash); }
}

module.exports = { verifyFilesByPieces, verifyPack, stampOf, defaultLoadMeta };
