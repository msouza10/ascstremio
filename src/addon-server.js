const http = require('node:http');
const { getRouter } = require('stremio-addon-sdk');
const { createAddonHandler } = require('./addon-auth');
const { hostAllowed } = require('./safety');

// Produção e integração compartilham autenticação, SDK e proteção de Host.
function createAddonServer({ addon, credentials, status = null, activity = null }) {
  const handle = createAddonHandler({ addon, router: getRouter(addon), store: credentials, status, activity });
  return http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host)) { res.writeHead(403); res.end(); return; }
    handle(req, res);
  });
}

module.exports = { createAddonServer };
