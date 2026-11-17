// O pacote é montado no Linux, mas o cmd.exe precisa de CRLF para interpretar
// os arquivos de lote de forma consistente, inclusive ao capturar a saída no PowerShell.
// Os .ps1 também levam BOM UTF-8: o PowerShell 5.1 lê arquivo sem BOM como ANSI e estraga os acentos.
const fs = require('node:fs');
const path = require('node:path');

function prepareScripts(stage) {
  for (const name of fs.readdirSync(stage)) {
    if (!/\.(cmd|vbs|ps1)$/i.test(name)) continue;
    const file = path.join(stage, name);
    const original = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '');
    const texto = original.replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(file, /\.ps1$/i.test(name) ? `\ufeff${texto}` : texto);
  }
}

if (require.main === module) prepareScripts(process.argv[2]);
module.exports = { prepareScripts };
