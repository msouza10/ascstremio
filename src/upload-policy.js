// Teto de upload normal e teto reduzido durante reproduções lógicas.
//
// Estados (decididos pelo serviço, não pelo painel):
//   normal    = nenhuma reprodução: vale BRIDGE_UPLOAD_LIMIT (o teto do operador);
//   streaming = há sessão de reprodução ativa (src/play-limit.js): vale o menor teto finito;
//   restoring = a última sessão acabou: o teto reduzido continua por `restoreMs` e então volta ao normal.
// A sessão de reprodução já tem a sua própria carência (PLAYBACK_SESSION_GRACE_SECONDS), então a
// restauração só começa depois dela; a espera extra evita oscilar entre dois filmes seguidos.
//
// Regras que não mudam:
// - O teto de streaming nunca aumenta o do operador (menor teto finito entre os dois).
// - -1 = sem teto. O 0 legado do teto normal é respeitado e nunca é "consertado" aqui.
// - O teto de streaming não aceita 0 (settings.js impõe o piso) e, havendo seed pendente (13.1),
//   nunca fica abaixo de SEED_PENDING_FLOOR: a reprodução não pode estrangular o ratio 1.0.
//   O tempo de seed (72 h) não depende de bytes, mas o ratio sim.
// - Só chama a API pública do motor (throttleUpload). Não recria cliente, não para torrent, não mexe
//   em cofre nem em announce. Se o motor recusar, mantém o último teto aplicado e tenta de novo.

const SEED_PENDING_FLOOR = 65536; // 64 KiB/s

// Menor teto finito entre dois; -1 é "sem teto". 0 é um teto (vence qualquer positivo).
function minCap(a, b) {
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

class UploadPolicy {
  constructor({ normal = -1, stream = -1, restoreMs = 15_000, apply, activeSessions = () => 0, seedPending = () => false, now = Date.now, log = null } = {}) {
    this.normal = normal;
    this.stream = stream;
    this.restoreMs = restoreMs;
    this.applyFn = apply;
    this.activeSessions = activeSessions;
    this.seedPending = seedPending;
    this.now = now;
    this.log = log;
    this.state = 'normal';
    this.lastActive = null;
    this.applied = normal; // último teto aceito pelo motor (o cliente nasce com o normal)
    this.error = null;
  }

  // Sem teto de streaming a política é inerte: nunca chama o motor. Com o normal em 0 (envio
  // desligado pelo operador) também não: não há o que reduzir e o 0 não é revertido por aqui.
  get enabled() { return this.stream !== -1 && this.normal !== 0; }

  // Teto de streaming efetivo, com o piso de seed pendente e o teto do operador.
  streamCap() {
    let cap = this.stream;
    if (cap !== -1 && this.seedPending()) cap = Math.max(cap, SEED_PENDING_FLOOR);
    return minCap(this.normal, cap);
  }

  // Reavalia estado e teto. Chamado ao abrir/fechar reprodução, a cada tick e ao mudar a configuração.
  evaluate() {
    const t = this.now();
    const active = this.activeSessions() > 0;
    if (!this.enabled) {
      this.state = 'normal';
      this.lastActive = null;
    } else if (active) {
      this.state = 'streaming';
      this.lastActive = t;
    } else if (this.state !== 'normal' && this.lastActive !== null && t - this.lastActive < this.restoreMs) {
      this.state = 'restoring';
    } else {
      this.state = 'normal';
      this.lastActive = null;
    }
    this.push(this.state === 'normal' ? this.normal : this.streamCap());
    return this.snapshot();
  }

  push(want) {
    if (want === this.applied && !this.error) return;
    try {
      // throttleUpload devolve false para valor inválido e não lança; trata os dois como falha.
      if (this.applyFn(want) === false) throw new Error('o motor recusou o teto');
      this.applied = want;
      this.error = null;
      this.log?.info?.(`upload: estado ${this.state}, teto ${want === -1 ? 'sem limite' : `${want} B/s`}`);
    } catch (err) {
      // Mantém o último teto válido; parar o seed nunca é alternativa.
      if (!this.error) this.log?.warn?.(`upload: falha ao aplicar o teto (${err?.message ?? err}); mantido ${this.applied === -1 ? 'sem limite' : `${this.applied} B/s`}`);
      this.error = 'bandwidth_apply_failed';
    }
  }

  // Troca a configuração e recalcula na hora com as sessões existentes (não restaura valor antigo).
  configure({ normal = this.normal, stream = this.stream, restoreMs = this.restoreMs } = {}) {
    this.normal = normal;
    this.stream = stream;
    this.restoreMs = restoreMs;
    return this.evaluate();
  }

  snapshot() {
    return {
      normalUploadLimit: this.normal,
      streamUploadLimit: this.stream,
      effectiveUploadLimit: this.applied,
      activePlaybackSessions: this.activeSessions(),
      policyState: this.state,
      restoreAt: this.state === 'restoring' ? this.lastActive + this.restoreMs : null,
      seedPendingFloor: this.stream !== -1 && this.seedPending() ? SEED_PENDING_FLOOR : null,
      applicationError: this.error,
    };
  }
}

module.exports = { UploadPolicy, SEED_PENDING_FLOOR, minCap };
