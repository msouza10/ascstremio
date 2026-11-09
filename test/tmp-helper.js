// Diretórios temporários dos testes: criados sob os.tmpdir() e removidos quando o
// processo do teste termina (passando ou falhando). Só apaga o que ele mesmo criou.
const fs = require('fs');
const os = require('os');
const path = require('path');

const criados = new Set();

process.on('exit', () => {
  for (const dir of criados) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* já removido ou em uso */ }
  }
});

function tmpdir(prefixo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
  criados.add(dir);
  return dir;
}

module.exports = { tmpdir };
