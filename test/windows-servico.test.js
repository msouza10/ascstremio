const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raiz = path.join(__dirname, '..');
const ler = (...p) => fs.readFileSync(path.join(raiz, ...p), 'utf8');

test('serviço do Windows: WinSW roda o Node do pacote com a conta de baixo privilégio e reinicia se cair', () => {
  const xml = ler('windows', 'servico.xml');
  assert.match(xml, /<id>AscStremio<\/id>/);
  assert.match(xml, /<executable>%BASE%\\node\\node\.exe<\/executable>/);
  // O ASC responde com cabeçalhos grandes: sem a flag o serviço quebra (AGENTS.md).
  assert.match(xml, /<arguments>[^<]*--max-http-header-size=65536[^<]*src\\index\.js<\/arguments>/);
  assert.match(xml, /<workingdirectory>%BASE%\\app<\/workingdirectory>/);
  assert.match(xml, /<env name="DATA_DIR" value="%ProgramData%\\AscStremio\\data"\s*\/>/);
  assert.match(xml, /<user>LocalService<\/user>/);
  assert.match(xml, /<domain>NT AUTHORITY<\/domain>/);
  assert.doesNotMatch(xml, /LocalSystem|<password>/i, 'nunca privilégio máximo nem senha no arquivo');
  assert.match(xml, /<startmode>Automatic<\/startmode>/);
  assert.match(xml, /<onfailure action="restart"/);
  assert.match(xml, /<resetfailure>/);
  assert.match(xml, /<logpath>%ProgramData%\\AscStremio\\data<\/logpath>/);
  assert.doesNotMatch(xml, /passkey|ASCSTREMIO_[A-Z_]*=|k=/i, 'sem segredo na configuração');
});

test('serviço do Windows: nenhuma porta nem modo LAN fixados no XML (vale a configuração do usuário)', () => {
  const xml = ler('windows', 'servico.xml');
  assert.doesNotMatch(xml, /BRIDGE_ALLOW_LAN|ASCSTREMIO_MODE|0\.0\.0\.0/);
  assert.doesNotMatch(xml, /name="(PORT|BRIDGE_PORT|CONFIG_PORT)"/);
});

test('build do instalador embute o WinSW com versão e SHA-256 fixados', () => {
  const build = ler('windows', 'build.sh');
  assert.match(build, /WINSW_VERSION=v2\.12\.0/);
  assert.match(build, /WINSW_SHA256=[0-9a-f]{64}/);
  assert.match(build, /WinSW\.NET461\.exe/);
  assert.match(build, /AscStremioServico\.exe/);
  assert.match(build, /AscStremioServico\.xml/);
  // Confere o hash antes de embutir, como já se faz com o Node.
  assert.match(build, /SHA-256 do WinSW não confere/);
});
