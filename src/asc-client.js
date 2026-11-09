const fs = require('node:fs/promises');
const path = require('node:path');
const { CookieJar } = require('tough-cookie');
const { inactivityNotice } = require('./safety');
const log = require('./logger').logger.child('asc');

// `kind` (opcional) classifica a falha para quem consulta o site: 'session' (sessão ausente,
// expirada ou recusada), 'network' (sem conexão com o site) ou 'site' (o site respondeu com erro).
class AscError extends Error {
  constructor(message, kind = null) {
    super(message);
    this.kind = kind;
  }
}

function pageProps(html) {
  const match = html.match(/<script\b(?=[^>]*\bdata-page=["']app["'])[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new AscError('Resposta inesperada do ASC. Pode haver um desafio de acesso no site.');
  try { return JSON.parse(match[1]).props; }
  catch { throw new AscError('Não foi possível ler os dados do ASC.'); }
}

class AscClient {
  constructor({ stateFile, fetchImpl = fetch, delay = 2000 }) {
    this.stateFile = stateFile;
    this.fetch = fetchImpl;
    this.delay = delay;
    this.jar = new CookieJar();
    // Filtro "somente freeleech" (regra 2.7): vem da configuração ASC_ONLY_FREELEECH (index.js
    // injeta e o painel atualiza na hora). Fail-closed: sem configuração, ligado.
    this.onlyFreeleech = true;
    this.freeleechListeners = [];
    // Valor antigo de asc-session.json (versões anteriores o guardavam ali): só para a migração.
    this.legacyOnlyFreeleech = null;
    // Último login explícito: base do aviso de inatividade (regra 2.6, 90 dias).
    this.lastLoginAt = null;
    this.saved = false; // há sessão salva em disco (ainda não confirmada)
    this.accountStats = null; // ratio, upload, download... lidos das páginas autenticadas
    this.connected = false;
    this.message = 'Conecte sua conta ASC.';
    this.queue = Promise.resolve();
    this.lastRequest = 0;
  }

  async load() {
    try {
      const state = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      this.jar = await CookieJar.deserialize(state.cookies);
      this.legacyOnlyFreeleech = state.onlyFreeleech === false ? false : null;
      this.lastLoginAt = typeof state.lastLoginAt === 'string' ? state.lastLoginAt : null;
      this.saved = Boolean(state.cookies);
      this.message = 'Sessão salva. Use Verificar sessão para confirmar.';
    } catch (error) { if (error.code !== 'ENOENT') this.message = 'Sessão salva indisponível. Entre novamente.'; }
  }

  async save() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temp = this.stateFile + '.tmp';
    await fs.writeFile(temp, JSON.stringify({ cookies: await this.jar.serialize(), lastLoginAt: this.lastLoginAt }), { mode: 0o600 });
    await fs.chmod(temp, 0o600);
    await fs.rename(temp, this.stateFile);
  }

  // Só booleano de verdade muda o filtro; qualquer outra coisa é recusada e o valor segue como estava.
  // Avisa quem guarda resultados do filtro anterior (ex.: o provedor de fontes do addon).
  setOnlyFreeleech(value) {
    if (typeof value !== 'boolean') return false;
    if (value === this.onlyFreeleech) return true;
    this.onlyFreeleech = value;
    for (const listener of this.freeleechListeners) {
      try { listener(value); } catch (error) { log.warn(`ouvinte do filtro freeleech falhou: ${error?.message ?? error}`); }
    }
    return true;
  }

  onFreeleechChange(listener) { this.freeleechListeners.push(listener); }

  exclusive(task) {
    const pending = this.queue.then(task);
    this.queue = pending.catch(() => {});
    return pending;
  }

  // Cada chamada ao site fica no log (método, caminho, status, tempo). Nunca vão
  // para o log cabeçalhos, cookies nem corpo: só o que identifica a operação.
  async request(route, options = {}) {
    const started = Date.now();
    try {
      const response = await this.requestInner(route, options);
      log.debug(`${options.method || 'GET'} ${String(route).split('?')[0]} → ${response.status} (${Date.now() - started} ms)`);
      return response;
    } catch (error) {
      log.warn(`${options.method || 'GET'} ${String(route).split('?')[0]} falhou: ${error?.message ?? error} (${Date.now() - started} ms)`);
      throw error;
    }
  }

  async requestInner(route, options = {}) {
    let url = new URL(route, 'https://amigos-share.club');
    let method = options.method || 'GET';
    let body = options.body;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.origin !== 'https://amigos-share.club') throw new AscError('Redirecionamento inesperado do ASC.');
      await new Promise(resolve => setTimeout(resolve, Math.max(0, this.lastRequest + this.delay - Date.now())));
      this.lastRequest = Date.now();
      const headers = { Accept: 'text/html, application/xhtml+xml', ...options.headers,
        Cookie: await this.jar.getCookieString(url.href) };
      let response;
      try { response = await this.fetch(url.href, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(30000) }); }
      catch (error) {
        // /torrents/<id> manda um cabeçalho Link de ~14 KB; acima de 16 KB o fetch do Node recusa.
        if (error?.cause?.code === 'UND_ERR_HEADERS_OVERFLOW') {
          throw new AscError('Cabeçalhos do ASC acima do limite do Node. Inicie com `npm start` (usa --max-http-header-size=65536).');
        }
        throw new AscError('Não foi possível conectar ao ASC. Tente novamente.', 'network');
      }
      for (const cookie of response.headers.getSetCookie()) await this.jar.setCookie(cookie, url.href);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new AscError('Redirecionamento inválido do ASC.');
        url = new URL(location, url);
        log.debug(`redirecionamento ${response.status} → ${url.pathname}`);
        if (url.pathname === '/login' && route !== '/login') {
          this.connected = false;
          this.message = 'Sessão expirada. Entre novamente.';
          log.warn('sessão expirada: o site redirecionou para /login');
          throw new AscError(this.message, 'session');
        }
        if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) { method = 'GET'; body = undefined; }
        continue;
      }
      if (response.status === 419) throw new AscError('Token de segurança expirado. Tente conectar novamente.');
      if (response.status === 422) throw new AscError('Login não aceito. Confira usuário e senha; se necessário, faça a migração de senha no site.');
      if (response.status === 401) {
        this.connected = false;
        this.message = 'Sessão inválida ou credenciais recusadas. Entre novamente.';
        throw new AscError(this.message, 'session');
      }
      if (response.status === 403) throw new AscError('Acesso bloqueado ou desafio do site. Abra o ASC no navegador.', 'site');
      if (response.status === 429) throw new AscError('Limite de acesso do ASC. Aguarde antes de tentar novamente.', 'site');
      if (!response.ok) throw new AscError('O ASC não concluiu a solicitação.', 'site');
      return response;
    }
    throw new AscError('Excesso de redirecionamentos no ASC.');
  }

  // Resumo da conta que o site já devolve em toda página autenticada.
  captureStats(props) {
    const s = props?.auth?.stats;
    if (!s || typeof s !== 'object') return;
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    this.accountStats = {
      ratio: n(s.ratio), uploaded: n(s.uploaded), downloaded: n(s.downloaded),
      seeding: n(s.seeding), leeching: n(s.leeching), hitAndRuns: n(s.hitAndRuns), pendingSeeds: n(s.pendingSeeds),
    };
  }

  async verifyInternal() {
    const response = await this.request('/dashboard');
    const props = pageProps(await response.text());
    if (!props?.auth?.user?.id) throw new AscError('Login não confirmado. Verifique no site se há 2FA ou outra etapa pendente.');
    this.captureStats(props);
    this.connected = true;
    this.message = 'Conta conectada ao ASC.';
    await this.save();
    return this.status();
  }

  login(username, password) {
    return this.exclusive(async () => {
      const oldJar = this.jar;
      const oldLoginAt = this.lastLoginAt;
      this.jar = new CookieJar();
      try {
        await this.request('/login');
        const cookies = await this.jar.getCookies('https://amigos-share.club/login');
        const token = cookies.find(cookie => cookie.key === 'XSRF-TOKEN');
        if (!token) throw new AscError('O site não forneceu o token de login. Abra o ASC no navegador para verificar o acesso.');
        await this.request('/login', { method: 'POST', headers: {
          'Content-Type': 'application/json', Accept: 'application/json',
          'X-XSRF-TOKEN': decodeURIComponent(token.value), 'X-Requested-With': 'XMLHttpRequest',
          Origin: 'https://amigos-share.club', Referer: 'https://amigos-share.club/login',
        }, body: JSON.stringify({ username, password, remember: true }) });
        this.lastLoginAt = new Date().toISOString();
        return await this.verifyInternal();
      } catch (error) { this.jar = oldJar; this.lastLoginAt = oldLoginAt; throw error; }
    });
  }

  verify() { return this.exclusive(() => this.verifyInternal()); }
  inactivityNotice(now = Date.now()) { return inactivityNotice(this.lastLoginAt, now); }
  status() { return { connected: this.connected, message: this.message, onlyFreeleech: this.onlyFreeleech, saved: this.saved, lastLoginAt: this.lastLoginAt, notice: this.inactivityNotice() }; }
  logout() { return this.exclusive(async () => {
    this.jar = new CookieJar(); this.connected = false; this.message = 'Sessão local removida.'; this.lastLoginAt = null; this.saved = false; this.accountStats = null;
    await fs.rm(this.stateFile, { force: true });
    return this.status();
  }); }

  search(query = '') {
    return this.exclusive(async () => {
      const params = new URLSearchParams({ q: query.slice(0, 200), category: '4', per_page: '96', sort: 'seeders', direction: 'desc' });
      if (this.onlyFreeleech) params.set('freeleech', '1');
      const response = await this.request('/torrents?' + params);
      const rows = pageProps(await response.text())?.torrents?.data;
      if (!Array.isArray(rows)) throw new AscError('Formato da busca ASC mudou; é necessário revisar a integração.');
      this.connected = true; this.message = 'Conta conectada ao ASC.';
      await this.save();
      return rows.filter(row => Number.isSafeInteger(row.id) && row.id > 0 && typeof row.name === 'string'
        && (!this.onlyFreeleech || row.freeleech === true));
    });
  }

  // Página /atividade da própria conta: resumo (HnR, prisão, pendências) e as
  // obrigações abertas (`attention.hitAndRun`), que o tracker já considera concluídas.
  activity() {
    return this.exclusive(async () => {
      const response = await this.request('/atividade');
      const props = pageProps(await response.text());
      if (!props?.summary || !props?.attention) {
        throw new AscError('Formato da página de atividade mudou; é necessário revisar a integração.');
      }
      this.captureStats(props);
      this.connected = true;
      return {
        summary: props.summary,
        rule: props.rule ?? null,
        pending: Array.isArray(props.attention.hitAndRun) ? props.attention.hitAndRun : [],
      };
    });
  }

  // Página do torrent: `myHistory` da própria conta (null = sem registro) e se o
  // release é freeleech. Devolve { history, freeleech }.
  history(id) {
    return this.exclusive(async () => {
      if (!/^\d+$/.test(String(id))) throw new AscError('Torrent inválido.');
      const response = await this.request(`/torrents/${id}`);
      const props = pageProps(await response.text());
      if (!props || typeof props !== 'object' || !('torrent' in props)) {
        throw new AscError('Formato da página do torrent mudou; é necessário revisar a integração.');
      }
      this.connected = true;
      return {
        history: props.myHistory ?? null,
        freeleech: typeof props.torrent?.freeleech === 'boolean' ? props.torrent.freeleech : null,
        name: typeof props.torrent?.name === 'string' ? props.torrent.name : null,
      };
    });
  }

  // Idioma original do filme (atributo `language` do release, ex. "Inglês", "Coreano").
  // O ASC não publica as faixas de áudio (mediainfo vem vazio); isto é o melhor dado exato.
  originalLanguage(id) {
    return this.exclusive(async () => {
      if (!/^\d+$/.test(String(id))) throw new AscError('Torrent inválido.');
      const response = await this.request(`/torrents/${id}`);
      const lang = pageProps(await response.text())?.torrent?.attributes?.language;
      return Array.isArray(lang) && typeof lang[0] === 'string' ? lang[0] : null;
    });
  }

  download(id) {
    return this.exclusive(async () => {
      if (!/^\d+$/.test(String(id))) throw new AscError('Torrent inválido.');
      const response = await this.request(`/torrents/${id}/download`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 8 * 1024 * 1024 || bytes[0] !== 100) throw new AscError('O ASC não retornou um arquivo torrent válido.');
      log.info(`.torrent baixado: id ${id} (${bytes.length} bytes)`);
      await this.save();
      return bytes;
    });
  }
}

module.exports = { AscClient, AscError, pageProps };
