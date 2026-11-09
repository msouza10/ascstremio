const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const network = require('../src/network');
const rede = require('../src/rede-cli');
const { tmpdir } = require('./tmp-helper');

const H = 3600 * 1000;
const fakeClient = (extra = {}) => Object.assign(new EventEmitter(), { torrents: [], listening: true, destroyed: false, utp: true, address: () => ({ port: 7030 }) }, extra);
const wire = (type, remoteAddress) => ({ type, remoteAddress });

function clock() { const c = { t: 1_000_000 }; c.now = () => c.t; return c; }

test('classifyRemote: público, privado, CGNAT, loopback e IPv6', () => {
  const c = network.classifyRemote;
  assert.equal(c('8.8.8.8'), 'publico');
  assert.equal(c('::ffff:8.8.8.8'), 'publico');
  assert.equal(c('192.168.1.5'), 'privado');
  assert.equal(c('100.70.1.1'), 'privado');
  assert.equal(c('127.0.0.1'), 'loopback');
  assert.equal(c('::1'), 'loopback');
  assert.equal(c('fd00::1'), 'privado');
  assert.equal(c('2804:14c::1'), 'publico');
  assert.equal(c(undefined), 'desconhecido');
});

test('observador: conta só entrada, sem guardar endereço de peer', () => {
  const clk = clock();
  const obs = network.createPeerObserver({ now: clk.now });
  const client = fakeClient();
  const t = new EventEmitter();
  obs.attach(client);
  client.emit('torrent', t);
  t.emit('wire', wire('tcpOutgoing', '8.8.8.8'));
  t.emit('wire', wire('tcpIncoming', '127.0.0.1'));
  assert.equal(obs.snapshot().total, 0);
  clk.t += 1000;
  t.emit('wire', wire('tcpIncoming', '203.0.113.9'));
  t.emit('wire', wire('utpIncoming', '192.168.0.4'));
  const s = obs.snapshot();
  assert.equal(s.publico, 1);
  assert.equal(s.privado, 1);
  const dump = JSON.stringify(s) + JSON.stringify(network.evaluatePeerPort({ engine: network.engineState(client), observed: s, configuredPort: 7030 }));
  assert.ok(!dump.includes('203.0.113.9') && !dump.includes('192.168.0.4'));
});

test('observador: pega torrents que já existiam ao anexar', () => {
  const t = new EventEmitter();
  const obs = network.createPeerObserver();
  obs.attach(fakeClient({ torrents: [t] }));
  t.emit('wire', wire('tcpIncoming', '203.0.113.9'));
  assert.equal(obs.snapshot().publico, 1);
});

test('estados: desconhecido, sem_escuta (porta ocupada), escutando, sem_entrada, entrada_observada', () => {
  const clk = clock();
  const ev = (client, observed, extra) => network.evaluatePeerPort({ engine: network.engineState(client), observed, configuredPort: 7030, now: clk.t, ...extra });
  assert.equal(ev(null, null).state, 'desconhecido');
  assert.equal(ev(fakeClient({ destroyed: true }), null).state, 'sem_escuta');
  assert.match(ev(fakeClient({ destroyed: true }), null).summary, /ocupada/);
  assert.equal(ev(fakeClient({ listening: false }), null).state, 'sem_escuta');
  assert.equal(ev(fakeClient({ address() { throw new Error('x'); } }), null).state, 'desconhecido');
  const obs = network.createPeerObserver({ now: clk.now });
  const client = fakeClient();
  obs.attach(client);
  const t = new EventEmitter();
  client.emit('torrent', t);
  assert.equal(ev(client, obs.snapshot()).state, 'escutando');
  clk.t += 7 * H;
  const quiet = ev(client, obs.snapshot());
  assert.equal(quiet.state, 'sem_entrada');
  assert.match(quiet.summary, /não prova bloqueio/);
  t.emit('wire', wire('tcpIncoming', '192.168.1.9'));
  const lan = ev(client, obs.snapshot());
  assert.equal(lan.state, 'sem_entrada');
  assert.ok(lan.notes.some((n) => /não provam alcance pela internet/.test(n)));
  t.emit('wire', wire('tcpIncoming', '203.0.113.9'));
  const ok = ev(client, obs.snapshot());
  assert.equal(ok.state, 'entrada_observada');
  assert.equal(ok.layers.entrada.observada, 1);
});

test('escuta local nunca vira prova de alcance: firewall/NAT sempre desconhecido', () => {
  const r = network.evaluatePeerPort({ engine: { known: true, listening: true, port: 7030 }, configuredPort: 7030 });
  assert.equal(r.layers.firewallNat.estado, 'desconhecido');
  assert.notEqual(r.state, 'entrada_observada');
  assert.ok(r.advice.some((a) => /nunca abra as portas do addon/i.test(a)));
  assert.ok(r.notes.some((n) => /CGNAT/.test(n)));
});

test('porta aleatória e divergência de configuração geram nota', () => {
  const eng = { known: true, listening: true, port: 41234 };
  assert.ok(network.evaluatePeerPort({ engine: eng, configuredPort: 0 }).notes.some((n) => /TORRENT_PORT=0/.test(n)));
  assert.ok(network.evaluatePeerPort({ engine: eng, configuredPort: 7030 }).notes.some((n) => /Configurada 7030/.test(n)));
});

test('contêiner: publicação não verificável e origem mascarada', () => {
  const observed = { total: 1, publico: 0, privado: 1, desconhecido: 0, lastAt: 5, lastPublicAt: null, startedAt: 1, firstTorrentAt: 1 };
  const r = network.evaluatePeerPort({ engine: { known: true, listening: true, port: 7030 }, observed, configuredPort: 7030, container: true, now: 10 });
  assert.equal(r.layers.publicacao.modo, 'contêiner');
  assert.equal(r.layers.publicacao.verificavel, false);
  assert.ok(r.notes.some((n) => /docker port/.test(n)));
  assert.equal(r.state, 'entrada_observada');
  assert.match(r.summary, /mascarar/);
});

test('resumo em disco: leitura recente vale; velho, ausente ou corrompido é desconhecido', () => {
  const dir = tmpdir('peers-');
  assert.equal(network.readPeerStatus(dir).stale, true);
  const observed = { total: 0, publico: 0, privado: 0, desconhecido: 0, lastAt: null, lastPublicAt: null, startedAt: 1, firstTorrentAt: null };
  assert.ok(network.writePeerStatus(dir, { engine: { known: true, listening: true, port: 7030 }, observed }, 1000));
  assert.equal(network.readPeerStatus(dir, 1000 + 60000).engine.port, 7030);
  assert.equal(network.readPeerStatus(dir, 1000 + network.PEER_STATUS_FRESH_MS + 1).engine.known, false);
  fs.writeFileSync(path.join(dir, network.PEER_STATUS_FILE), '{ruim');
  assert.equal(network.readPeerStatus(dir).engine.known, false);
  if (process.platform !== 'win32') {
    network.writePeerStatus(dir, { engine: {}, observed });
    assert.equal(fs.statSync(path.join(dir, network.PEER_STATUS_FILE)).mode & 0o777, 0o600);
  }
});

test('CLI rede peers: sem processo em execução é desconhecido; com resumo recente mostra escuta', () => {
  const dir = tmpdir('peers-cli-');
  const env = { DATA_DIR: dir, TORRENT_PORT: '7030' };
  const out = [];
  assert.equal(rede.run(['peers'], { env, interfaces: {}, out: (l) => out.push(l) }), 0);
  assert.match(out.join('\n'), /DESCONHECIDO/);
  const now = 5_000_000;
  const observed = { total: 1, publico: 1, privado: 0, desconhecido: 0, lastAt: now - 1000, lastPublicAt: now - 1000, startedAt: now - 9000, firstTorrentAt: now - 8000 };
  network.writePeerStatus(dir, { engine: { known: true, listening: true, port: 7030, utp: true }, observed }, now - 1000);
  const out2 = [];
  assert.equal(rede.run(['peers', '--json'], { env, interfaces: {}, out: (l) => out2.push(l), now }), 0);
  const j = JSON.parse(out2.join('\n'));
  assert.equal(j.state, 'entrada_observada');
  assert.equal(j.layers.escuta.real, 7030);
  const out3 = [];
  rede.run([], { env, interfaces: {}, out: (l) => out3.push(l), now });
  assert.match(out3.join('\n'), /Porta de peers/);
});
