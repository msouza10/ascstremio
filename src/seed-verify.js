// Retomada explícita: tamanho aparente não prova integridade (arquivos esparsos
// podem parecer completos). Confira as peças sem motor, download ou announce.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const files = require('./retention');

const fail = () => Object.assign(new Error('Não foi possível verificar os arquivos preservados. Nada foi retomado.'), { status: 409, expose: true });
const stamp = (s) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');

async function verifySeedFiles(bridge, infoHash) {
  try {
    const lib = bridge.entries.get(infoHash);
    const data = await fs.promises.readFile(lib.torrentPath);
    const { default: parse } = await import('parse-torrent');
    const meta = await parse(data);
    if (meta.infoHash !== infoHash || !Number.isSafeInteger(meta.pieceLength) || meta.pieceLength <= 0
      || !Number.isSafeInteger(meta.length) || meta.length <= 0 || !Array.isArray(meta.pieces)
      || meta.pieces.length !== Math.ceil(meta.length / meta.pieceLength)
      || !meta.files?.length || meta.files.length !== lib.files?.length) throw fail();
    const root = files.realRoot(bridge.storeDir);
    const seen = new Set();
    const targets = meta.files.map((f, i) => {
      const key = files.pathKey(f.path);
      if (!key || seen.has(key) || key !== files.pathKey(lib.files[i].path) || f.length !== lib.files[i].length) throw fail();
      seen.add(key);
      const full = path.join(root, files.safeRelative(f.path));
      return { rel: f.path, full, length: f.length };
    });
    const inspect = () => {
      for (const [other, entry] of bridge.entries) {
        if (other !== infoHash && (entry.files ?? []).some(f => seen.has(files.pathKey(f.path)))) throw fail();
      }
      return targets.map(f => {
        const inspected = files.inspectFile(root, f.rel);
        if (!inspected.ok || !inspected.exists) throw fail();
        const st = fs.statSync(f.full);
        if (st.size !== f.length) throw fail();
        return stamp(st);
      });
    };
    const initial = inspect();
    let index = 0;
    let used = 0;
    let hash = createHash('sha1');
    const finishPiece = () => {
      if (hash.digest('hex') !== meta.pieces[index]) throw fail();
      index++; used = 0; hash = createHash('sha1');
    };
    for (const [i, f] of targets.entries()) {
      // Confira também o descritor aberto: uma troca entre inspeção e open não pode
      // fazer a leitura seguir um link ou conferir outro arquivo silenciosamente.
      const handle = await fs.promises.open(f.full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        if (stamp(await handle.stat()) !== initial[i]) throw fail();
        // Leitura assíncrona e memória limitada, mesmo com peças ou filmes grandes.
        for await (const chunk of handle.createReadStream({ highWaterMark: 256 * 1024, autoClose: false })) {
          for (let offset = 0; offset < chunk.length;) {
            const take = Math.min(meta.pieceLength - used, chunk.length - offset);
            hash.update(chunk.subarray(offset, offset + take));
            used += take; offset += take;
            if (used === meta.pieceLength) finishPiece();
          }
        }
      } finally { await handle.close(); }
    }
    if (used) finishPiece();
    const unchanged = () => {
      try { if (inspect().some((s, i) => s !== initial[i])) throw fail(); }
      catch { throw fail(); }
    };
    if (index !== meta.pieces.length) throw fail();
    unchanged();
    // Abra exatamente os metadados conferidos, sem reler um .torrent possivelmente trocado.
    return { data, unchanged };
  } catch { throw fail(); }
}

module.exports = { verifySeedFiles };
