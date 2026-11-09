const { test } = require('node:test');
const assert = require('node:assert/strict');
const network = require('../src/network');
const settings = require('../src/settings');
const { hostAllowed } = require('../src/safety');
const rede = require('../src/rede-cli');
const { tmpdir } = require('./tmp-helper');

const nic = (address, family = 'IPv4', internal = false) => ({ address, family, internal, mac: '00:11:22:33:44:55', netmask: '255.255.255.0', cidr: null });

// Redes simuladas (nunca consultam o sistema).
const REDES = {
  ethernetWifi: {
    lo: [nic('127.0.0.1', 'IPv4', true), nic('::1', 'IPv6', true)],
    enp3s0: [nic('192.168.1.10'), nic('fe80::1', 'IPv6')],
    wlp2s0: [nic('192.168.1.20')],
  },
  soUma: { lo: [nic('127.0.0.1', 'IPv4', true)], enp3s0: [nic('192.168.1.10'), nic('fd12:3456::10', 'IPv6')] },
  docker: {
    lo: [nic('127.0.0.1', 'IPv4', true)],
    docker0: [nic('172.17.0.1')],
    'br-1a2b3c4d5e6f': [nic('172.18.0.1')],
    veth12ab: [nic('169.254.7.7')],
    enp3s0: [nic('192.168.1.10')],
  },
  vpn: { lo: [nic('127.0.0.1', 'IPv4', true)], tailscale0: [nic('100.101.102.103')], enp3s0: [nic('10.0.0.5')] },
  soVpn: { lo: [nic('127.0.0.1', 'IPv4', true)], tailscale0: [nic('100.101.102.103')] },
  windows: {
    'Loopback Pseudo-Interface 1': [nic('127.0.0.1', 'IPv4', true)],
    'vEthernet (WSL)': [nic('172.30.64.1')],
    'VirtualBox Host-Only Network': [nic('192.168.56.1')],
    'Wi-Fi': [nic('192.168.0.15')],
  },
  v6: { lo: [nic('::1', 'IPv6', true)], eth0: [nic('2804:14c:1::5', 'IPv6'), nic('fe80::5', 'IPv6')] },
  vazia: {},
};

const base = (extra) => ({ mode: 'lan', ports: { addon: 7000, bridge: 7010 }, ...extra });

test('candidatos: exclui loopback, link-local, docker e virtuais com a justificativa', () => {
  const c = network.listCandidates(REDES.docker);
  const por = (addr) => c.find((x) => x.address === addr);
  assert.equal(por('127.0.0.1').usable, false);
  assert.match(por('127.0.0.1').reason, /loopback/);
  assert.equal(por('172.17.0.1').kind, 'virtual');
  assert.match(por('172.17.0.1').reason, /virtual/);
  assert.equal(por('172.18.0.1').usable, false);
  assert.match(por('169.254.7.7').reason, /link-local/);
  assert.equal(por('192.168.1.10').auto, true);
  assert.ok(c.every((x) => !('mac' in x)), 'MAC nunca aparece');
});

test('candidatos: nomes de interface do Windows e IPv6', () => {
  const w = network.listCandidates(REDES.windows);
  assert.deepEqual(w.filter((x) => x.auto).map((x) => x.address), ['192.168.0.15']);
  const v6 = network.listCandidates(REDES.v6);
  assert.equal(v6.find((x) => x.address === '2804:14c:1::5').auto, true);
  assert.equal(v6.find((x) => x.address === 'fe80::5').usable, false);
  assert.equal(v6.find((x) => x.address === '::1').usable, false);
});

test('VPN/Tailscale: listada como escolha explícita, nunca automática', () => {
  const c = network.listCandidates(REDES.vpn).find((x) => x.address === '100.101.102.103');
  assert.equal(c.kind, 'vpn');
  assert.equal(c.usable, true);
  assert.equal(c.auto, false);
  const auto = network.evaluate(base({ interfaces: REDES.vpn }));
  assert.equal(auto.host, '10.0.0.5');
  assert.equal(auto.ambiguous, false);
  const sem = network.evaluate(base({ interfaces: REDES.soVpn }));
  assert.equal(sem.host, null);
  assert.match(sem.warnings.join(' '), /sem interface elegível/);
  const escolhida = network.evaluate(base({ interfaces: REDES.soVpn, advertiseHost: '100.101.102.103' }));
  assert.equal(escolhida.host, '100.101.102.103');
  assert.match(escolhida.warnings.join(' '), /VPN/);
});

test('parseHost: IPv4, IPv6, DNS e rejeições', () => {
  assert.deepEqual(network.parseHost('192.168.1.10'), { host: '192.168.1.10', kind: 'ipv4' });
  assert.deepEqual(network.parseHost('[2804:14C:1::5]'), { host: '2804:14c:1::5', kind: 'ipv6' });
  assert.deepEqual(network.parseHost(' NAS.Casa.lan '), { host: 'nas.casa.lan', kind: 'dns' });
  for (const ruim of ['', 'http://nas', 'nas:7000', '192.168.1.10:7010', 'nas/path', 'u@nas', '*.casa', 'a b', '127.0.0.1', '::1', '0.0.0.0',
    '169.254.1.1', 'fe80::1', 'fe80::1%eth0', 'localhost', 'x.localhost', '224.0.0.1', '300.1.1.1', '1.2.3', '-nas', '::ffff:1.2.3.4', 42]) {
    assert.ok(network.parseHost(ruim).error, `deveria recusar ${ruim}`);
  }
  assert.equal(network.urlHost('2804:14c:1::5'), '[2804:14c:1::5]');
});

test('modo local: loopback sem configuração; endereço LAN não tem efeito e avisa', () => {
  const p = network.evaluate({ mode: 'local', ports: { addon: 7000, bridge: 7010 }, interfaces: REDES.ethernetWifi });
  assert.equal(p.bind, '127.0.0.1');
  assert.equal(p.urls.addon, 'http://127.0.0.1:7000');
  assert.equal(p.urls.bridge, 'http://127.0.0.1:7010');
  assert.equal(p.candidates.length, 0, 'local não varre interfaces');
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.warnings, []);
  const w = network.evaluate({ mode: 'local', ports: { addon: 7000, bridge: 7010 }, advertiseHost: '192.168.1.10' });
  assert.match(w.warnings.join(' '), /não tem efeito no modo local/);
  assert.equal(w.urls.addon, 'http://127.0.0.1:7000');
  const u = network.evaluate({ mode: 'local', ports: { addon: 7000, bridge: 7010 }, bridgeUrl: 'http://192.168.1.10:7010' });
  assert.match(u.warnings.join(' '), /só em 127\.0\.0\.1/, 'URL fora do loopback com escuta só em loopback é inalcançável');
});

test('LAN com várias interfaces: ambiguidade avisada, seleção explícita resolve', () => {
  const amb = network.evaluate(base({ interfaces: REDES.ethernetWifi }));
  assert.equal(amb.ambiguous, true);
  assert.match(amb.warnings.join(' '), /Várias interfaces candidatas.*LAN_ADVERTISE_HOST/);
  const ip = network.evaluate(base({ interfaces: REDES.ethernetWifi, advertiseHost: '192.168.1.20' }));
  assert.equal(ip.ambiguous, false);
  assert.equal(ip.urls.addon, 'http://192.168.1.20:7000');
  assert.equal(ip.urls.bridge, 'http://192.168.1.20:7010');
  assert.equal(ip.sources.addon, 'config');
  const porIf = network.evaluate(base({ interfaces: REDES.ethernetWifi, interfaceName: 'wlp2s0' }));
  assert.equal(porIf.host, '192.168.1.20');
  assert.equal(porIf.hostSource, 'interface');
  const uma = network.evaluate(base({ interfaces: REDES.soUma }));
  assert.equal(uma.host, '192.168.1.10', 'IPv4 preferido sobre IPv6 na mesma interface');
  assert.equal(uma.ambiguous, false);
});

test('Docker no host: bridges e veth não entram na escolha automática', () => {
  const p = network.evaluate(base({ interfaces: REDES.docker }));
  assert.equal(p.host, '192.168.1.10');
  assert.equal(p.ambiguous, false);
  const sobreDocker = network.evaluate(base({ interfaces: REDES.docker, advertiseHost: '172.17.0.1' }));
  assert.match(sobreDocker.warnings.join(' '), /interface virtual docker0/);
});

test('IPv6 escolhido entra com colchetes nas URLs', () => {
  const p = network.evaluate(base({ interfaces: REDES.v6, advertiseHost: '2804:14c:1::5' }));
  assert.equal(p.urls.addon, 'http://[2804:14c:1::5]:7000');
  const auto = network.evaluate(base({ interfaces: REDES.v6 }));
  assert.equal(auto.host, '2804:14c:1::5');
});

test('endereço escolhido fora do host: aviso na partida, problema ao salvar (strict)', () => {
  const aviso = network.evaluate(base({ interfaces: REDES.ethernetWifi, advertiseHost: '192.168.1.99' }));
  assert.deepEqual(aviso.problems, []);
  assert.match(aviso.warnings.join(' '), /não pertence a nenhuma interface/);
  const estrito = network.evaluate(base({ interfaces: REDES.ethernetWifi, advertiseHost: '192.168.1.99', strict: true }));
  assert.match(estrito.problems.join(' '), /não pertence a nenhuma interface/);
});

test('nome DNS, proxy e NAT não precisam pertencer a uma interface', () => {
  const dns = network.evaluate(base({ interfaces: REDES.ethernetWifi, advertiseHost: 'nas.casa.lan', strict: true }));
  assert.deepEqual(dns.problems, []);
  assert.equal(dns.urls.addon, 'http://nas.casa.lan:7000');
  assert.match(dns.info.join(' '), /mDNS/);
  const urls = network.evaluate(base({ interfaces: REDES.ethernetWifi, bridgeUrl: 'https://proxy.casa/ponte', addonUrl: 'https://proxy.casa/addon', strict: true }));
  assert.deepEqual(urls.problems, []);
  assert.equal(urls.urls.bridge, 'https://proxy.casa/ponte');
  assert.equal(urls.sources.addon, 'url');
});

test('interface e endereço contraditórios, interface inexistente e sem interfaces', () => {
  const c = network.evaluate(base({ interfaces: REDES.ethernetWifi, advertiseHost: '192.168.1.20', interfaceName: 'enp3s0' }));
  assert.match(c.problems.join(' '), /se contradizem/);
  const perdida = network.evaluate(base({ interfaces: REDES.ethernetWifi, interfaceName: 'eth9' }));
  assert.match(perdida.warnings.join(' '), /não existe neste computador/);
  assert.equal(perdida.host, null);
  assert.equal(perdida.urls.addon, null, 'sem endereço, não inventa URL enganosa');
  const vazia = network.evaluate(base({ interfaces: REDES.vazia }));
  assert.equal(vazia.host, null);
  assert.match(vazia.warnings.join(' '), /nenhuma interface encontrada/);
});

test('contêiner: não adivinha pelas interfaces internas; exige endereço do host', () => {
  const sem = network.evaluate(base({ container: true, interfaces: { eth0: [nic('172.19.0.2')] } }));
  assert.match(sem.problems.join(' '), /BRIDGE_PUBLIC_URL ou LAN_ADVERTISE_HOST/);
  assert.equal(sem.host, null);
  const com = network.evaluate(base({ container: true, advertiseHost: '192.168.1.10', interfaces: { eth0: [nic('172.19.0.2')] }, strict: true }));
  assert.deepEqual(com.problems, []);
  assert.equal(com.urls.bridge, 'http://192.168.1.10:7010');
  assert.match(com.info.join(' '), /publicadas no host/);
  const local = network.evaluate({ mode: 'local', container: true, ports: { addon: 7000, bridge: 7010 }, interfaces: {} });
  assert.equal(local.urls.addon, 'http://127.0.0.1:7000');
  assert.equal(local.bind, '0.0.0.0');
});

test('interface perdida depois da partida: aviso sem alterar as URLs', () => {
  const p = network.evaluate(base({ interfaces: REDES.soUma }));
  const antes = JSON.stringify(p.urls);
  assert.equal(network.staleWarning(p, REDES.soUma), null);
  const depois = network.staleWarning(p, { lo: REDES.soUma.lo });
  assert.match(depois, /não está mais neste computador/);
  assert.match(depois, /reinstale o addon/);
  assert.equal(JSON.stringify(p.urls), antes);
  const dns = network.evaluate(base({ interfaces: REDES.soUma, advertiseHost: 'nas.casa.lan' }));
  assert.equal(network.staleWarning(dns, {}), null, 'nome DNS não é conferido por interface');
});

// --- integração com o esquema (settings) -----------------------------------------------

const novo = () => tmpdir('asc-rede-');

test('settings: LAN_ADVERTISE_HOST e LAN_INTERFACE validados no esquema', () => {
  const env = { ASCSTREMIO_MODE: 'lan' };
  const ok = settings.resolve({ dataDir: novo(), env: { ...env, LAN_ADVERTISE_HOST: '192.168.1.10' }, interfaces: REDES.ethernetWifi });
  assert.equal(ok.ok, true, ok.problems.join('; '));
  assert.equal(ok.derived.network.urls.addon, 'http://192.168.1.10:7000');
  const ruim = settings.resolve({ dataDir: novo(), env: { ...env, LAN_ADVERTISE_HOST: 'http://nas:7000' }, interfaces: REDES.ethernetWifi });
  assert.equal(ruim.ok, false);
  assert.match(ruim.problems.join(' '), /LAN_ADVERTISE_HOST.*sem http/);
  const comPorta = settings.resolve({ dataDir: novo(), env: { ...env, LAN_ADVERTISE_HOST: 'nas:7000' }, interfaces: REDES.ethernetWifi });
  assert.match(comPorta.problems.join(' '), /sem porta/);
});

test('settings: BRIDGE_PUBLIC_URL/ADDON_PUBLIC_URL explícitas prevalecem sobre o endereço escolhido', () => {
  const s = settings.resolve({
    dataDir: novo(), interfaces: REDES.ethernetWifi,
    env: { ASCSTREMIO_MODE: 'lan', LAN_ADVERTISE_HOST: '192.168.1.10', BRIDGE_PUBLIC_URL: 'https://proxy.casa/ponte' },
  });
  assert.equal(s.derived.network.urls.bridge, 'https://proxy.casa/ponte');
  assert.equal(s.derived.network.urls.addon, 'http://192.168.1.10:7000');
});

test('settings: partida tolera endereço antigo (aviso); salvar endereço de outro host é recusado sem gravar', () => {
  const dir = novo();
  const env = {};
  const r = settings.update({ dataDir: dir, env, expectedRevision: 0, interfaces: REDES.ethernetWifi, changes: { ASCSTREMIO_MODE: 'lan', LAN_ADVERTISE_HOST: '192.168.1.10' } });
  assert.equal(r.snapshot.derived.network.hostSource, 'config');
  assert.throws(
    () => settings.update({ dataDir: dir, env, expectedRevision: r.snapshot.revision, interfaces: REDES.ethernetWifi, changes: { LAN_ADVERTISE_HOST: '10.9.9.9' } }),
    /não pertence a nenhuma interface/,
  );
  assert.equal(settings.resolve({ dataDir: dir, env, interfaces: REDES.ethernetWifi }).values.LAN_ADVERTISE_HOST, '192.168.1.10', 'nada foi gravado');
  // IP mudou depois (DHCP): a partida continua possível e só avisa.
  const depois = settings.load({ dataDir: dir, env, interfaces: { enp3s0: [nic('192.168.1.77')] } });
  assert.match(depois.warnings.join(' '), /não pertence a nenhuma interface/);
  // Alterar outra opção com o endereço obsoleto não é bloqueado por um problema que já existia.
  assert.doesNotThrow(() => settings.update({ dataDir: dir, env, expectedRevision: depois.revision, interfaces: { enp3s0: [nic('192.168.1.77')] }, changes: { LOG_LEVEL: 'info' } }));
});

test('settings: valor imposto pelo ambiente não é sobrescrito', () => {
  const dir = novo();
  assert.throws(
    () => settings.update({ dataDir: dir, env: { LAN_ADVERTISE_HOST: 'nas.casa.lan' }, expectedRevision: 0, changes: { LAN_ADVERTISE_HOST: 'outro.casa.lan' } }),
    /definida pelo ambiente/,
  );
});

test('safety: o nome escolhido é aceito no Host; outros nomes e curingas continuam recusados', () => {
  const env = { LAN_ADVERTISE_HOST: 'nas.casa.lan' };
  assert.equal(hostAllowed('nas.casa.lan:7000', env), true);
  assert.equal(hostAllowed('NAS.casa.lan', env), true);
  assert.equal(hostAllowed('evil.example:7000', env), false);
  assert.equal(hostAllowed('outro.casa.lan', env), false);
  assert.equal(hostAllowed('192.168.1.10:7000', {}), true);
  assert.equal(hostAllowed('nas.casa.lan', {}), false);
});

// --- CLI de diagnóstico ---------------------------------------------------------------

function roda(args, env, interfaces) {
  const linhas = [];
  const code = rede.run(args, { env: { DATA_DIR: novo(), ...env }, interfaces, out: (l) => linhas.push(l) });
  return { code, texto: linhas.join('\n') };
}

test('rede: diagnóstico lista interfaces e justificativas, marca o alcance como desconhecido e não mostra token', () => {
  const r = roda([], { ASCSTREMIO_MODE: 'lan' }, REDES.docker);
  assert.equal(r.code, 0, r.texto);
  assert.match(r.texto, /docker0.*virtual/);
  assert.match(r.texto, /Alcance pelo aparelho cliente: desconhecido/);
  assert.match(r.texto, /\/<credencial>\/manifest\.json/);
  assert.doesNotMatch(r.texto, /ascc_/);
  const json = roda(['--json'], { ASCSTREMIO_MODE: 'lan' }, REDES.ethernetWifi);
  const obj = JSON.parse(json.texto);
  assert.equal(obj.ambigua, true);
  assert.equal(obj.alcancePeloCliente, 'unknown');
});

test('rede: modo local mostra loopback e nada de interfaces', () => {
  const r = roda([], {}, REDES.ethernetWifi);
  assert.equal(r.code, 0);
  assert.match(r.texto, /Modo: local; escuta em 127\.0\.0\.1/);
  assert.doesNotMatch(r.texto, /enp3s0/);
});

test('rede validar: simula a escolha sem gravar', () => {
  const bom = roda(['validar', '192.168.1.10'], {}, REDES.ethernetWifi);
  assert.equal(bom.code, 0, bom.texto);
  assert.match(bom.texto, /http:\/\/192\.168\.1\.10:7000/);
  const ruim = roda(['validar', '10.9.9.9'], {}, REDES.ethernetWifi);
  assert.equal(ruim.code, 1);
  assert.match(ruim.texto, /PROBLEMA:.*não pertence/);
  assert.equal(roda(['validar'], {}, REDES.ethernetWifi).code, 2);
});

test('credenciais: a URL de instalação usa o endereço anunciado, não o loopback', () => {
  const cli = require('../src/credenciais-cli');
  const lan = cli.config({ DATA_DIR: novo(), ASCSTREMIO_MODE: 'lan', LAN_ADVERTISE_HOST: 'nas.casa.lan' });
  assert.equal(lan.addon, 'http://nas.casa.lan:7000');
  assert.equal(cli.installUrl(lan, 'ascc_x'), 'http://nas.casa.lan:7000/ascc_x/manifest.json');
  const local = cli.config({ DATA_DIR: novo() });
  assert.equal(local.addon, 'http://127.0.0.1:7000');
});
