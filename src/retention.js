// Retenção por orçamento (issue #27): peças puras e de disco, sem rede e sem estado do motor.
//
// Princípios (nada aqui decide sozinho que um título pode sair; quem decide é a ponte, que
// só entrega candidatos que o TRACKER confirmou cumpridos):
//  - Só existem dois verbos: inspecionar (somente leitura) e remover arquivos de um título.
//  - Nada fora de BRIDGE_STORE: cada caminho vem do .torrent (relativo), é normalizado e conferido
//    com realpath. Symlink (no arquivo ou em qualquer pasta do caminho), link físico (nlink > 1)
//    e tudo que não seja arquivo comum viram "inseguro" e o título inteiro deixa de ser candidato.
//  - Não apaga .torrent, cofre, credenciais nem arquivos que a biblioteca não lista (órfãos só
//    geram aviso: orfandade não autoriza exclusão).
//  - Seleção determinística: mais antigo por último uso primeiro; empate pelo infoHash.

const fs = require('fs');
const path = require('path');

const DAY_MS = 86_400_000;
const GIB = 1024 ** 3;
// Conteúdo que o tracker acabou de confirmar não sai logo: dá tempo de a conciliação se firmar.
const SAFETY_MS = 24 * 3_600_000;

const allocated = (st) => (typeof st.blocks === 'number' ? st.blocks * 512 : st.size);

// Caminho relativo vindo do .torrent: sem absoluto, sem NUL, sem ".." depois de normalizar.
function safeRelative(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) return null;
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel)) return null;
  const norm = path.normalize(rel);
  if (norm === '.' || norm.split(path.sep).includes('..')) return null;
  return norm;
}

// Confere um arquivo de título sem tocar nele. Devolve
//   { ok: true, bytes, exists }  ou  { ok: false, reason }.
// `rootReal` é o realpath do BRIDGE_STORE.
function inspectFile(rootReal, rel) {
  const norm = safeRelative(rel);
  if (!norm) return { ok: false, reason: 'caminho-invalido' };
  const full = path.join(rootReal, norm);
  let st;
  try { st = fs.lstatSync(full); } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: true, bytes: 0, exists: false };
    return { ok: false, reason: 'ilegivel' };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!st.isFile()) return { ok: false, reason: 'nao-e-arquivo' };
  if (st.nlink > 1) return { ok: false, reason: 'link-fisico' };
  // Nenhuma pasta do caminho pode ser symlink: o realpath do pai tem de ser exatamente o esperado.
  let paiReal;
  try { paiReal = fs.realpathSync(path.dirname(full)); } catch { return { ok: false, reason: 'ilegivel' }; }
  const esperado = path.join(rootReal, path.dirname(norm));
  // Windows e macOS não diferenciam maiúsculas: o nome no .torrent pode diferir do que está no disco.
  const igual = (a, b) => (process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!igual(paiReal, esperado)) return { ok: false, reason: 'symlink' };
  return { ok: true, bytes: allocated(st), exists: true };
}

function realRoot(storeDir) {
  return fs.realpathSync(storeDir);
}

// Remove os arquivos de um título (lista relativa da biblioteca), repetindo a inspeção
// imediatamente antes de cada unlink. Depois apara pastas que ficaram vazias, nunca a raiz.
// Devolve { removed, bytes, failed: [{ file, reason }] } (file é o índice, nunca um caminho absoluto).
function removeFiles(storeDir, relFiles) {
  const out = { removed: 0, bytes: 0, failed: [] };
  let rootReal;
  try { rootReal = realRoot(storeDir); } catch { out.failed.push({ file: -1, reason: 'store-ilegivel' }); return out; }
  const dirs = new Set();
  relFiles.forEach((rel, i) => {
    const info = inspectFile(rootReal, rel);
    if (!info.ok) { out.failed.push({ file: i, reason: info.reason }); return; }
    if (!info.exists) return;
    const full = path.join(rootReal, safeRelative(rel));
    try {
      fs.unlinkSync(full);
      out.removed += 1;
      out.bytes += info.bytes;
      dirs.add(path.dirname(full));
    } catch (err) {
      // EBUSY/EPERM no Windows = arquivo em uso: fica, é reportado e a execução segue.
      out.failed.push({ file: i, reason: err?.code === 'EBUSY' || err?.code === 'EPERM' ? 'em-uso' : 'falha-ao-remover' });
    }
  });
  for (let dir of [...dirs].sort((a, b) => b.length - a.length)) {
    while (dir.length > rootReal.length && dir.startsWith(rootReal + path.sep)) {
      try { fs.rmdirSync(dir); } catch { break; } // não vazia ou em uso: para
      dir = path.dirname(dir);
    }
  }
  return out;
}

// Escolhe o que remover. `items`: [{ infoHash, bytes, lastUse, eligible }] de TODOS os títulos com
// dados em disco (os não elegíveis contam no orçamento, mas não saem). `policy`: { budgetBytes, maxTitles }.
function select(items, policy) {
  const onDisk = items.filter((i) => i.bytes > 0);
  const totalBytes = onDisk.reduce((a, i) => a + i.bytes, 0);
  const totalTitles = onDisk.length;
  const result = {
    totalBytes, totalTitles, candidates: [], bytes: 0,
    limits: { budgetBytes: policy.budgetBytes || 0, maxTitles: policy.maxTitles || 0 },
    reached: true, missingBytes: 0, missingTitles: 0, note: null,
  };
  if (!policy.budgetBytes && !policy.maxTitles) { result.note = 'sem-limite'; return result; }
  const over = (bytes, titles) => ({
    bytes: policy.budgetBytes > 0 && bytes > policy.budgetBytes,
    titles: policy.maxTitles > 0 && titles > policy.maxTitles,
  });
  let bytes = totalBytes;
  let titles = totalTitles;
  if (!over(bytes, titles).bytes && !over(bytes, titles).titles) { result.note = 'dentro-do-orcamento'; return result; }
  const ordem = items.filter((i) => i.eligible && i.bytes > 0)
    .sort((a, b) => a.lastUse - b.lastUse || (a.infoHash < b.infoHash ? -1 : 1));
  for (const item of ordem) {
    const o = over(bytes, titles);
    if (!o.bytes && !o.titles) break;
    result.candidates.push({ ...item, motivo: o.bytes && o.titles ? 'excede-orcamento-e-titulos' : o.bytes ? 'excede-orcamento' : 'excede-titulos' });
    bytes -= item.bytes;
    titles -= 1;
  }
  const fim = over(bytes, titles);
  result.bytes = totalBytes - bytes;
  result.reached = !fim.bytes && !fim.titles;
  result.missingBytes = fim.bytes ? bytes - policy.budgetBytes : 0;
  result.missingTitles = fim.titles ? titles - policy.maxTitles : 0;
  if (!result.reached) result.note = 'inalcancavel';
  return result;
}

module.exports = { inspectFile, removeFiles, select, safeRelative, realRoot, DAY_MS, GIB, SAFETY_MS };
