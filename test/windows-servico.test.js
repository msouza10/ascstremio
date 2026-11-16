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

test('bandeja do Windows: instância única, estados, menu em português e só fala com 127.0.0.1', () => {
  const ps = ler('windows', 'bandeja.ps1') + '\n' + ler('windows', 'bandeja-estado.ps1');
  // Só o código conta nas checagens de segredo: o cabeçalho explica o que a bandeja NÃO faz.
  const codigo = ps.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(ps, /Mutex/, 'uma só bandeja por usuário');
  assert.match(ps, /System\.Windows\.Forms/);
  assert.match(ps, /NotifyIcon/);
  assert.match(ps, /\$servico\s*=\s*'AscStremio'/);
  for (const estado of ['online', 'iniciando', 'parado']) assert.match(ps, new RegExp(`'${estado}'`), estado);
  for (const item of ['Abrir painel', 'Iniciar', 'Reiniciar', 'Parar', 'Ver logs', 'Pasta de dados', 'Sair da bandeja']) {
    assert.ok(ps.includes(item), `falta o item de menu "${item}"`);
  }
  // Painel e saúde sempre em loopback, com a porta efetiva pela CLI (não fixa).
  assert.match(ps, /http:\/\/127\.0\.0\.1:\$\{?porta/i);
  assert.match(ps, /credenciais-cli\.js'\s*,\s*'porta'/);
  assert.doesNotMatch(codigo, /0\.0\.0\.0|https?:\/\/(?!127\.0\.0\.1)[a-z]/i, 'nada fora do loopback');
  // A bandeja nunca toca em credencial, passkey nem token; não baixa nem executa texto de fora.
  assert.doesNotMatch(codigo, /passkey|credentials\.json|admin-key|bridge-key|[?&]k=|ascc_/i);
  assert.doesNotMatch(codigo, /Invoke-Expression|\biex\b|DownloadString|Invoke-WebRequest|Invoke-RestMethod/i);
});

test('bandeja do Windows: o launcher abre o PowerShell oculto e o pacote o grava com BOM para manter os acentos', () => {
  const vbs = ler('windows', 'bandeja.vbs');
  assert.match(vbs, /powershell/i);
  assert.match(vbs, /-WindowStyle Hidden/);
  assert.match(vbs, /bandeja\.ps1/);
  assert.match(vbs, /, 0, False/, 'janela oculta e sem esperar');
  const prepare = ler('windows', 'prepare-scripts.js');
  assert.match(prepare, /ps1/);
  assert.match(prepare, /\\ufeff/i, 'PowerShell 5.1 só lê UTF-8 com BOM');
});

test('atalhos do Windows controlam o serviço (sc) e usam os dados em ProgramData', () => {
  assert.ok(!fs.existsSync(path.join(raiz, 'windows', 'launcher.vbs')), 'o processo oculto sem supervisão foi substituído pelo serviço');
  assert.match(ler('windows', 'start.cmd'), /sc start AscStremio/);
  assert.match(ler('windows', 'stop.cmd'), /sc stop AscStremio/);
  assert.match(ler('windows', 'parar-bandeja.cmd'), /bandeja\.ps1/);
  for (const nome of ['start.cmd', 'stop.cmd', 'open-panel.cmd', 'configurar.cmd', 'credenciais.cmd', 'parar-bandeja.cmd']) {
    const txt = ler('windows', nome);
    assert.doesNotMatch(txt, /launcher\.vbs|LOCALAPPDATA/i, `${nome} ainda aponta para o modelo antigo`);
  }
  for (const nome of ['open-panel.cmd', 'configurar.cmd', 'credenciais.cmd']) {
    assert.match(ler('windows', nome), /DATA_DIR=%ProgramData%\\AscStremio\\data/, nome);
  }
  // O painel abre na porta efetiva e a bandeja sobe junto (instância única).
  const abrir = ler('windows', 'open-panel.cmd');
  assert.match(abrir, /credenciais-cli\.js porta painel/);
  assert.match(abrir, /bandeja\.vbs/);
});

test('instalador do Windows: serviço, administrador, ACL dos dados e migração sem apagar nada', () => {
  const nsi = ler('windows', 'installer.nsi');
  assert.match(nsi, /RequestExecutionLevel admin/);
  assert.match(nsi, /InstallDir "\$PROGRAMFILES64\\AscStremio"/);
  assert.match(nsi, /SetRegView 64/);
  assert.match(nsi, /AscStremioServico\.exe" install/);
  assert.match(nsi, /AscStremioServico\.exe" (stop|uninstall)/);
  // Dados do serviço só para SYSTEM, administradores, LocalService e quem instalou; sem herança do ProgramData.
  assert.match(nsi, /icacls .*\/inheritance:r/);
  assert.match(nsi, /\*S-1-5-19/);
  assert.match(nsi, /\*S-1-5-18/);
  assert.match(nsi, /\*S-1-5-32-544/);
  // O usuário comum controla só este serviço, sem UAC (a bandeja reinicia por aí).
  assert.match(nsi, /sc sdset AscStremio/);
  // Migra os dados do modelo antigo movendo (nunca copia dezenas de GB nem sobrescreve o destino).
  // Lido do ambiente: $LOCALAPPDATA muda com SetShellVarContext all e apontaria para outro lugar.
  assert.match(nsi, /ReadEnvStr \$R5 LOCALAPPDATA/);
  assert.match(nsi, /Rename "\$R5\\AscStremio\\data" "\$R9\\AscStremio\\data"/);
  assert.doesNotMatch(nsi, /\$LOCALAPPDATA/, 'nenhum caminho do usuário pode depender do contexto de $LOCALAPPDATA');
  // Bandeja no início do Windows; o serviço sobe por conta própria (startmode Automatic).
  assert.match(nsi, /bandeja\.vbs/);
  assert.doesNotMatch(nsi, /launcher\.vbs/);
  // Desinstalar remove o serviço, mas mantém passkey, sessão e cofre de seed.
  assert.match(nsi, /Section "Uninstall"[\s\S]*AscStremioServico\.exe" uninstall/);
  assert.doesNotMatch(nsi, /RMDir \/r "\$(COMMONAPPDATA|PROGRAMDATA)|RMDir \/r "\$APPDATA/i);
  // O registro de desinstalação agora é da máquina (HKLM); do HKCU só se remove a chave do modelo antigo.
  assert.doesNotMatch(nsi, /WriteReg\w+ HKCU/);
  assert.match(nsi, /DeleteRegKey HKCU/);
});

test('bandeja do Windows: a lógica de estado é separada e o modo -SomenteEstado dispensa a interface', () => {
  const ui = ler('windows', 'bandeja.ps1');
  const estado = ler('windows', 'bandeja-estado.ps1');
  assert.match(ui, /^\s*param\(\s*\[switch\]\$SomenteEstado\s*\)/m);
  assert.match(ui, /bandeja-estado\.ps1/);
  // O modo de teste imprime o estado e sai antes de criar mutex, ícone ou qualquer janela.
  const iSomente = ui.indexOf('if ($SomenteEstado)');
  assert.ok(iSomente > 0, 'falta o desvio do modo -SomenteEstado');
  for (const marca of ['Add-Type', 'Mutex', 'NotifyIcon']) {
    assert.ok(ui.indexOf(marca) > iSomente, `${marca} deve vir depois do desvio de -SomenteEstado`);
  }
  for (const funcao of ['Obter-Porta', 'Saude-Ok', 'Obter-Estado']) {
    assert.match(estado, new RegExp(`function ${funcao}\\b`), funcao);
    assert.doesNotMatch(ui, new RegExp(`function ${funcao}\\b`), `${funcao} só existe no módulo de estado`);
  }
  assert.match(ler('windows', 'build.sh'), /windows\/bandeja-estado\.ps1/);
});

// O makensis não roda no desenvolvimento local: um rótulo mal escrito só apareceria no CI.
test('instalador do Windows: todo salto (Goto, IfFileExists, IfErrors, StrCmp) aponta para um rótulo que existe', () => {
  const linhas = ler('windows', 'installer.nsi').split('\n').map((l) => l.replace(/;.*$/, '').trim());
  const rotulos = new Set(linhas.map((l) => /^([A-Za-z_]\w*):$/.exec(l)?.[1]).filter(Boolean));
  const destino = (t) => t !== undefined && !/^(0|[+-]\d+)$/.test(t) && !t.startsWith('$') && !t.startsWith('"');
  const saltos = [];
  for (const l of linhas) {
    let m;
    if ((m = /^Goto\s+(\S+)/.exec(l))) saltos.push(m[1]);
    else if ((m = /^IfFileExists\s+(?:"[^"]*"|\S+)\s+(\S+)\s+(\S+)/.exec(l))) saltos.push(m[1], m[2]);
    else if ((m = /^IfErrors\s+(\S+)\s+(\S+)/.exec(l))) saltos.push(m[1], m[2]);
    else if ((m = /^StrCmp\s+\S+\s+\S+\s+(\S+)(?:\s+(\S+))?/.exec(l))) saltos.push(m[1], m[2]);
  }
  const alvos = saltos.filter(destino);
  assert.ok(alvos.length >= 8, 'o teste deveria enxergar os saltos do instalador');
  for (const a of alvos) assert.ok(rotulos.has(a), `salto para rótulo inexistente: ${a}`);
  // Rótulo repetido faz o makensis falhar.
  const todos = linhas.map((l) => /^([A-Za-z_]\w*):$/.exec(l)?.[1]).filter(Boolean);
  assert.equal(new Set(todos).size, todos.length, 'rótulo duplicado');
});

test('configuração do serviço: XML bem formado com uma só raiz e sem tags soltas', () => {
  const xml = ler('windows', 'servico.xml').replace(/<!--[\s\S]*?-->/g, '');
  const pilha = [];
  for (const [, fecha, nome, autofecha] of xml.matchAll(/<(\/?)([A-Za-z][\w-]*)[^>]*?(\/?)>/g)) {
    if (autofecha) continue;
    if (!fecha) pilha.push(nome);
    else assert.equal(pilha.pop(), nome, `tag </${nome}> fora de ordem`);
  }
  assert.deepEqual(pilha, [], 'tags sem fechar');
  assert.equal((xml.match(/<service>/g) ?? []).length, 1);
});
