const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { AscError } = require('./asc-client');
const { Logger, logger: defaultLogger, LEVEL_NAMES } = require('./logger');
const { configHost } = require('./safety');

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
const PAGES = [/^\/$/, /^\/filmes$/, /^\/filmes\/[A-Za-z0-9_-]{1,64}$/, /^\/trafego$/, /^\/logs$/, /^\/conta$/, /^\/entrar$/];
// Leituras repetidas pelo próprio painel: não geram linha de log (seria ruído e laço).
const QUIET = new Set(['/api/monitor', '/api/status', '/api/logs', '/api/logs/files', '/config.js']);
const MAX_DOWNLOAD = 100_000;

function staticFile(pathname) {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(pathname) || pathname.includes('..')) return null;
  const ext = path.extname(pathname);
  if (!TYPES[ext]) return null;
  const full = path.join(UI_DIR, pathname);
  if (!full.startsWith(UI_DIR + path.sep)) return null;
  try { return fs.statSync(full).isFile() ? { full, type: TYPES[ext] } : null; } catch { return null; }
}

// `monitor` (opcional): { snapshot(), complete(infoHash) } vindos da ponte.
// O painel só abre com a sessão ASC confirmada; os logs ficam acessíveis sem
// sessão (é onde se descobre por que o login falhou), sempre só em loopback.
async function startConfig(asc, port = 7020, monitor = null, logs = defaultLogger) {
  const token = randomBytes(32).toString('hex');
  const origin = `http://127.0.0.1:${port}`;
  const log = logs.child('config');
  let lastLogin = 0;
  const server = http.createServer(async (req, res) => {
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
    if (req.headers.host !== `127.0.0.1:${port}`) {
      log.warn(`requisição recusada: Host inesperado (${String(req.headers.host).slice(0, 60)})`);
      return send(403, { error: 'Abra pelo endereço 127.0.0.1.' });
    }
    try {
      const url = new URL(req.url, origin);
      pathname = url.pathname;
      const sp = url.searchParams;
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
          'Content-Disposition': `attachment; filename="brazuka-logs-${stamp}.${nd ? 'ndjson' : 'txt'}"`,
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
      const routes = ['/api/login', '/api/verify', '/api/logout', '/api/complete', '/api/logs/level'];
      if (req.method !== 'POST' || !routes.includes(url.pathname)) return send(404, { error: 'Página inexistente.' });
      if (req.headers.origin !== origin || req.headers['x-csrf-token'] !== token || req.headers['content-type'] !== 'application/json') {
        log.warn(`POST ${url.pathname} recusado: origem ou token CSRF inválido`);
        return send(403, { error: 'Requisição não autorizada.' });
      }
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) return send(413, { error: 'Dados muito grandes.' }); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return send(400, { error: 'Dados inválidos.' }); }
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
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, configHost(), resolve); });
  log.info(`painel escutando em ${origin}`);
  return server;
}

module.exports = { startConfig };
