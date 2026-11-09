// Retenção por orçamento (issue #27): prévia, execução confirmada e tudo que NÃO pode ser apagado.
// Tracker, relógio e motor são simulados; os arquivos são reais, pequenos, em pasta temporária.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const hnr = require('../src/hnr-guard');
const retention = require('../src/retention');
const settings = require('../src/settings');
const cli = require('../src/retencao-cli');
const { tmpdir } = require('./tmp-helper');

const DAY = 86_400_000;
const BLOCO = 8192;
const ADMIN_KEY = 'ab'.repeat(16);
const LOCAL = { remoteAddress: '127.0.0.1' };
const h = (n) => String(n).padStart(40, '0');

// Cenário: relógio simulado, store real, ponte com motor falso e tracker simulado.
function cenario({ budgetBlocos = 2, maxTitles = 0, minAgeDays = 30, mode = 'preview' } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const store = tmpdir('ret-store-');
  const vault = new SeedVault({ file: path.join(tmpdir('ret-vault-'), 'v.json'), now: () => clock.t });
  const b = new Bridge({
    torrentDir: '/tmp', storeDir: store, port: 7094, vault, adminKey: ADMIN_KEY,
    retention: { mode, budgetBytes: budgetBlocos * BLOCO, maxTitles, minAgeDays },
  });
  b.client = { torrents: [] };
  const tracker = { falha: null, chamadas: [], reabre: new Set(), durante: null };
  b.trackerCheck = async (hashes, opts) => {
    tracker.chamadas.push({ hashes, opts });
    tracker.durante?.(hashes);
    if (tracker.falha === 'lanca') throw new Error('rede');
    if (tracker.falha === 'failed') return { checked: 0, failed: 1 };
    if (tracker.falha === 'vazio') return undefined;
    for (const x of hashes) {
      const e = vault.get(x);
      if (!e) continue;
      if (tracker.reabre.has(x)) { e.tracker = { ...e.tracker, satisfied: false, checkedAt: clock.t }; e.satisfiedAt = null; continue; }
      e.tracker = { ...e.tracker, checkedAt: clock.t };
    }
    return { checked: hashes.length, failed: 0 };
  };
  // Cria um título concluído e confirmado pelo tracker, `idade` dias sem uso.
  const add = (n, { idade = 60, blocos = 1, confirmado = true, ascId = 100 + n, arquivos = null } = {}) => {
    const hash = h(n);
    const rel = `Filme ${n}/filme.mkv`;
    fs.mkdirSync(path.join(store, `Filme ${n}`), { recursive: true });
    fs.writeFileSync(path.join(store, rel), Buffer.alloc(blocos * BLOCO, 1));
    b.entries.set(hash, { infoHash: hash, torrentPath: `/x/asc-${ascId}.torrent`, files: arquivos ?? [{ path: rel, length: blocos * BLOCO }] });
    const e = vault.markSeen(hash, { name: `Filme ${n}`, torrentPath: `/x/asc-${ascId}.torrent` });
    e.firstSeenAt = clock.t - (idade + 5) * DAY;
    e.completedAt = clock.t - (idade + 4) * DAY;
    if (confirmado) {
      e.satisfiedAt = clock.t - idade * DAY;
      e.tracker = { satisfied: true, hitAndRun: false, checkedAt: clock.t - DAY };
    } else {
      e.tracker = { satisfied: false, hitAndRun: false, checkedAt: clock.t - DAY };
    }
    e.lastUsedAt = clock.t - idade * DAY;
    return { hash, rel, full: path.join(store, rel) };
  };
  return { b, store, vault, clock, tracker, add, R: b.retention };
}

const existe = (p) => fs.existsSync(p);

test('desligada por padrão: o esquema e a ponte sem opção não calculam nem removem nada', () => {
  const def = (k) => settings.SCHEMA.find((e) => e.key === k).default;
  assert.equal(def('RETENTION_MODE'), 'off');
  assert.equal(def('RETENTION_BUDGET_GIB'), 0);
  assert.equal(def('RETENTION_MAX_TITLES'), 0);
  const b = new Bridge({ torrentDir: '/tmp', storeDir: tmpdir('ret-off-'), port: 7094, vault: new SeedVault({ file: path.join(tmpdir('ret-offv-'), 'v.json') }) });
  const p = b.retention.preview();
  assert.equal(p.desligada, true);
  assert.equal(p.plano, null);
  assert.equal(p.candidatos.length, 0);
});

test('prévia: mais antigo por último uso primeiro, para ao caber no orçamento e não remove nada', () => {
  const c = cenario({ budgetBlocos: 2 });
  const a = c.add(1, { idade: 90 });
  const m = c.add(2, { idade: 200 }); // o mais antigo
  const n = c.add(3, { idade: 45 });
  const d = c.add(4, { idade: 31 });
  const p = c.R.preview();
  // 4 blocos em disco, orçamento 2: sai 2 e 1 (os mais antigos).
  assert.deepEqual(p.candidatos.map((x) => x.infoHash), [m.hash, a.hash]);
  assert.equal(p.candidatos[0].motivo, 'excede-orcamento');
  assert.equal(p.bytesEstimados, 2 * BLOCO);
  assert.equal(p.alvoAtingido, true);
  assert.equal(p.executavel, true);
  assert.match(p.plano, /^[0-9a-f]{12}$/);
  for (const x of [a, m, n, d]) assert.ok(existe(x.full), 'prévia nunca remove');
  assert.equal(c.tracker.chamadas.length, 0, 'prévia não consulta a rede');
  assert.ok(!JSON.stringify(p).includes(c.store), 'sem caminho absoluto na resposta');
});

test('limite de títulos e orçamento juntos; sem nenhum limite nada é selecionado', () => {
  const c = cenario({ budgetBlocos: 0, maxTitles: 2 });
  c.add(1, { idade: 90 }); c.add(2, { idade: 100 }); c.add(3, { idade: 40 });
  const p = c.R.preview();
  assert.equal(p.candidatos.length, 1);
  assert.equal(p.candidatos[0].infoHash, h(2));
  assert.equal(p.candidatos[0].motivo, 'excede-titulos');
  const semLimite = cenario({ budgetBlocos: 0, maxTitles: 0 });
  semLimite.add(1, { idade: 400 });
  const q = semLimite.R.preview();
  assert.equal(q.candidatos.length, 0);
  assert.match(q.avisos.join(' '), /defina RETENTION_BUDGET_GIB/);
});

test('select: empate no último uso é decidido pelo infoHash', () => {
  const itens = [h(9), h(3), h(5)].map((infoHash) => ({ infoHash, bytes: 10, lastUse: 5, eligible: true }));
  const r = retention.select(itens, { budgetBytes: 10, maxTitles: 0 });
  assert.deepEqual(r.candidates.map((x) => x.infoHash), [h(3), h(5)]);
});

test('o que o tracker não confirmou, está em uso, é recente ou é incompleto nunca é candidato', () => {
  const c = cenario({ budgetBlocos: 1 });
  const aberta = c.add(1, { confirmado: false });
  const hnrT = c.add(2); c.vault.get(hnrT.hash).tracker.hitAndRun = true;
  const recente = c.add(3, { idade: 5 });
  const tocando = c.add(4); c.b.streams.set(tocando.hash, 1);
  const sessao = c.add(5); c.b.limiter.acquire('cred', `s:${sessao.hash}:0`);
  const abrindo = c.add(6); c.b.loading.set(abrindo.hash, Promise.resolve());
  const incompleto = c.add(7); c.vault.get(incompleto.hash).completedAt = null;
  const novo = c.add(8, { idade: 0.5 }); // confirmado há 12 h: dentro do período de segurança
  const cobrado = c.add(9); c.b.trackerPending = [{ ascId: '109' }];
  const motor = c.add(10); c.b.client.torrents.push({ infoHash: motor.hash, ready: true, done: false, destroy() { throw new Error('não deve encerrar'); } });
  const ok = c.add(11);
  const p = c.R.preview();
  const motivo = Object.fromEntries(p.protegidos.map((x) => [x.infoHash, x.motivo]));
  assert.equal(motivo[aberta.hash], 'obrigacao-aberta');
  assert.equal(motivo[hnrT.hash], 'hit-and-run');
  assert.equal(motivo[recente.hash], 'uso-recente');
  assert.equal(motivo[tocando.hash], 'reproducao-ativa');
  assert.equal(motivo[sessao.hash], 'sessao-recente');
  assert.equal(motivo[abrindo.hash], 'em-andamento');
  assert.equal(motivo[incompleto.hash], 'incompleto');
  assert.equal(motivo[novo.hash], 'recem-confirmado');
  assert.equal(motivo[cobrado.hash], 'tracker-ainda-cobra');
  assert.equal(motivo[motor.hash], 'em-andamento');
  assert.ok(p.candidatos.every((x) => x.infoHash === ok.hash), 'só o título sem impedimento pode ser candidato');
});

test('execução: exige o plano, relê o tracker, remove só a lista e preserva .torrent e cofre', async () => {
  const c = cenario({ budgetBlocos: 2 });
  const velho = c.add(1, { idade: 200 });
  const velho2 = c.add(2, { idade: 90 });
  const fica = c.add(3, { idade: 40 });
  const fica2 = c.add(4, { idade: 35 });
  const protegido = c.add(5, { idade: 500, confirmado: false });
  const orfao = path.join(c.store, 'sem-dono.bin');
  fs.writeFileSync(orfao, Buffer.alloc(BLOCO, 2));
  c.R.budgetBytes = 3 * BLOCO; // 5 títulos em disco: precisa sair 2 (o protegido não conta como removível)
  const p = c.R.preview();
  assert.deepEqual(p.candidatos.map((x) => x.infoHash), [velho.hash, velho2.hash]);
  await assert.rejects(c.R.run(undefined), (e) => e.status === 409);
  await assert.rejects(c.R.run('0123456789ab'), (e) => e.status === 409 && /plano/.test(e.message));
  assert.ok(existe(velho.full), 'sem plano válido nada sai');

  const r = await c.R.run(p.plano);
  assert.deepEqual(r.removidos.map((x) => x.infoHash), [velho.hash, velho2.hash]);
  assert.equal(r.alvoAtingido, true);
  assert.equal(c.tracker.chamadas.length, 1);
  assert.deepEqual(c.tracker.chamadas[0].opts, { force: true }, 'releitura forçada do tracker');
  for (const x of [velho, velho2]) {
    assert.ok(!existe(x.full), 'removido');
    assert.ok(!existe(path.dirname(x.full)), 'pasta vazia aparada');
    assert.equal(c.vault.get(x.hash).releasedAs, 'retencao');
    assert.ok(c.b.entries.has(x.hash), 'entrada da biblioteca (.torrent) preservada');
  }
  for (const x of [fica, fica2, protegido]) assert.ok(existe(x.full), 'fora da lista: intacto');
  assert.ok(existe(orfao), 'órfão nunca é removido');
  assert.ok(existe(c.store), 'a raiz do store permanece');
  assert.ok(!JSON.stringify(r).includes(c.store));
  await assert.rejects(c.R.run(p.plano), (e) => e.status === 409, 'o plano vale uma vez');
});

test('tracker indisponível (lança, falha ou sem resposta): nada é removido', async () => {
  for (const modo of ['lanca', 'failed', 'vazio']) {
    const c = cenario({ budgetBlocos: 1 });
    const x = c.add(1, { idade: 90 }); c.add(2, { idade: 40 });
    const p = c.R.preview();
    assert.equal(p.candidatos.length, 1);
    c.tracker.falha = modo;
    await assert.rejects(c.R.run(p.plano), (e) => e.status === 503 && /nada foi removido/.test(e.message), modo);
    assert.ok(existe(x.full), modo);
    assert.equal(c.vault.get(x.hash).releasedAs, undefined);
    assert.equal(c.R.busy, false, 'a trava é liberada');
  }
});

test('sem trackerCheck configurado a execução falha fechada', async () => {
  const c = cenario({ budgetBlocos: 1 });
  const x = c.add(1, { idade: 90 }); c.add(2, { idade: 40 });
  const p = c.R.preview();
  c.b.trackerCheck = null;
  await assert.rejects(c.R.run(p.plano), (e) => e.status === 503);
  assert.ok(existe(x.full));
});

test('conferência fresca: o tracker que reabre a obrigação, ou não revalida o título, tira-o da lista', async () => {
  const c = cenario({ budgetBlocos: 2 });
  const reaberto = c.add(1, { idade: 300 });
  const naoLido = c.add(2, { idade: 200 });
  const sai = c.add(3, { idade: 100 });
  c.add(4, { idade: 40 }); c.add(5, { idade: 35 });
  const p = c.R.preview();
  assert.deepEqual(p.candidatos.map((x) => x.infoHash), [reaberto.hash, naoLido.hash, sai.hash]);
  c.tracker.reabre.add(reaberto.hash);
  const base = c.b.trackerCheck;
  c.b.trackerCheck = async (hashes, opts) => base(hashes.filter((x) => x !== naoLido.hash), opts); // tracker sem registro para ele
  const r = await c.R.run(p.plano);
  assert.deepEqual(r.removidos.map((x) => x.infoHash), [sai.hash]);
  assert.deepEqual(Object.fromEntries(r.ignorados.map((x) => [x.infoHash, x.motivo])), {
    [reaberto.hash]: 'obrigacao-aberta', [naoLido.hash]: 'tracker-nao-revalidado',
  });
  assert.ok(existe(reaberto.full) && existe(naoLido.full));
  assert.equal(r.alvoAtingido, false, 'meta não atingida é informada, sem remover mais nada além da lista');
});

test('corrida com play: reprodução que começa depois da prévia ou durante a conferência do tracker salva o título', async () => {
  const c = cenario({ budgetBlocos: 1 });
  const a = c.add(1, { idade: 90 });
  const b2 = c.add(2, { idade: 80 });
  c.add(3, { idade: 40 });
  const p = c.R.preview();
  assert.deepEqual(p.candidatos.map((x) => x.infoHash), [a.hash, b2.hash]);
  c.b.streams.set(a.hash, 1); // play depois da prévia
  c.tracker.durante = () => { c.b.limiter.acquire('cred', `s:${b2.hash}:0`); }; // play durante a conferência
  const r = await c.R.run(p.plano);
  assert.equal(r.removidos.length, 0);
  assert.deepEqual(r.ignorados.map((x) => x.motivo).sort(), ['reproducao-ativa', 'sessao-recente']);
  assert.ok(existe(a.full) && existe(b2.full));
});

test('durante a remoção o título fica em manutenção: getTorrent responde 503 e não reabre', async () => {
  const c = cenario({ budgetBlocos: 1 });
  const a = c.add(1, { idade: 90 }); c.add(2, { idade: 40 });
  let durante = null;
  c.b.client.torrents.push({
    infoHash: a.hash, ready: true, done: true,
    destroy(opts, cb) {
      durante = { retiring: c.R.isRetiring(a.hash), opts };
      c.b.getTorrent(a.hash).then(() => assert.fail('não pode abrir'), (e) => { durante.status = e.status; durante.expose = e.expose; cb(); });
    },
  });
  const p = c.R.preview();
  const r = await c.R.run(p.plano);
  assert.equal(durante.retiring, true);
  assert.equal(durante.opts.destroyStore, false, 'o motor não apaga: quem apaga é a retenção, com contenção de caminho');
  assert.equal(durante.status, 503);
  assert.equal(durante.expose, true);
  assert.equal(r.removidos.length, 1);
  assert.equal(c.R.isRetiring(a.hash), false);
  assert.ok(!existe(a.full));
});

test('falha ao encerrar o torrent: os arquivos não são tocados', async () => {
  const c = cenario({ budgetBlocos: 1 });
  const a = c.add(1, { idade: 90 }); c.add(2, { idade: 40 });
  c.b.client.torrents.push({ infoHash: a.hash, ready: true, done: true, destroy(_o, cb) { cb(new Error('boom')); } });
  const r = await c.R.run(c.R.preview().plano);
  assert.equal(r.removidos.length, 0);
  assert.equal(r.falhas[0].motivo, 'falha-ao-encerrar-o-torrent');
  assert.ok(existe(a.full));
});

test('orçamento inalcançável ou nenhum candidato seguro: sem plano, sem execução', async () => {
  const c = cenario({ budgetBlocos: 1 });
  c.add(1, { idade: 90 });
  c.add(2, { idade: 90, confirmado: false }); // 3 blocos, orçamento 1 e só 1 removível: não chega lá
  c.add(3, { idade: 90, confirmado: false });
  const p = c.R.preview();
  assert.equal(p.alvoAtingido, false);
  assert.equal(p.executavel, false);
  assert.equal(p.plano, null);
  assert.match(p.avisos.join(' '), /inalcançável/);
  assert.ok(p.candidatos.length > 0, 'a lista é informativa');
  await assert.rejects(c.R.run('aaaaaaaaaaaa'), (e) => e.status === 409);

  const nenhum = cenario({ budgetBlocos: 1 });
  nenhum.add(1, { idade: 90, confirmado: false }); nenhum.add(2, { idade: 90, confirmado: false });
  const q = nenhum.R.preview();
  assert.equal(q.candidatos.length, 0);
  assert.equal(q.executavel, false);
});

test('obrigações externas ao cofre: título cobrado pelo tracker sem estar no cofre/biblioteca não entra', () => {
  const c = cenario({ budgetBlocos: 1 });
  c.add(1, { idade: 90 }); c.add(2, { idade: 90 });
  // Arquivo na pasta sem entrada na biblioteca (outra instância/obrigação desconhecida): só aviso.
  fs.writeFileSync(path.join(c.store, 'externo.mkv'), Buffer.alloc(BLOCO));
  c.b.setActivity({ summary: null, pending: [{ ascId: '999' }] });
  const p = c.R.preview();
  assert.match(p.avisos.join(' '), /fora da biblioteca/);
  assert.ok(p.candidatos.every((x) => [h(1), h(2)].includes(x.infoHash)));
  assert.ok(existe(path.join(c.store, 'externo.mkv')));
});

test('caminho do .torrent com traversal ou absoluto torna o título inseguro e nada fora do store é tocado', async () => {
  const c = cenario({ budgetBlocos: 1 });
  const fora = path.join(tmpdir('ret-fora-'), 'precioso.txt');
  fs.writeFileSync(fora, 'não apague');
  const ruim = c.add(1, { idade: 90, arquivos: [{ path: path.relative(c.store, fora), length: 10 }] });
  const abs = c.add(2, { idade: 91, arquivos: [{ path: fora, length: 10 }] });
  c.add(3, { idade: 40 });
  c.add(4, { idade: 35 });
  const p = c.R.preview();
  const motivos = Object.fromEntries(p.protegidos.map((x) => [x.infoHash, x.motivo]));
  assert.equal(motivos[ruim.hash], 'arquivo-inseguro:caminho-invalido');
  assert.equal(motivos[abs.hash], 'arquivo-inseguro:caminho-invalido');
  assert.equal(retention.removeFiles(c.store, [path.relative(c.store, fora)]).removed, 0);
  assert.equal(fs.readFileSync(fora, 'utf8'), 'não apague');
});

test('symlink de arquivo ou de pasta que aponta para fora do store não é seguido', (t) => {
  const c = cenario({ budgetBlocos: 1 });
  const foraDir = tmpdir('ret-fora2-');
  const alvo = path.join(foraDir, 'filme-externo.mkv');
  fs.writeFileSync(alvo, Buffer.alloc(BLOCO));
  try {
    fs.mkdirSync(path.join(c.store, 'S1'));
    fs.symlinkSync(alvo, path.join(c.store, 'S1', 'link.mkv'));
    fs.symlinkSync(foraDir, path.join(c.store, 'S2'), 'dir');
  } catch (err) { t.skip(`symlink indisponível: ${err.code}`); return; }
  const a = c.add(1, { idade: 90, arquivos: [{ path: 'S1/link.mkv', length: BLOCO }] });
  const b2 = c.add(2, { idade: 91, arquivos: [{ path: 'S2/filme-externo.mkv', length: BLOCO }] });
  c.add(3, { idade: 40 });
  const p = c.R.preview();
  const motivos = Object.fromEntries(p.protegidos.map((x) => [x.infoHash, x.motivo]));
  assert.equal(motivos[a.hash], 'arquivo-inseguro:symlink');
  assert.equal(motivos[b2.hash], 'arquivo-inseguro:symlink');
  assert.equal(retention.removeFiles(c.store, ['S1/link.mkv', 'S2/filme-externo.mkv']).removed, 0);
  assert.ok(existe(alvo), 'o alvo fora do store sobrevive');
  assert.ok(fs.lstatSync(path.join(c.store, 'S1', 'link.mkv')).isSymbolicLink());
});

test('arquivo compartilhado entre títulos e link físico protegem o título', (t) => {
  const c = cenario({ budgetBlocos: 1 });
  const a = c.add(1, { idade: 90 });
  const b2 = c.add(2, { idade: 91, arquivos: [{ path: a.rel, length: BLOCO }] }); // mesmo arquivo
  c.add(3, { idade: 40 });
  const solto = c.add(4, { idade: 95 });
  try { fs.linkSync(solto.full, path.join(c.store, 'copia-fisica.bin')); } catch { t.diagnostic('link físico indisponível'); }
  const p = c.R.preview();
  const motivos = Object.fromEntries(p.protegidos.map((x) => [x.infoHash, x.motivo]));
  assert.equal(motivos[a.hash], 'arquivo-compartilhado');
  assert.equal(motivos[b2.hash], 'arquivo-compartilhado');
  if (fs.statSync(solto.full).nlink > 1) assert.equal(motivos[solto.hash], 'arquivo-inseguro:link-fisico');
});

test('arquivo ausente conta zero e título sem dados em disco não é candidato', () => {
  const c = cenario({ budgetBlocos: 1 });
  const a = c.add(1, { idade: 90 });
  fs.rmSync(a.full);
  c.add(2, { idade: 90 }); c.add(3, { idade: 80 });
  const p = c.R.preview();
  assert.ok(p.candidatos.every((x) => x.infoHash !== a.hash));
  assert.equal(p.totalTitulos, 2);
});

test('arquivo que não pode ser removido (em uso) permanece, é reportado e a execução segue', async (t) => {
  const c = cenario({ budgetBlocos: 1 });
  const a = c.add(1, { idade: 90, blocos: 1 });
  c.add(2, { idade: 40 });
  const original = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (p) => { if (String(p).endsWith('filme.mkv') && String(p).includes('Filme 1')) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return original(p); });
  const r = await c.R.run(c.R.preview().plano);
  assert.equal(r.removidos.length, 1);
  assert.equal(r.removidos[0].bytes, 0);
  assert.equal(r.falhas[0].detalhes[0].reason, 'em-uso');
  assert.ok(existe(a.full));
  assert.equal(c.vault.get(a.hash).releasedAs, undefined, 'nada removido, não marca liberado');
});

test('modo off recusa a execução mesmo com plano antigo', async () => {
  const c = cenario({ budgetBlocos: 1 });
  c.add(1, { idade: 90 }); c.add(2, { idade: 40 });
  const p = c.R.preview();
  c.R.mode = 'off';
  await assert.rejects(c.R.run(p.plano), (e) => e.status === 409 && /desligada/.test(e.message));
});

test('plano expira com o relógio', async () => {
  const c = cenario({ budgetBlocos: 1 });
  const a = c.add(1, { idade: 90 }); c.add(2, { idade: 40 });
  const p = c.R.preview();
  c.clock.t += 11 * 60_000;
  await assert.rejects(c.R.run(p.plano), (e) => e.status === 409);
  assert.ok(existe(a.full));
});

test('execuções simultâneas: a segunda é recusada', async () => {
  const c = cenario({ budgetBlocos: 1 });
  c.add(1, { idade: 90 }); c.add(2, { idade: 40 });
  const p = c.R.preview();
  const q = c.R.preview();
  let libera;
  const base = c.b.trackerCheck;
  c.b.trackerCheck = (...a) => new Promise((res) => { libera = () => res(base(...a)); });
  const primeira = c.R.run(p.plano);
  await assert.rejects(c.R.run(q.plano), (e) => e.status === 409 && /em andamento/.test(e.message));
  libera();
  assert.equal((await primeira).removidos.length, 1);
});

// --- Rotas administrativas ---
function resposta() {
  const r = { statusCode: 0, headers: {}, chunks: [], writableEnded: false, destroyed: false, headersSent: false,
    setHeader(k, v) { this.headers[k] = v; }, writeHead(s, h2) { this.statusCode = s; this.headersSent = true; Object.assign(this.headers, h2 || {}); },
    write(x) { this.chunks.push(Buffer.from(x)); return true; }, end(x) { if (x) this.chunks.push(Buffer.from(x)); this.writableEnded = true; },
    once() {}, on() {}, off() {} };
  return r;
}
async function chama(b, method, url, headers = {}) {
  const res = resposta();
  await b.handle({ method, url, headers: { host: '127.0.0.1:7094', ...headers }, socket: LOCAL }, res);
  return { status: res.statusCode, body: JSON.parse(Buffer.concat(res.chunks).toString() || '{}') };
}

test('rotas /retention exigem o token administrativo e nunca aceitam Origin', async () => {
  const c = cenario({ budgetBlocos: 1 });
  c.add(1, { idade: 90 }); c.add(2, { idade: 40 });
  assert.equal((await chama(c.b, 'GET', '/retention')).status, 403);
  assert.equal((await chama(c.b, 'GET', '/retention', { 'x-admin-token': 'errado' })).status, 403);
  assert.equal((await chama(c.b, 'GET', '/retention', { 'x-admin-token': ADMIN_KEY, origin: 'http://evil' })).status, 403);
  assert.equal((await chama(c.b, 'POST', '/retention/run?plan=aaaaaaaaaaaa')).status, 403);
  const prev = await chama(c.b, 'GET', '/retention', { 'x-admin-token': ADMIN_KEY });
  assert.equal(prev.status, 200);
  assert.equal(prev.body.candidatos.length, 1);
  const sem = await chama(c.b, 'POST', '/retention/run', { 'x-admin-token': ADMIN_KEY });
  assert.equal(sem.status, 409);
  const ok = await chama(c.b, 'POST', `/retention/run?plan=${prev.body.plano}`, { 'x-admin-token': ADMIN_KEY });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.removidos.length, 1);
  c.tracker.falha = 'lanca';
  const p2 = await chama(c.b, 'GET', '/retention', { 'x-admin-token': ADMIN_KEY });
  assert.equal(p2.body.candidatos.length, 0, 'já removido');
});

test('rota: tracker fora do ar responde 503 e nada é removido', async () => {
  const c = cenario({ budgetBlocos: 1 });
  const a = c.add(1, { idade: 90 }); c.add(2, { idade: 40 });
  const prev = await chama(c.b, 'GET', '/retention', { 'x-admin-token': ADMIN_KEY });
  c.tracker.falha = 'failed';
  const r = await chama(c.b, 'POST', `/retention/run?plan=${prev.body.plano}`, { 'x-admin-token': ADMIN_KEY });
  assert.equal(r.status, 503);
  assert.equal(r.body.removidos.length, 0);
  assert.ok(existe(a.full));
});

// --- Peças de apoio ---
test('reconcile força a releitura de título já confirmado só com force', async () => {
  const vault = new SeedVault({ file: path.join(tmpdir('ret-rec-'), 'v.json') });
  const e = vault.markSeen(h(1), { name: 'x', torrentPath: '/x/asc-1.torrent' });
  e.satisfiedAt = 1; e.completedAt = 1; e.tracker = { satisfied: true };
  let lidas = 0;
  const asc = { history: async () => { lidas++; return { history: null }; } };
  await hnr.reconcile({ asc, vault });
  assert.equal(lidas, 0);
  await hnr.reconcile({ asc, vault, force: true });
  assert.equal(lidas, 1);
  assert.equal(hnr.trackerConfirmed(e), true);
  assert.equal(hnr.trackerConfirmed({ satisfiedAt: 1 }), false);
});

test('último uso: markUsed atualiza em memória e grava no máximo uma vez por minuto', () => {
  let agora = 1_000_000;
  const file = path.join(tmpdir('ret-use-'), 'v.json');
  const vault = new SeedVault({ file, now: () => agora });
  vault.markSeen(h(1), { name: 'x' });
  vault.markUsed(h(1));
  const gravado = () => JSON.parse(fs.readFileSync(file, 'utf8')).entries[0].lastUsedAt;
  assert.equal(gravado(), 1_000_000);
  agora += 10_000; vault.markUsed(h(1));
  assert.equal(vault.get(h(1)).lastUsedAt, 1_010_000);
  assert.equal(gravado(), 1_000_000, 'dentro de 1 min não regrava');
  agora += 61_000; vault.markUsed(h(1));
  assert.equal(gravado(), 1_071_000);
  assert.equal(vault.markUsed(h(2)), null);
});

test('CLI: prévia por padrão, execução só com plano válido e mensagens sem sair removendo', async () => {
  const dataDir = tmpdir('ret-cli-');
  fs.writeFileSync(path.join(dataDir, 'admin-key'), 'tok');
  const env = { DATA_DIR: dataDir, BRIDGE_PORT: '7094' };
  const chamadas = [];
  const doFetch = async (url, init) => {
    chamadas.push({ url, method: init.method, token: init.headers['X-Admin-Token'] });
    if (url.endsWith('/retention')) {
      return { ok: true, status: 200, json: async () => ({ modo: 'preview', politica: { budgetGiB: 1, maxTitles: 0, minAgeDays: 30 }, totalBytes: 2e9, totalTitulos: 2, avisos: [], candidatos: [{ infoHash: h(1), nome: 'Filme 1', bytes: 1e9, idadeDias: 90, motivo: 'excede-orcamento' }], protegidos: [], bytesEstimados: 1e9, executavel: true, plano: 'abcdef012345' }) };
    }
    return { ok: false, status: 409, json: async () => ({ error: 'tracker indisponível: nada foi removido' }) };
  };
  const linhas = [];
  const out = (l) => linhas.push(l);
  assert.equal(await cli.run([], { env, doFetch, out }), 0);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].method, 'GET', 'sem flag é só prévia');
  assert.match(linhas.join('\n'), /Nada foi removido\./);
  assert.match(linhas.join('\n'), /--executar abcdef012345/);
  assert.equal(await cli.run(['--executar', 'nao-e-plano'], { env, doFetch, out }), 2);
  assert.equal(await cli.run(['--executar'], { env, doFetch, out }), 2);
  assert.equal(chamadas.length, 1, 'uso inválido não chama a ponte');
  assert.equal(await cli.run(['--executar', 'abcdef012345'], { env, doFetch, out }), 1);
  assert.equal(chamadas[1].method, 'POST');
  assert.equal(chamadas[1].token, 'tok');
});
