const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { AscError } = require('./asc-client');
const { Logger, logger: defaultLogger, LEVEL_NAMES } = require('./logger');
const { configHost, isLoopbackRequest } = require('./safety');
const { AdminCredential, AdminSessions, LoginLimiter, safeEqual } = require('./admin-auth');
const { PanelError } = require('./panel-settings');

// Tela local do addon. O CSP só aceita script/estilo/fonte do próprio servidor,
// então nada é inline e só arquivos de src/ui/ com extensão conhecida saem daqui.
const UI_DIR = path.join(__dirname, 'ui');
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};
// Páginas do painel: todas devolvem o mesmo shell, o roteador do cliente escolhe a view.
const PAGES = [/^\/$/, /^\/filmes$/, /^\/filmes\/[A-Za-z0-9_-]{1,64}$/, /^\/trafego$/, /^\/logs$/, /^\/conta$/, /^\/entrar$/, /^\/configuracoes$/, /^\/assistente$/];
// Leituras repetidas pelo próprio painel: não geram linha de log (seria ruído e laço).
const QUIET = new Set(['/api/monitor', '/api/status', '/api/logs', '/api/logs/files', '/config.js']);
const MAX_DOWNLOAD = 100_000;
const PANEL_POSTS = ['/api/settings', '/api/settings/preview', '/api/wizard/complete', '/api/wizard/dismiss', '/api/credentials'];

// Cookie de sessão de administração. Em HTTPS (proxy) o prefixo __Host- exige Secure, Path=/ e
// nada de Domain; no canal local/HTTP em claro o navegador não aceitaria Secure, então o nome é outro.
const COOKIE_SECURE = '__Host-asc_admin';
const COOKIE_PLAIN = 'asc_admin';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function staticFile(pathname) {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(pathname) || pathname.includes('..')) return null;
  const ext = path.extname(pathname);
  if (!TYPES[ext]) return null;
  const full = path.join(UI_DIR, pathname);
  if (!full.startsWith(UI_DIR + path.sep)) return null;
  try { return fs.statSync(full).isFile() ? { full, type: TYPES[ext] } : null; } catch { return null; }
}

// `monitor` (opcional): { snapshot(), complete(infoHash) } vindos da ponte.
// `panel` (opcional): createPanelSettings(...) de src/panel-settings.js (assistente e página de
// configurações, issue #23). Todas as rotas dele exigem sessão do ASC confirmada, e as que
// alteram algo passam pelas mesmas barreiras dos POSTs existentes (Host, Origin, CSRF, JSON).
// `remote` (opcional, issue #24): { plan, dataDir, now?, failDelayMs? } com o plano de
// src/admin-access.js. Com a administração pela LAN ativa (plano válido e senha definida), TODAS
// as rotas /api exigem sessão de administração própria (cookie HttpOnly/SameSite=Strict, CSRF por
// sessão), inclusive pelo 127.0.0.1; o Host/Origin aceitos são exatamente os do plano. Sem isso,
// nada muda: só 127.0.0.1, sem login de administração. A sessão do ASC nunca autentica acesso.
// O painel só abre com a sessão ASC confirmada; os logs ficam acessíveis sem
// sessão (é onde se descobre por que o login falhou), sempre só em loopback.
async function startConfig(asc, port = 7020, monitor = null, logs = defaultLogger, panel = null, remote = null) {
  const token = randomBytes(32).toString('hex');
  const origin = `http://127.0.0.1:${port}`;
  const log = logs.child('config');
  let lastLogin = 0;
  const plan = remote?.plan?.enabled ? remote.plan : null;
  const credential = plan ? (remote.credential ?? new AdminCredential({ dataDir: remote.dataDir })) : null;
  const sessions = plan ? new AdminSessions({ idleMs: plan.idleMs, maxMs: plan.maxMs, generation: () => credential.generation(), now: remote.now }) : null;
  const limiter = plan ? new LoginLimiter({ now: remote.now }) : null;
  const failDelayMs = remote?.failDelayMs ?? 400;
  let verifying = 0;
  // Ativa só enquanto a senha existe: removê-la no terminal fecha o acesso remoto na hora.
  const guarded = () => Boolean(plan) && credential.configured();
  if (remote?.plan?.requested && !plan) {
    log.error(`administração do painel pela LAN NÃO habilitada (fail-closed): ${remote.plan.problems.join(' ')} O painel local segue normalmente.`);
  }
  const handlePanel = async (route, body) => {
    try {
      if (route === '/api/settings/preview') return [200, panel.preview(body)];
      if (route === '/api/settings') {
        const out = panel.save(body);
        log.info(`configuração alterada pelo painel: ${out.changes.map((c) => c.key).join(', ') || 'sem mudança'} (revisão ${out.revision})`);
        return [200, out];
      }
      if (route === '/api/wizard/complete' || route === '/api/wizard/dismiss') {
        const state = panel.wizardMark(route.endsWith('complete') ? 'complete' : 'dismiss');
        log.info(`assistente de configuração: ${route.endsWith('complete') ? 'concluído' : 'adiado'}`);
        return [200, state];
      }
      // /api/credentials: o token sai só aqui, uma vez (nunca é registrado em log).
      const made = panel.createCredential(body);
      log.info(`credencial de instalação emitida pelo painel: ${made.credential.id}`);
      return [201, made];
    } catch (error) {
      if (!(error instanceof PanelError)) throw error;
      log.warn(`${route}: ${error.code}: ${error.message}`);
      return [error.status, { error: error.message, code: error.code, problems: error.problems }];
    }
  };
  const handler = async (req, res) => {
    const started = Date.now();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; img-src 'self' data:");
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    let pathname = '';
    res.on('finish', () => {
      if (!pathname || QUIET.has(pathname) || (res.statusCode < 400 && (pathname.startsWith('/assets/') || /\.(js|css|woff2|svg)$/.test(pathname)))) return;
      const msg = `${req.method} ${pathname} → ${res.statusCode} (${Date.now() - started} ms)`;
      if (res.statusCode >= 500) log.error(msg);
      else if (res.statusCode >= 400) log.warn(msg);
      else log.debug(msg);
    });
    // Canal: 'local' (127.0.0.1:porta) ou 'remote' (Host exatamente igual ao do plano). Origin
    // esperado = esquema + o próprio Host já validado. Nada de curinga nem de cabeçalho encaminhado.
    const hostHeader = String(req.headers.host ?? '');
    const guard = guarded();
    let channel = null;
    if (hostHeader === `127.0.0.1:${port}` && (!guard || isLoopbackRequest(req))) channel = { kind: 'local', host: hostHeader, origin };
    else if (guard && plan.hosts.includes(hostHeader.toLowerCase()) && (plan.transport !== 'https-proxy' || isLoopbackRequest(req))) {
      channel = { kind: 'remote', host: hostHeader.toLowerCase(), origin: `${plan.transport === 'https-proxy' ? 'https' : 'http'}://${hostHeader.toLowerCase()}` };
    }
    if (!channel) {
      log.warn(`requisição recusada: Host inesperado (${hostHeader.slice(0, 60)})`);
      return send(403, { error: 'Abra pelo endereço 127.0.0.1.' });
    }
    const cookieName = channel.kind === 'remote' && plan?.secureCookie ? COOKIE_SECURE : COOKIE_PLAIN;
    const cookieAttrs = (value, maxAge) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cookieName === COOKIE_SECURE ? '; Secure' : ''}`;
    const source = req.socket?.remoteAddress ?? 'desconhecido';
    const readBody = async () => {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) return { tooBig: true }; chunks.push(chunk); }
      try { return { body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }; } catch { return { invalid: true }; }
    };
    try {
      const url = new URL(req.url, origin);
      pathname = url.pathname;
      const sp = url.searchParams;
      let admin = null; // sessão de administração válida desta requisição
      if (guard) {
        const found = sessions.check(readCookie(req.headers.cookie, cookieName), channel.host);
        if (found) {
          admin = found.session;
          if (found.rotateTo) res.setHeader('Set-Cookie', cookieAttrs(found.rotateTo, Math.ceil(plan.maxMs / 1000)));
        }
      }
      if (url.pathname === '/api/admin/session') {
        if (!guard) return send(200, { enabled: false });
        const view = () => ({ enabled: true, authenticated: Boolean(admin), channel: channel.kind, transport: plan.transport,
          ...(admin ? { csrf: admin.csrf, expiresAt: new Date(sessions.expiresAt(admin)).toISOString(), idleMinutes: plan.idleMs / 60000 } : {}) });
        if (req.method === 'GET') return send(200, view());
        const sameOrigin = req.headers.origin === channel.origin;
        if (req.method === 'DELETE') {
          if (!admin) return send(401, { error: 'Sessão de administração ausente.', code: 'admin_required' });
          if (!sameOrigin || !safeEqual(req.headers['x-csrf-token'], admin.csrf)) return send(403, { error: 'Requisição não autorizada.' });
          sessions.destroyKey(admin.keyHash);
          res.setHeader('Set-Cookie', cookieAttrs('', 0));
          log.info('sessão de administração encerrada (logout)');
          return send(200, { enabled: true, authenticated: false });
        }
        if (req.method !== 'POST') return send(405, { error: 'Método não permitido.' });
        // Login: defesa contra login-CSRF (Origin exata, JSON, token de pré-login) e contra força bruta.
        if (!sameOrigin || req.headers['content-type'] !== 'application/json' || !safeEqual(req.headers['x-csrf-token'], token)) {
          log.warn('login de administração recusado: origem ou token CSRF inválido');
          return send(403, { error: 'Requisição não autorizada.' });
        }
        const wait = limiter.check(source);
        if (!wait.ok || verifying >= 2) {
          const retry = wait.ok ? 1 : wait.retryAfter;
          res.setHeader('Retry-After', String(retry));
          log.warn(`login de administração adiado: excesso de tentativas (origem ${source})`);
          return send(429, { error: `Muitas tentativas. Aguarde ${retry} s.`, code: 'rate_limited' });
        }
        const parsed = await readBody();
        if (parsed.tooBig) return send(413, { error: 'Dados muito grandes.' });
        if (parsed.invalid || typeof parsed.body.password !== 'string') return send(400, { error: 'Dados inválidos.' });
        verifying += 1;
        let ok = false;
        try { ok = await credential.verify(parsed.body.password); } finally { verifying -= 1; }
        if (!ok) {
          limiter.fail(source);
          log.warn(`login de administração recusado (origem ${source})`);
          if (failDelayMs) await sleep(failDelayMs);
          return send(401, { error: 'Senha incorreta.', code: 'bad_password' });
        }
        // Rotação: a sessão anterior (se houver) morre e o id é sempre novo (sem fixação de sessão).
        const previous = readCookie(req.headers.cookie, cookieName);
        if (previous) sessions.destroy(previous);
        const created = sessions.create(channel.host);
        limiter.succeed(source);
        admin = created.session;
        res.setHeader('Set-Cookie', cookieAttrs(created.id, Math.ceil(plan.maxMs / 1000)));
        log.info(`sessão de administração iniciada (${channel.kind}, origem ${source})`);
        return send(200, view());
      }
      if (guard && url.pathname.startsWith('/api/') && !admin) {
        return send(401, { error: 'Entre com a senha de administração.', code: 'admin_required' });
      }
      if (req.method === 'GET' && PAGES.some((re) => re.test(url.pathname))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(UI_DIR, 'index.html')));
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const file = url.pathname === '/config.js' ? null : staticFile(url.pathname);
        if (file) { res.writeHead(200, { 'Content-Type': file.type }); return res.end(fs.readFileSync(file.full)); }
      }
      if (req.method === 'GET' && url.pathname === '/config.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(`window.ASC_CSRF=${JSON.stringify(token)};`);
      }

      // ---- logs (sem exigir sessão do ASC)
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const filter = Logger.parseFilter(sp);
        const { entries, more } = logs.query(filter, { after: Number(sp.get('after')) || 0, before: Number(sp.get('before')) || 0, limit: Number(sp.get('limit')) || 500 });
        return send(200, {
          boot: logs.boot, lastId: logs.lastId, level: logs.level, levels: LEVEL_NAMES, entries, more,
          counts: logs.counts(filter.since), sources: logs.sources(), total: logs.entries.length,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/logs/files') return send(200, { files: logs.listFiles(), retentionDays: logs.retentionDays });
      if (req.method === 'GET' && url.pathname === '/api/logs/download') {
        const nd = sp.get('formato') === 'ndjson';
        const { entries } = logs.query(Logger.parseFilter(sp), { limit: MAX_DOWNLOAD });
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
        res.writeHead(200, {
          'Content-Type': nd ? 'application/x-ndjson; charset=utf-8' : 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="asc-logs-${stamp}.${nd ? 'ndjson' : 'txt'}"`,
        });
        log.info(`download de logs (${nd ? 'ndjson' : 'txt'}): ${entries.length} linha(s)`);
        return res.end(entries.map((e) => (nd ? JSON.stringify(e) : logs.format(e))).join('\n') + (entries.length ? '\n' : ''));
      }
      if (req.method === 'GET' && url.pathname === '/api/logs/file') {
        const full = logs.filePath(sp.get('nome'));
        if (!full) return send(404, { error: 'Arquivo de log inexistente.' });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename="${path.basename(full)}"` });
        log.info(`download do arquivo ${path.basename(full)}`);
        return res.end(fs.readFileSync(full));
      }

      if (req.method === 'GET' && url.pathname === '/api/status') return send(200, asc.status());
      if (req.method === 'GET' && url.pathname === '/api/monitor') {
        if (!monitor) return send(404, { error: 'Painel indisponível.' });
        if (!asc.connected) return send(401, { error: 'Conecte e confirme a sessão do ASC para abrir o painel.' });
        return send(200, monitor.snapshot());
      }
      if (req.method === 'GET' && (url.pathname === '/api/settings' || url.pathname === '/api/credentials')) {
        if (!panel) return send(404, { error: 'Configurações indisponíveis.' });
        if (!asc.connected) return send(401, { error: 'Conecte e confirme a sessão do ASC para abrir as configurações.' });
        return send(200, url.pathname === '/api/settings' ? panel.state() : { credentials: panel.listCredentials() });
      }
      const routes = ['/api/login', '/api/verify', '/api/logout', '/api/complete', '/api/logs/level', ...PANEL_POSTS];
      if (req.method !== 'POST' || !routes.includes(url.pathname)) return send(404, { error: 'Página inexistente.' });
      const csrfOk = guard ? safeEqual(req.headers['x-csrf-token'], admin.csrf) : req.headers['x-csrf-token'] === token;
      if (req.headers.origin !== channel.origin || !csrfOk || req.headers['content-type'] !== 'application/json') {
        log.warn(`POST ${url.pathname} recusado: origem ou token CSRF inválido`);
        return send(403, { error: 'Requisição não autorizada.' });
      }
      const parsed = await readBody();
      if (parsed.tooBig) return send(413, { error: 'Dados muito grandes.' });
      if (parsed.invalid) return send(400, { error: 'Dados inválidos.' });
      const body = parsed.body;
      if (PANEL_POSTS.includes(url.pathname)) {
        if (!panel) return send(404, { error: 'Configurações indisponíveis.' });
        if (!asc.connected) return send(401, { error: 'Sessão não confirmada.' });
        return send(...await handlePanel(url.pathname, body));
      }
      if (url.pathname === '/api/logs/level') {
        if (typeof body.nivel !== 'string' || !logs.setLevel(body.nivel)) return send(400, { error: 'Nível inválido.' });
        log.info(`nível mínimo de gravação alterado para ${body.nivel}`);
        return send(200, { level: logs.level });
      }
      if (url.pathname === '/api/complete') {
        if (!monitor) return send(404, { error: 'Painel indisponível.' });
        if (!asc.connected) return send(401, { error: 'Sessão não confirmada.' });
        if (typeof body.infoHash !== 'string' || !/^[0-9a-f]{40}$/.test(body.infoHash)) return send(400, { error: 'Filme inválido.' });
        log.info(`concluir download pedido pelo painel: ${body.infoHash}`);
        return send(202, await monitor.complete(body.infoHash));
      }
      if (url.pathname === '/api/login') {
        if (typeof body.username !== 'string' || !body.username.trim() || body.username.length > 100 || typeof body.password !== 'string' || !body.password || body.password.length > 512 || typeof body.onlyFreeleech !== 'boolean') return send(400, { error: 'Preencha usuário e senha.' });
        if (Date.now() - lastLogin < 15000) { log.warn('login adiado: tentativa em menos de 15 s da anterior'); return send(429, { error: 'Aguarde 15 segundos antes de tentar novamente.' }); }
        lastLogin = Date.now();
        log.info('login: tentativa pelo painel');
        const status = await asc.login(body.username.trim(), body.password, body.onlyFreeleech);
        log.info(`login: sessão confirmada (filtro freeleech ${body.onlyFreeleech ? 'ligado' : 'desligado'})`);
        return send(200, status);
      }
      if (url.pathname === '/api/verify') {
        const status = await asc.verify();
        log.info('sessão verificada pelo painel: conectada');
        return send(200, status);
      }
      log.info('sessão local removida pelo painel');
      return send(200, await asc.logout());
    } catch (error) {
      const known = error instanceof AscError;
      // O motivo real vai para o log (já redigido); a resposta ao navegador segue genérica.
      log[known ? 'warn' : 'error'](`${req.method} ${pathname}: ${error?.message ?? error}`, known ? undefined : { stack: error?.stack });
      send(400, { error: known ? error.message : (error?.status === 404 ? 'Filme fora da biblioteca.' : 'Não foi possível concluir. Tente novamente.') });
    }
  };
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, configHost(), resolve); });
  log.info(`painel escutando em ${origin}`);
  // Administração pela LAN em HTTP em claro: segundo listener só no IPv4 da LAN escolhido (nunca
  // 0.0.0.0). Se falhar (IP mudou), a administração remota fica inacessível; o painel local segue.
  const extras = [];
  if (plan) {
    for (const addr of plan.bind.filter((a) => a !== '127.0.0.1')) {
      const extra = http.createServer(handler);
      try {
        await new Promise((resolve, reject) => { extra.once('error', reject); extra.listen(port, addr, resolve); });
        extras.push(extra);
        log.warn(`administração do painel pela LAN ativa em ${addr}:${port} (HTTP sem criptografia; Host aceito: ${plan.hosts.join(', ')})`);
      } catch (err) {
        log.error(`administração pela LAN indisponível: não foi possível escutar em ${addr}:${port} (${err.code ?? err.message}). O painel local segue normalmente.`);
      }
    }
    if (plan.transport === 'https-proxy') log.info(`administração do painel pela LAN ativa atrás de proxy HTTPS (${plan.hosts.join(', ')}); o painel escuta só em 127.0.0.1`);
    if (!credential.configured()) log.warn('administração pela LAN habilitada, mas sem senha de administração: acesso remoto fechado (npm run admin-painel -- definir)');
  }
  if (extras.length) {
    const close = server.close.bind(server);
    server.close = (cb) => { for (const e of extras) e.close(); sessions.destroyAll(); return close(cb); };
  }
  server.admin = plan ? { sessions, limiter, credential } : null;
  return server;
}

module.exports = { startConfig };
