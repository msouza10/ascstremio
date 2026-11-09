// Quota de reproduções lógicas simultâneas (global e por credencial).
//
// Uma conexão HTTP não é uma reprodução: o player faz HEAD, abre vários Range, refaz a
// conexão ao pular no filme e tenta de novo depois de um erro. Por isso a unidade contada é a
// SESSÃO DE REPRODUÇÃO, identificada por
//
//   credencial de instalação + conteúdo (torrent/arquivo, ou o id do ASC antes de haver torrent)
//
// - Só um GET abre ou renova sessão. HEAD, OPTIONS e listagem nunca ocupam vaga.
// - Qualquer número de requisições da mesma credencial para o mesmo conteúdo compartilha a
//   mesma vaga (seek, multi-Range, reconexão, retentativa).
// - A sessão fica ativa enquanto há resposta aberta e por `graceMs` depois da última fechar;
//   passada a janela sem nenhuma requisição, expira e libera a vaga. A janela cobre o intervalo
//   entre fechar um Range e abrir o seguinte num seek.
// - Não se agrupa por IP/NAT: dois aparelhos atrás do mesmo IP com credenciais diferentes são
//   duas sessões. O Stremio não identifica o aparelho, então dois aparelhos com A MESMA
//   credencial vendo o MESMO conteúdo contam como uma só (limite conhecido, documentado).
// - Resposta de erro (>= 400) não deixa vaga presa: se foi a única razão de a sessão existir,
//   ela some quando a resposta fecha.
//
// A reserva é síncrona (sem await entre conferir e gravar), então pedidos concorrentes não
// furam o limite. Só reserva e libera contadores; não toca em download, snatch nem seed.

const DEFAULT_GRACE_MS = 30_000;

class PlaybackLimiter {
  constructor({ maxSessions = 0, maxPerCredential = 0, graceMs = DEFAULT_GRACE_MS, now = Date.now } = {}) {
    this.maxSessions = maxSessions; // 0 = sem limite
    this.maxPerCredential = maxPerCredential; // 0 = sem limite
    this.graceMs = graceMs;
    this.now = now;
    this.sessions = new Map(); // "credencial\nchave" -> sessão
  }

  static fullKey(credentialId, key) { return `${credentialId}\n${key}`; }

  // Remove sessões sem resposta aberta cuja janela de inatividade acabou.
  sweep() {
    const t = this.now();
    for (const [k, s] of this.sessions) {
      if (s.open === 0 && t - s.lastSeen >= this.graceMs) this.sessions.delete(k);
    }
  }

  // Reserva (ou renova) a vaga. Devolve { ok: true, lease } ou { ok: false, scope, limit, retryAfter }.
  acquire(credentialId, key) {
    this.sweep();
    const fk = PlaybackLimiter.fullKey(credentialId, key);
    let session = this.sessions.get(fk);
    if (!session) {
      const own = [...this.sessions.values()].filter((s) => s.credentialId === credentialId).length;
      if (this.maxPerCredential > 0 && own >= this.maxPerCredential) return this.refuse('credencial', this.maxPerCredential, credentialId);
      if (this.maxSessions > 0 && this.sessions.size >= this.maxSessions) return this.refuse('global', this.maxSessions, null);
      session = { credentialId, key, open: 0, lastSeen: this.now(), confirmed: false, alias: null };
      this.sessions.set(fk, session);
    }
    session.open += 1;
    session.lastSeen = this.now();
    return { ok: true, lease: new Lease(this, session) };
  }

  // Há sessão (aberta ou ainda na janela de inatividade) cuja chave começa por `prefixo`?
  // Usada pela retenção: um título com sessão recente nunca é removido.
  hasKeyPrefix(prefixo) {
    this.sweep();
    for (const s of this.sessions.values()) if (String(s.key).startsWith(prefixo)) return true;
    return false;
  }

  // Segundos até a primeira vaga ociosa expirar (as que têm resposta aberta não têm prazo).
  refuse(scope, limit, credentialId) {
    const t = this.now();
    let wait = Infinity;
    for (const s of this.sessions.values()) {
      if (s.open > 0 || (credentialId && s.credentialId !== credentialId)) continue;
      wait = Math.min(wait, this.graceMs - (t - s.lastSeen));
    }
    const retryAfter = Number.isFinite(wait) ? Math.max(1, Math.ceil(wait / 1000)) : Math.max(1, Math.ceil(this.graceMs / 1000));
    return { ok: false, scope, limit, retryAfter };
  }

  // Revogação: libera todas as vagas da credencial na hora (as respostas abertas são derrubadas
  // por quem chama; as liberações tardias dessas respostas não encontram mais a sessão).
  dropCredential(credentialId) {
    for (const [k, s] of this.sessions) if (s.credentialId === credentialId) this.sessions.delete(k);
  }

  // Só números por credencial: nada de título, IP ou histórico que permita a um aparelho ver outro.
  snapshot() {
    this.sweep();
    const porCredencial = new Map();
    for (const s of this.sessions.values()) {
      const c = porCredencial.get(s.credentialId) ?? { credentialId: s.credentialId, sessions: 0, open: 0 };
      c.sessions += 1;
      c.open += s.open;
      porCredencial.set(s.credentialId, c);
    }
    return {
      active: this.sessions.size,
      maxSessions: this.maxSessions,
      maxPerCredential: this.maxPerCredential,
      graceSeconds: Math.round(this.graceMs / 1000),
      credentials: [...porCredencial.values()],
    };
  }
}

// Uma requisição GET com vaga. release() é idempotente: pode ser chamado em fechamento,
// erro, abort ou destroy sem contar duas vezes.
class Lease {
  constructor(limiter, session) {
    this.limiter = limiter;
    this.session = session;
    this.released = false;
  }

  current() {
    let s = this.session;
    while (s.alias) s = s.alias;
    return s;
  }

  // Passa a sessão para a chave definitiva (id do ASC -> torrent/arquivo) assim que o torrent
  // é resolvido, para que as próximas requisições do mesmo filme não contem como outra TV.
  rekey(newKey) {
    if (this.released) return;
    const s = this.current();
    const lim = this.limiter;
    const oldFk = PlaybackLimiter.fullKey(s.credentialId, s.key);
    const newFk = PlaybackLimiter.fullKey(s.credentialId, newKey);
    if (oldFk === newFk || lim.sessions.get(oldFk) !== s) return;
    const target = lim.sessions.get(newFk);
    lim.sessions.delete(oldFk);
    if (target) {
      target.open += s.open;
      target.lastSeen = Math.max(target.lastSeen, s.lastSeen);
      s.alias = target;
    } else {
      s.key = newKey;
      lim.sessions.set(newFk, s);
    }
  }

  release({ keep = true } = {}) {
    if (this.released) return;
    this.released = true;
    const s = this.current();
    s.open = Math.max(0, s.open - 1);
    s.lastSeen = this.limiter.now();
    if (keep) s.confirmed = true;
    const fk = PlaybackLimiter.fullKey(s.credentialId, s.key);
    if (this.limiter.sessions.get(fk) !== s) return; // já revogada ou expirada
    if (s.open === 0 && !s.confirmed) this.limiter.sessions.delete(fk); // só houve erro: não segura vaga
  }
}

module.exports = { PlaybackLimiter, DEFAULT_GRACE_MS };
