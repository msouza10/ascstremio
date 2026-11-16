const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { Bridge } = require('../src/bridge');
const { CredentialStore } = require('../src/credentials');
const { SeedVault } = require('../src/seedvault');
const { tmpdir } = require('./tmp-helper');

const HASH = 'a'.repeat(40);
const OUTRO = 'b'.repeat(40);
const MIN = 60_000;

const pack = (hash = HASH, dir = 'P') => ({
  infoHash: hash, name: 'Pack', title: 'Pack', freeleech: true,
  files: [
    { index: 0, path: `${dir}/P.S01E01.mkv`, length: 10, isVideo: true },
    { index: 1, path: `${dir}/P.S01E02.mkv`, length: 10, isVideo: true },
    { index: 2, path: `${dir}/P.S01E03.mkv`, length: 10, isVideo: true },
    { index: 3, path: `${dir}/banner.jpg`, length: 4, isVideo: false },
    { index: 4, path: `${dir}/P.S02E01.mkv`, length: 10, isVideo: true },
  ],
});

// Bridge com armazenamento real em disco e motor simulado. `aberto` põe o torrent no motor.
// `tracker` é o que a consulta nova ao tracker responde: confirmado | aberto | hnr | fora (rede) |
// antigo (confirmação que não é da consulta de agora). `concluido: false` = pack nunca concluído.
// `aoParar` roda quando o motor é parado (simula o estado mudando no meio da operação).
function cenario({ aberto = true, tracker = 'confirmado', concluido = true, aoParar = null, ...over } = {}) {
  const store = tmpdir('excluir-ep-');
  let agora = 1_700_000_000_000;
  const vault = new SeedVault({ file: path.join(tmpdir('excluir-v-'), 'v.json'), now: () => agora });
  const lib = pack();
  fs.mkdirSync(path.join(store, 'P'));
  for (const f of lib.files) fs.writeFileSync(path.join(store, f.path), Buffer.alloc(f.length, 1));
  vault.markSeen(HASH, { name: 'Pack', freeleech: true });
  if (concluido) vault.markCompleted(HASH);
  vault.setBackground(HASH, true);
  const respostas = {
    confirmado: { status: 'met', satisfied: true, remainingMs: 0, hitAndRun: false },
    aberto: { status: 'pending', satisfied: false, remainingMs: 3_600_000, hitAndRun: false },
    // cumprido E com hit-and-run registrado: só a cláusula própria de hit-and-run segura esta recusa
    hnr: { status: 'met', satisfied: true, remainingMs: 0, hitAndRun: true },
  };
  const consultas = [];
  const snap = (r) => ({ ...r, completedAtMs: vault.get(HASH).completedAt });
  const b = new Bridge({ torrentDir: '/tmp', storeDir: store, port: 7094, vault, minFreeBytes: 1000, freeSpace: () => 1e12,
    backgroundMode: 'auto', idleMs: 1000, ...over });
  b.entries.set(HASH, lib);
  b.trackerCheck = async (hashes, opts) => {
    consultas.push({ hashes, force: opts?.force });
    if (tracker === 'fora') throw new Error('rede fora do ar');
    if (tracker !== 'antigo') vault.setTracker(HASH, snap(respostas[tracker]));
    return { checked: 1, failed: 0, semRegistro: 0 };
  };
  if (concluido && tracker === 'antigo') { vault.setTracker(HASH, snap(respostas.confirmado)); agora += 5000; }
  const destruidos = [];
  b.client = { torrents: [], get: async () => null };
  if (aberto) {
    b.client.torrents.push({ infoHash: HASH, name: 'Pack', ready: true, done: true, length: 44, progress: 1,
      files: lib.files.map((f) => ({ length: f.length, downloaded: f.length })),
      destroy(opts, cb) { destruidos.push(opts); b.client.torrents.splice(0); aoParar?.({ vault, snap, respostas }); cb(); } });
  }
  return { b, vault, store, lib, destruidos, consultas, existe: (i) => fs.existsSync(path.join(store, lib.files[i].path)) };
}

test('com o seed confirmado pelo tracker, excluir um episódio apaga só esse arquivo e para o motor', async () => {
  const s = cenario();
  const r = await s.b.excludeFile(HASH, 1);
  assert.equal(r.file, 1);
  assert.deepEqual([0, 1, 2, 3].map(s.existe), [true, false, true, true], 'só o episódio escolhido some');
  assert.deepEqual(s.destruidos, [{ destroyStore: false }], 'o motor é parado sem apagar o armazenamento');
  const e = s.vault.get(HASH);
  assert.deepEqual(e.excluded, [1]);
  assert.equal(e.backgroundComplete, false, 'nada volta a baixar sozinho');
  assert.ok(e.completedAt && e.satisfiedAt, 'o histórico de conclusão e de cumprimento fica como estava');
  assert.deepEqual(s.consultas, [{ hashes: [HASH], force: true }], 'consultou o tracker de novo antes de agir');
});

test('a exclusão sobrevive a reiniciar o cofre', async () => {
  const s = cenario();
  await s.b.excludeFile(HASH, 2);
  const reaberto = new SeedVault({ file: s.vault.file });
  assert.deepEqual(reaberto.get(HASH).excluded, [2]);
});

test('depois de excluir um episódio, os restantes continuam servindo Range sem restaurar o excluído', async (t) => {
  const s = cenario();
  const credenciais = new CredentialStore({ file: path.join(tmpdir('excluir-cred-'), 'credentials.json') });
  const { token } = credenciais.create({ name: 'teste' });
  s.b.credentials = credenciais;
  const alvo = fs.statSync(path.join(s.store, s.lib.files[1].path));
  const removido = await s.b.excludeFile(HASH, 1);
  assert.equal(removido.bytes, alvo.blocks === undefined ? alvo.size : alvo.blocks * 512);
  // O motor simulado reabre os arquivos preservados no disco real; não pode fabricar o apagado.
  const pedidos = [];
  s.b.getTorrent = async (hash, { fileIdx }) => {
    assert.equal(hash, HASH);
    pedidos.push(fileIdx);
    return { ready: true, files: s.lib.files.map((f) => ({
      length: f.length, path: f.path,
      createReadStream: ({ start, end }) => fs.createReadStream(path.join(s.store, f.path), { start, end }),
    })) };
  };
  const encerramentos = [];
  const servidor = http.createServer((req, res) => {
    encerramentos.push(new Promise((resolve) => res.once('close', resolve)));
    s.b.handle(req, res);
  });
  t.after(() => new Promise((resolve) => servidor.close(resolve)));
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  for (const indice of [0, 2]) {
    const res = await fetch(`http://127.0.0.1:${servidor.address().port}/s/${HASH}/${indice}?k=${token}`, {
      headers: { Range: 'bytes=2-5' },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 2-5/10');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.alloc(4, 1));
  }
  // Receber o corpo no cliente pode anteceder o evento close no servidor.
  await Promise.all(encerramentos);
  assert.deepEqual(pedidos, [0, 2]);
  assert.equal(s.existe(1), false);
  assert.deepEqual(s.vault.get(HASH).excluded, [1]);
  assert.equal(s.vault.get(HASH).backgroundComplete, false);
  assert.equal(s.b.streams.get(HASH), 0, 'as reproduções encerradas não bloqueiam novas ações');
});

test('sem o torrent no motor também exclui, sem tentar parar nada', async () => {
  const s = cenario({ aberto: false });
  await s.b.excludeFile(HASH, 0);
  assert.equal(s.existe(0), false);
  assert.deepEqual(s.vault.get(HASH).excluded, [0]);
});

test('recusa: índice inválido, arquivo que não é vídeo e conteúdo que não é pack', async () => {
  const s = cenario();
  await assert.rejects(s.b.excludeFile(HASH, -1), { status: 400 });
  await assert.rejects(s.b.excludeFile('xyz', 0), { status: 400 });
  await assert.rejects(s.b.excludeFile(HASH, 3), { status: 404 }, 'o banner não é episódio');
  await assert.rejects(s.b.excludeFile(HASH, 99), { status: 404 });
  await assert.rejects(s.b.excludeFile(OUTRO, 0), { status: 404 }, 'fora da biblioteca');
  const filme = { infoHash: OUTRO, name: 'Filme', title: 'Filme', files: [{ index: 0, path: 'F/F.mkv', length: 10, isVideo: true }] };
  s.b.entries.set(OUTRO, filme);
  s.vault.markSeen(OUTRO, { name: 'Filme' });
  await assert.rejects(s.b.excludeFile(OUTRO, 0), { status: 409 }, 'filme usa a exclusão do torrent');
  assert.deepEqual([0, 1, 2, 3].map(s.existe), [true, true, true, true], 'nada foi apagado');
  assert.equal(s.vault.get(HASH).excluded, undefined);
});

test('recusa com reprodução aberta ou operação em andamento, sem tocar em nada', async () => {
  const s = cenario();
  s.b.streams.set(HASH, 1);
  await assert.rejects(s.b.excludeFile(HASH, 1), { status: 409 });
  s.b.streams.delete(HASH);
  s.b.retention.retiring.add(HASH);
  await assert.rejects(s.b.excludeFile(HASH, 1), { status: 409 });
  s.b.retention.retiring.delete(HASH);
  assert.equal(s.existe(1), true);
  assert.equal(s.destruidos.length, 0, 'o motor nem foi parado');
  assert.equal(s.vault.get(HASH).backgroundComplete, true, 'a escolha anterior não mudou');
});

test('recusa arquivo compartilhado com outro conteúdo', async () => {
  const s = cenario();
  s.b.entries.set(OUTRO, pack(OUTRO, 'P')); // mesmos caminhos
  await assert.rejects(s.b.excludeFile(HASH, 1), { status: 409 });
  assert.equal(s.existe(1), true);
});

test('recusa link simbólico no lugar do arquivo', { skip: process.platform === 'win32' }, async () => {
  const s = cenario();
  const alvo = path.join(s.store, 'P', 'alvo.bin');
  fs.writeFileSync(alvo, 'x');
  fs.rmSync(path.join(s.store, s.lib.files[1].path));
  fs.symlinkSync(alvo, path.join(s.store, s.lib.files[1].path));
  await assert.rejects(s.b.excludeFile(HASH, 1), { status: 409 });
  assert.equal(fs.existsSync(alvo), true, 'o alvo do link está intacto');
});

test('com exclusão registrada a conclusão automática não baixa o pack sozinha', async () => {
  const s = cenario({ aberto: false });
  await s.b.excludeFile(HASH, 1);
  const selecoes = [];
  s.b.client.torrents.push({ infoHash: HASH, name: 'Pack', ready: true, done: false, length: 34, downloaded: 24, progress: 0.7, pieces: new Array(4),
    files: s.lib.files.map((f, i) => ({ length: f.length, downloaded: i === 1 ? 0 : f.length, select: (p) => selecoes.push([i, p]) })),
    select: (...a) => selecoes.push(['t', ...a]) });
  s.b.startedAt.set(HASH, 0);
  s.b.packFiles.set(HASH, new Map([[0, 10]])); // episódio aberto já inteiro: sem exclusão, começaria agora
  s.b.completionTick(30 * MIN);
  assert.deepEqual(selecoes, [], 'a escolha do usuário vale');
});

test('pedir para concluir limpa a exclusão e volta a baixar o que falta', async () => {
  const s = cenario({ aberto: false });
  await s.b.excludeFile(HASH, 1);
  s.b.getTorrent = async () => ({ name: 'Pack', done: false });
  const r = await s.b.requestCompletion(HASH);
  assert.equal(r.infoHash, HASH);
  assert.deepEqual(s.vault.get(HASH).excluded, [], 'exclusões removidas');
  assert.equal(s.vault.get(HASH).backgroundComplete, true);
});

test('o snapshot marca o episódio excluído e lista as exclusões do título', async () => {
  const s = cenario({ aberto: false });
  await s.b.excludeFile(HASH, 1);
  const item = s.b.snapshot().titles.find((t) => t.infoHash === HASH);
  assert.deepEqual(item.excluded, [1]);
  assert.deepEqual(item.episodes.map((e) => [e.episode, e.excluded]), [[1, false], [2, true], [3, false], [1, false]]);
  assert.equal(item.episodes[1].state, 'ausente');
  assert.equal(item.state, 'done', 'o seed já estava cumprido: excluir depois não reabre nada');
});

test('liberar uma exclusão devolve só aquele arquivo', () => {
  const vault = new SeedVault({ file: path.join(tmpdir('excluir-v2-'), 'v.json') });
  vault.markSeen(HASH, {});
  vault.setExcluded(HASH, 2, true); vault.setExcluded(HASH, 0, true);
  assert.deepEqual(vault.get(HASH).excluded, [0, 2], 'ordenado');
  vault.setExcluded(HASH, 2, false);
  assert.deepEqual(vault.get(HASH).excluded, [0]);
  assert.equal(vault.setExcluded(HASH, -1, true), null, 'índice inválido é ignorado');
  vault.clearExcluded(HASH);
  assert.deepEqual(vault.get(HASH).excluded, []);
});

// --- Invariante do AGENTS.md: nada de parar seed nem apagar arquivo antes de o tracker confirmar ---

test('obrigação ainda aberta no tracker: recusa e não toca em nada', async () => {
  const s = cenario({ tracker: 'aberto' });
  await assert.rejects(s.b.excludeFile(HASH, 1), { status: 409, message: /confirm/i });
  assert.deepEqual([0, 1, 2, 3].map(s.existe), [true, true, true, true], 'nenhum arquivo apagado');
  assert.equal(s.destruidos.length, 0, 'o motor não foi parado: o seed continua');
  assert.equal(s.vault.get(HASH).excluded, undefined, 'nada registrado no cofre');
  assert.equal(s.vault.get(HASH).backgroundComplete, true, 'a escolha anterior não mudou');
  assert.equal(s.consultas.length, 1, 'a recusa veio de uma consulta nova, não do cofre');
});

test('hit-and-run registrado pelo tracker: recusa', async () => {
  const s = cenario({ tracker: 'hnr' });
  await assert.rejects(s.b.excludeFile(HASH, 1), { status: 409 });
  assert.equal(s.existe(1), true);
  assert.equal(s.destruidos.length, 0);
});

test('tracker fora do ar ou sem resposta: recusa com 503 em vez de supor que está tudo bem', async () => {
  const s = cenario({ tracker: 'fora' });
  await assert.rejects(s.b.excludeFile(HASH, 1), { status: 503 });
  assert.equal(s.existe(1), true);
  assert.equal(s.destruidos.length, 0);
  assert.equal(s.vault.get(HASH).excluded, undefined);
});

test('confirmação antiga (de antes desta consulta) não vale: o cumprimento tem de ser lido agora', async () => {
  const s = cenario({ tracker: 'antigo' });
  await assert.rejects(s.b.excludeFile(HASH, 1), { status: 409 });
  assert.equal(s.existe(1), true);
  assert.equal(s.destruidos.length, 0);
});

test('o tracker deixa de confirmar enquanto o motor para: o arquivo é preservado e nada é registrado', async () => {
  const s = cenario({ aoParar: ({ vault, snap, respostas }) => vault.setTracker(HASH, snap(respostas.aberto)) });
  await assert.rejects(s.b.excludeFile(HASH, 1), { status: 409 });
  assert.equal(s.existe(1), true, 'o arquivo ficou');
  assert.equal(s.vault.get(HASH).excluded, undefined);
});

test('pack nunca concluído não tem obrigação de seed: exclui sem consultar o tracker', async () => {
  const s = cenario({ concluido: false, tracker: 'fora' });
  await s.b.excludeFile(HASH, 2);
  assert.equal(s.existe(2), false);
  assert.deepEqual(s.vault.get(HASH).excluded, [2]);
  assert.equal(s.vault.get(HASH).backgroundComplete, false);
  assert.deepEqual(s.consultas, [], 'sem conclusão não há seed a proteger nem o que confirmar');
});

// ---- Depois da exclusão, o que sobrou continua tocando (rota /s/ real) ---------------------------
const store = new CredentialStore({ file: path.join(tmpdir('excluir-cred-'), 'credentials.json') });
const { token: TOKEN } = store.create({ name: 'teste' });
function resposta() {
  const r = new EventEmitter();
  Object.assign(r, { statusCode: 0, headers: {}, chunks: [], headersSent: false, writableFinished: false, writableEnded: false, destroyed: false,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(st, h) { this.statusCode = st; Object.assign(this.headers, h || {}); this.headersSent = true; },
    write(c) { this.chunks.push(Buffer.from(c)); return true; },
    end(c) { if (c) this.chunks.push(Buffer.from(c)); this.writableEnded = true; this.writableFinished = true; this.emit('close'); },
    off(ev, fn) { return this.removeListener(ev, fn); } });
  return r;
}
const tocar = (b, idx) => {
  const res = resposta();
  const req = { method: 'GET', url: `/s/${HASH}/${idx}?k=${TOKEN}`, headers: { range: 'bytes=0-3' }, socket: { remoteAddress: '127.0.0.1' } };
  return b.handle(req, res).then(() => res);
};

test('depois de excluir um episódio, o outro continua tocando e a exclusão só some ao tocar o excluído', async () => {
  const s = cenario({ credentials: store });
  await s.b.excludeFile(HASH, 1);
  const conteudo = (i) => Buffer.alloc(10, 65 + i);
  const aberto = (i) => ({ length: 10, path: s.lib.files[i].path, downloaded: 10, createReadStream: ({ start, end }) => Readable.from([conteudo(i).subarray(start, end + 1)]) });
  s.b.getTorrent = async (h, { fileIdx }) => ({ ready: true, numPeers: 0, progress: 1, files: s.lib.files.map((_, i) => (i === fileIdx ? aberto(i) : { length: 10 })) });

  const restante = await tocar(s.b, 2);
  assert.equal(restante.statusCode, 206, 'o episódio que sobrou toca');
  assert.equal(Buffer.concat(restante.chunks).toString(), 'CCCC');
  assert.deepEqual(s.vault.get(HASH).excluded, [1], 'tocar outro episódio não desfaz a exclusão');

  await tocar(s.b, 1);
  assert.deepEqual(s.vault.get(HASH).excluded ?? [], [], 'tocar o excluído é pedir de novo');
});

// ---- Exclusão por temporada ------------------------------------------------------------------------
test('excluir uma temporada apaga todos os episódios dela, só os dela, e grava cada um no cofre', async () => {
  const s = cenario();
  const r = await s.b.excludeSeason(HASH, 1);
  assert.deepEqual([0, 1, 2, 3, 4].map(s.existe), [false, false, false, true, true], 'extras e outra temporada ficam');
  assert.deepEqual(s.vault.get(HASH).excluded, [0, 1, 2]);
  assert.equal(r.count, 3);
  assert.deepEqual(s.destruidos, [{ destroyStore: false }], 'o motor é parado uma vez só');
  assert.deepEqual(s.consultas, [{ hashes: [HASH], force: true }], 'uma consulta ao tracker para a operação toda');
});

test('excluir temporada respeita a mesma trava: tracker sem confirmar não remove nada', async () => {
  const s = cenario({ tracker: 'aberto' });
  await assert.rejects(s.b.excludeSeason(HASH, 1), (e) => e.status === 409);
  assert.deepEqual([0, 1, 2, 3, 4].map(s.existe), [true, true, true, true, true]);
  assert.equal(s.vault.get(HASH).excluded, undefined);
});

test('temporada que o pack não tem dá 404 e não toca em nada', async () => {
  const s = cenario();
  await assert.rejects(s.b.excludeSeason(HASH, 7), (e) => e.status === 404);
  assert.deepEqual([0, 1, 2, 3, 4].map(s.existe), [true, true, true, true, true]);
  await assert.rejects(s.b.excludeSeason(HASH, -1), (e) => e.status === 400);
});

test('temporada com um episódio já excluído só apaga o que resta e não falha', async () => {
  const s = cenario();
  await s.b.excludeFile(HASH, 1);
  s.b.client.torrents.splice(0);
  const r = await s.b.excludeSeason(HASH, 1);
  assert.deepEqual(s.vault.get(HASH).excluded, [0, 1, 2]);
  assert.equal(r.count, 2, 'conta só o que ainda existia');
});

// ---- Concluir só um episódio ou uma temporada --------------------------------------------------------
// Baixa só esses arquivos (prioridade baixa). Não é "concluir o pack": não liga a conclusão em segundo
// plano nem abre a obrigação de 72 h, que só nasce com o torrent inteiro (13.1).
function motorFalso(s) {
  const selecionados = [];
  const torrent = { infoHash: HASH, name: 'Pack', ready: true, done: false, length: 44, progress: 0.2,
    files: s.lib.files.map((f, i) => ({ length: f.length, downloaded: 0, select: (p) => selecionados.push([i, p]) })) };
  s.b.getTorrent = async (h, { fileIdx }) => { s.abertoCom = fileIdx; return torrent; };
  return selecionados;
}

test('concluir uma temporada seleciona só os episódios dela, sem ligar a conclusão do pack', async () => {
  const s = cenario({ concluido: false });
  s.vault.setBackground(HASH, false);
  const sel = motorFalso(s);
  const r = await s.b.requestFilesCompletion(HASH, { season: 1 });
  assert.deepEqual(sel, [[0, 0], [1, 0], [2, 0]], 'só os vídeos da temporada 1, em prioridade baixa');
  assert.deepEqual(r.files, [0, 1, 2]);
  assert.equal(s.vault.get(HASH).backgroundComplete, false, 'não é conclusão do torrent inteiro');
  assert.ok(!s.vault.get(HASH).completedAt, 'não abre obrigação de seed');
  assert.equal(s.b.completing.has(HASH), false);
  assert.equal(s.abertoCom, 0);
});

test('concluir um episódio devolve só a exclusão dele e mantém as demais', async () => {
  const s = cenario({ concluido: false });
  s.vault.setExcluded(HASH, 1, true); s.vault.setExcluded(HASH, 4, true);
  const sel = motorFalso(s);
  await s.b.requestFilesCompletion(HASH, { file: 1 });
  assert.deepEqual(sel, [[1, 0]]);
  assert.deepEqual(s.vault.get(HASH).excluded, [4]);
});

test('concluir parte do pack recusa escopo inválido, não-vídeo, temporada ausente e filme', async () => {
  const s = cenario({ concluido: false });
  const sel = motorFalso(s);
  await assert.rejects(s.b.requestFilesCompletion(HASH, { file: 3 }), (e) => e.status === 404, 'extra não é episódio');
  await assert.rejects(s.b.requestFilesCompletion(HASH, { season: 9 }), (e) => e.status === 404);
  await assert.rejects(s.b.requestFilesCompletion(HASH, { file: -1 }), (e) => e.status === 400);
  await assert.rejects(s.b.requestFilesCompletion(HASH, {}), (e) => e.status === 400);
  await assert.rejects(s.b.requestFilesCompletion(HASH, { file: 0, season: 1 }), (e) => e.status === 400, 'um escopo só');
  assert.deepEqual(sel, []);
  s.b.entries.set(HASH, { infoHash: HASH, title: 'Filme', files: [{ index: 0, path: 'F/f.mkv', length: 10, isVideo: true }] });
  await assert.rejects(s.b.requestFilesCompletion(HASH, { file: 0 }), (e) => e.status === 409);
});

test('concluir parte do pack paga a reserva de disco de cada arquivo e recusa sem espaço', async () => {
  const { DiskRefusal } = require('../src/disk-policy');
  const s = cenario({ concluido: false, freeSpace: () => 5 });
  const sel = motorFalso(s);
  await assert.rejects(s.b.requestFilesCompletion(HASH, { season: 1 }), DiskRefusal);
  assert.deepEqual(sel, [], 'sem espaço nada é selecionado');
});

// ---- Conclusão parcial: o escopo escolhido vale contra a conclusão automática e segura a suspensão ----
function motorEmAndamento(s, { baixados = [0, 1, 2] } = {}) {
  const inteiro = [];
  const selecionados = [];
  const torrent = { infoHash: HASH, name: 'Pack', ready: true, done: false, length: 44, progress: 0.5, downloaded: 30, pieces: [1, 2],
    select: (...a) => inteiro.push(a),
    files: s.lib.files.map((f, i) => ({ length: f.length, downloaded: baixados.includes(i) ? f.length : 0, select: (p) => selecionados.push([i, p]) })) };
  s.b.client.torrents.push(torrent);
  s.b.getTorrent = async () => torrent;
  return { torrent, inteiro, selecionados };
}

test('concluir só a temporada 1 não deixa a conclusão automática baixar o resto do pack', async () => {
  const s = cenario({ concluido: false, aberto: false });
  s.vault.setBackground(HASH, false);
  const m = motorEmAndamento(s);
  await s.b.requestFilesCompletion(HASH, { season: 1 });
  m.selecionados.length = 0;
  s.b.completionTick(Date.now() + 1e9); // ocioso há muito tempo e com o episódio aberto inteiro
  assert.deepEqual(m.selecionados, [], 'nenhum outro arquivo foi selecionado');
  assert.deepEqual(m.inteiro, [], 'o torrent inteiro não foi selecionado');
  assert.equal(s.b.completing.has(HASH), false);
  assert.ok(!s.vault.get(HASH).backgroundComplete);
});

test('o pedido explícito de concluir o pack inteiro desfaz o escopo parcial', async () => {
  const s = cenario({ concluido: false, aberto: false });
  const m = motorEmAndamento(s);
  await s.b.requestFilesCompletion(HASH, { file: 0 });
  await s.b.requestCompletion(HASH);
  assert.equal(s.b.completing.has(HASH), true, 'agora o pack inteiro baixa');
  // A conclusão integral seleciona intervalos de peças do torrent (não mais arquivo a arquivo): sem
  // posição de reprodução conhecida, o plano é o torrent inteiro, da primeira à última peça.
  assert.deepEqual(m.inteiro.map((a) => a.slice(0, 3)), [[0, 1, 0]]);
});

test('download parcial em andamento mantém o computador acordado até os arquivos escolhidos terminarem', async () => {
  const s = cenario({ concluido: false, aberto: false });
  const m = motorEmAndamento(s, { baixados: [] });
  assert.equal(s.b.needsAwake(), false, 'sem pedido parcial e sem conclusão, nada a proteger');
  await s.b.requestFilesCompletion(HASH, { file: 1 });
  assert.equal(s.b.needsAwake(), true, 'o episódio escolhido ainda baixa');
  m.torrent.files[1].downloaded = m.torrent.files[1].length;
  assert.equal(s.b.needsAwake(), false, 'terminou o que foi pedido');
  m.torrent.done = true;
  assert.equal(s.b.needsAwake(), false);
});
