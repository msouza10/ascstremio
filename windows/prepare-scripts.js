// O pacote é montado no Linux, mas o cmd.exe precisa de CRLF para interpretar
// os arquivos de lote de forma consistente, inclusive ao capturar a saída no PowerShell.
const fs = require('node:fs');
const path = require('node:path');

function prepareScripts(stage) {
  for (const name of fs.readdirSync(stage)) {
    if (!/\.(cmd|vbs)$/i.test(name)) continue;
    const file = path.join(stage, name);
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace(/\r?\n/g, '\r\n'));
  }
}

if (require.main === module) prepareScripts(process.argv[2]);
module.exports = { prepareScripts };
