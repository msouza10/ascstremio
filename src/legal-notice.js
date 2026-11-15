const fs = require('node:fs');
const path = require('node:path');

// O aviso fica ao lado do package.json em todos os formatos. Nunca aceitar do
// navegador um caminho de arquivo ou renderizar o Markdown como HTML executável.
function serveLegalNotice(req, res, { root = path.join(__dirname, '..') } = {}) {
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Método não permitido.');
    return;
  }
  let content;
  try { content = fs.readFileSync(path.join(root, 'LEGAL.md')); } catch {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : 'Avisos legais indisponíveis nesta instalação. Reinstale o pacote completo.');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': 'inline',
    'Content-Length': content.length,
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}

module.exports = { serveLegalNotice };
