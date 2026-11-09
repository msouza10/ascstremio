// Propriedade exclusiva da instalação: só um processo por pasta de dados (e por
// armazenamento externo) pode escrever o estado e abrir o motor de torrents. Escrita
// atômica (tmp + rename) não impede perda de atualizações entre dois processos, e
// portas diferentes não impedem dois escritores no mesmo cofre de seed (um cofre
// sobrescrito pode perder a contagem das 72 h da regra 13.1 do ASC).
//
// Aquisição: `open(..., 'wx')` cria o arquivo de forma exclusiva e atômica. Recuperação
// de trava obsoleta é CONSERVADORA (fail-closed): só se recupera quando se prova que o
// dono morreu; qualquer dúvida recusa a partida e explica como recuperar à mão.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LOCK_NAME = '.ascstremio.lock';
const GUARD_SUFFIX = '.recuperando';
const GUARD_STALE_MS = 60_000;

// Travas já mantidas por ESTE processo (um segundo start no mesmo processo também recusa).
const held = new Map(); // caminho do arquivo -> nonce

class LockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockError';
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Caminho canônico (resolve symlinks e junctions; caixa baixa no Windows). Cria a pasta se faltar.
function canonical(dir) {
  const abs = path.resolve(dir);
  fs.mkdirSync(abs, { recursive: true, mode: 0o700 });
  const real = fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH'; // EPERM = existe, de outro usuário
  }
}

function readLock(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    return { unreadable: true, error: err };
  }
  try {
    const data = JSON.parse(raw);
    if (data && Number.isInteger(data.pid) && typeof data.nonce === 'string') return { data };
  } catch { /* quem criou ainda pode estar escrevendo */ }
  return { invalid: true };
}

function describe(d) {
  return `PID ${d.pid} em "${d.hostname}", iniciado em ${d.startedAt}`;
}

function recoveryHint(file) {
  return `Se tiver certeza de que nenhuma instância está rodando, apague o arquivo "${file}" e inicie de novo.`;
}

// A trava lida está obsoleta? Retorna só com prova de que o dono morreu; senão lança LockError.
function assertStale(file, d, dir) {
  if (d.hostname !== os.hostname()) {
    // Outro computador/contêiner (ou contêiner recriado): não dá para saber se vive.
    throw new LockError(`A pasta "${dir}" está travada por outra máquina ou contêiner (${describe(d)}); `
      + `não é possível verificar se ele ainda roda. ${recoveryHint(file)}`);
  }
  if (d.pid === process.pid) return; // PID reaproveitado por nós (ex.: PID 1 no contêiner): execução anterior
  if (pidAlive(d.pid)) {
    throw new LockError(`A pasta "${dir}" já está em uso por outra instância do ascstremio (${describe(d)}). `
      + 'Pare-a antes de iniciar outra, ou use pastas de dados diferentes. '
      + `Se o PID foi reaproveitado por outro programa após uma queda: ${recoveryHint(file)}`);
  }
}

function tryCreate(file, record) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw new LockError(`Não foi possível criar a trava "${file}" (${err.code ?? err.message}). `
      + 'Confira as permissões da pasta; a partida foi recusada para não correr o risco de dois escritores.');
  }
  try {
    fs.writeSync(fd, JSON.stringify(record));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

// Remove a trava obsoleta sob uma guarda exclusiva, reconferindo o nonce: dois processos
// que concluem "obsoleta" ao mesmo tempo não apagam a trava nova um do outro.
function removeStale(file, nonce) {
  const guard = file + GUARD_SUFFIX;
  const marca = { pid: process.pid, nonce: 'guarda', hostname: os.hostname(), startedAt: new Date().toISOString() };
  if (!tryCreate(guard, marca)) {
    let idade = 0;
    try { idade = Date.now() - fs.statSync(guard).mtimeMs; } catch { /* sumiu */ }
    if (idade > GUARD_STALE_MS) {
      try { fs.unlinkSync(guard); } catch { /* outro já removeu */ }
    }
    return false;
  }
  try {
    const again = readLock(file);
    if (again.data && again.data.nonce === nonce) fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw new LockError(`Não foi possível remover a trava obsoleta "${file}" (${err.code ?? err.message}). ${recoveryHint(file)}`);
  } finally {
    try { fs.unlinkSync(guard); } catch { /* já removida */ }
  }
}

function acquireOne(dir, extra = {}) {
  const file = path.join(dir, LOCK_NAME);
  if (held.has(file)) {
    throw new LockError(`A pasta "${dir}" já está travada por este mesmo processo.`);
  }
  const record = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    nonce: crypto.randomBytes(8).toString('hex'),
    dir,
    ...extra,
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    if (tryCreate(file, record)) {
      held.set(file, record.nonce);
      return { file, nonce: record.nonce };
    }
    const lock = readLock(file);
    if (lock.missing) continue; // liberada entre o open e a leitura
    if (lock.unreadable) {
      throw new LockError(`Não foi possível ler a trava "${file}" (${lock.error.code ?? lock.error.message}). ${recoveryHint(file)}`);
    }
    if (lock.invalid) {
      // Pode ser escrita em andamento; se persistir, o estado é inconclusivo: recusa.
      sleepSync(100);
      if (attempt >= 5) {
        throw new LockError(`A trava "${file}" existe, mas está ilegível ou incompleta. ${recoveryHint(file)}`);
      }
      continue;
    }
    assertStale(file, lock.data, dir);
    if (!removeStale(file, lock.data.nonce)) sleepSync(100);
  }
  throw new LockError(`Não foi possível adquirir a trava de "${dir}" (disputa persistente). Tente de novo.`);
}

function releaseOne({ file, nonce }) {
  if (held.get(file) !== nonce) return;
  held.delete(file);
  try {
    const lock = readLock(file);
    if (lock.data && lock.data.nonce === nonce) fs.unlinkSync(file);
  } catch { /* melhor esforço: a próxima partida trata como obsoleta */ }
}

// Há trava viva em pasta ancestral? Instalações com pastas aninhadas compartilhariam
// arquivos sem que as travas de cada pasta se enxergassem.
function assertNoAncestorLock(dir) {
  let cur = path.dirname(dir);
  while (cur !== path.dirname(cur)) {
    const file = path.join(cur, LOCK_NAME);
    if (held.has(file)) {
      throw new LockError(`"${dir}" fica dentro de uma pasta já travada por este mesmo processo ("${cur}").`);
    } else {
      let lock = readLock(file);
      // Incompleta pode ser escrita em andamento: espera um pouco; se persistir, recusa.
      for (let i = 0; i < 5 && lock.invalid; i++) {
        sleepSync(100);
        lock = readLock(file);
      }
      if (lock.invalid || lock.unreadable) {
        throw new LockError(`"${dir}" fica dentro de uma pasta com trava ilegível ou incompleta ("${file}"). ${recoveryHint(file)}`);
      }
      if (lock.data) {
        try { assertStale(file, lock.data, cur); } catch (err) {
          throw new LockError(`"${dir}" fica dentro de uma pasta já usada por outra instalação. ${err.message}`);
        }
      }
    }
    cur = path.dirname(cur);
  }
}

// Adquire DATA_DIR e, se ficarem fora dela, as pastas de .torrent e de armazenamento.
// Recusa caminhos sobrepostos entre si. Devolve { dirs, release }.
function acquireInstance({ dataDir, torrentDir, storeDir }) {
  const data = canonical(dataDir);
  const torrents = canonical(torrentDir);
  const store = canonical(storeDir);

  if (isInside(torrents, store) || isInside(store, torrents)) {
    throw new LockError(`ASC_TORRENT_DIR ("${torrents}") e BRIDGE_STORE ("${store}") não podem ser a mesma pasta nem uma dentro da outra.`);
  }
  for (const [nome, dir] of [['ASC_TORRENT_DIR', torrents], ['BRIDGE_STORE', store]]) {
    if (isInside(data, dir)) {
      throw new LockError(`DATA_DIR ("${data}") não pode ficar dentro de ${nome} ("${dir}").`);
    }
  }

  const wanted = [data];
  for (const dir of [torrents, store]) {
    if (!isInside(dir, data)) wanted.push(dir); // dentro de DATA_DIR já está coberto
  }
  const taken = [];
  const release = () => { while (taken.length) releaseOne(taken.pop()); };
  try {
    for (const dir of wanted) {
      assertNoAncestorLock(dir);
      taken.push(acquireOne(dir, { dataDir: data, torrentDir: torrents, storeDir: store }));
    }
  } catch (err) {
    release();
    throw err;
  }
  return { dirs: wanted, release };
}

module.exports = { acquireInstance, LockError, LOCK_NAME };
