// Retomada de seeds pendentes por RISCO (issue #32): quem corre mais perigo de virar hit-and-run
// (regra 13.3 do ASC: 12 dias sem semear) é aberto primeiro, e a abertura de cada torrent é medida.
// O módulo é puro e não toca disco nem rede: a ponte injeta o cofre, o relógio e o `getTorrent`.
//
// Classes (menor = mais urgente):
//   0  obrigação CONFIRMADA pelo tracker (conferência do myHistory, ainda não cumprida)
//   1  obrigação só local (o cofre diz que concluiu, o tracker ainda não confirmou)
//   2  conclusão em segundo plano pedida, sem obrigação ainda (não há prazo correndo)
//   3  concluído e sem obrigação (cumprido) - fica por último
// O tracker sempre vence o cofre: tracker.satisfied tira o torrent da obrigação, e o prazo e o que
// falta de seed vêm dele quando existem.

const CLASS = Object.freeze({ TRACKER: 0, LOCAL: 1, BACKGROUND: 2, NONE: 3 });
const CLASS_NAME = Object.freeze(['tracker', 'local', 'segundo-plano', 'sem-obrigacao']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function classify(entry) {
  const tracker = entry.tracker ?? null;
  if (entry.satisfiedAt || tracker?.satisfied) return CLASS.NONE;
  if (entry.completedAt) return tracker ? CLASS.TRACKER : CLASS.LOCAL;
  if (entry.backgroundComplete) return CLASS.BACKGROUND;
  return CLASS.NONE;
}

// Dados que ordenam uma entrada. Valor ausente é tratado de forma CONSERVADORA: prazo
// desconhecido conta como iminente (-Infinity) e o que falta de seed desconhecido conta como o
// total exigido, para nunca empurrar para o fim uma obrigação sobre a qual não sabemos nada.
function riskOf(entry, { vault, now }) {
  const klass = classify(entry);
  const deadline = num(vault.deadlineMs(entry.infoHash));
  const remaining = num(entry.tracker?.remainingMs) ?? num(vault.remainingMs(entry.infoHash)) ?? num(vault.requiredMs);
  return {
    infoHash: entry.infoHash,
    klass,
    className: CLASS_NAME[klass],
    deadlineMs: deadline,
    // Só o prazo do tracker é "exato"; o do cofre é estimativa (último contato + 12 dias).
    deadlineSource: num(entry.tracker?.deadlineMs) !== null ? 'tracker' : deadline !== null ? 'local' : 'desconhecido',
    remainingMs: remaining,
    hoursToDeadline: deadline === null ? null : Number(((deadline - now) / 3_600_000).toFixed(1)),
    completedAt: num(entry.completedAt),
  };
}

// Comparação total e determinística: classe, prazo mais próximo, mais horas devidas, conclusão
// mais antiga e, por fim, o infoHash (nunca depende da ordem de inserção).
function compare(a, b) {
  if (a.klass !== b.klass) return a.klass - b.klass;
  const da = a.deadlineMs ?? -Infinity;
  const db = b.deadlineMs ?? -Infinity;
  if (da !== db) return da < db ? -1 : 1;
  const ra = a.remainingMs ?? Infinity;
  const rb = b.remainingMs ?? Infinity;
  if (ra !== rb) return ra > rb ? -1 : 1;
  const ca = a.completedAt ?? Infinity;
  const cb = b.completedAt ?? Infinity;
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.infoHash < b.infoHash ? -1 : a.infoHash > b.infoHash ? 1 : 0;
}

// Devolve [{ entry, ...risco }] na ordem em que devem ser retomadas.
function rankPending(entries, { vault, now = Date.now() }) {
  return entries
    .map((entry) => ({ entry, ...riskOf(entry, { vault, now }) }))
    .sort(compare);
}

// Executa `worker(item)` sobre `items` na ordem dada, com no máximo `limit` em andamento. O item
// seguinte só começa quando uma vaga abre, então os mais urgentes saem primeiro. A falha de um
// (o worker deve tratar o próprio erro) nunca interrompe os demais.
async function runLimited(items, limit, worker) {
  const queue = [...items];
  const n = Math.max(1, Math.min(Math.floor(limit) || 1, queue.length || 1));
  const lane = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      try { await worker(item); } catch { /* o worker registra; a fila segue */ }
    }
  };
  await Promise.all(Array.from({ length: n }, lane));
}

module.exports = { CLASS, CLASS_NAME, classify, rankPending, runLimited };
