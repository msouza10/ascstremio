// Porta de entrada autenticada do addon (porta 7000).
//
// O Stremio só propaga a URL base do manifesto para catálogo, meta e stream; não envia
// cabeçalhos. Por isso a credencial vai no prefixo do caminho: /<token>/manifest.json,
// /<token>/catalog/..., e assim por diante (modelo da URL base com dados do usuário do
// SDK). Query só no manifesto não bastaria: não é repassada às demais rotas.
//
// Sem credencial válida (ausente, errada ou revogada) a resposta é sempre a mesma 403,
// antes de qualquer leitura de catálogo, conta ou status. A credencial de reprodução
// nunca alcança painel, logs ou rotas administrativas: estas ficam em outras portas.

const { TOKEN_RE, runWith } = require('./credentials');
const { STATUS_PREFIX, posterRoute } = require('./stremio-status');
const log = require('./logger').logger.child('addon');

const PREFIX = /^\/([^/?]+)(\/[^?]*)?(\?.*)?$/;
const ROUTES = /^\/(manifest\.json|(catalog|meta|stream)\/.+|status\/poster\/.+)$/;

function deny(res, code = 403, message = 'credencial ausente, inválida ou revogada: reinstale o addon com a URL emitida') {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}

// O catálogo de status (ratio, avisos) só aparece para credenciais com `status`.
function manifestFor(manifest, credential) {
  if (credential.status) return manifest;
  return {
    ...manifest,
    catalogs: manifest.catalogs.filter((c) => c.id !== 'asc-status'),
    idPrefixes: (manifest.idPrefixes ?? []).filter((p) => p !== STATUS_PREFIX),
  };
}

function createAddonHandler({ addon, router, store, status = null, activity = null }) {
  return (req, res) => {
    const m = PREFIX.exec(String(req.url ?? ''));
    const credential = m && TOKEN_RE.test(m[1]) ? store.verify(m[1]) : null;
    if (!credential) {
      log.warn(`${req.method} recusado: credencial ausente, inválida ou revogada`);
      deny(res);
      return;
    }
    const rest = m[2] || '/';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !ROUTES.test(rest)) { deny(res, 404, 'rota desconhecida'); return; }
    req.url = rest + (m[3] ?? '');
    // Só GET de credencial válida conta: HEAD/OPTIONS (sondas, preflight) não provam uso.
    if (req.method === 'GET') activity?.record(credential.id, rest);

    runWith(credential, m[1], () => {
      if (rest === '/manifest.json' && req.method !== 'OPTIONS') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(manifestFor(addon.manifest, credential)));
        return;
      }
      if (rest.startsWith('/status/poster/')) {
        if (!credential.status || !status || !posterRoute(req, res, status.snapshot, status.panelUrl)) deny(res, 404, 'rota desconhecida');
        return;
      }
      router(req, res, () => { res.writeHead(404); res.end(); });
    });
  };
}

module.exports = { createAddonHandler, manifestFor };
