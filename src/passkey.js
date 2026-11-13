// Configuração separada da passkey para montar o announce em memória.
//
// A integração salva os .torrent como recebidos do ASC: eles podem conter a
// passkey no announce. Definir PASSKEY ou PASSKEY_FILE não limpa esses arquivos.
//
// Os .torrent, a passkey separada e os backups são pessoais: devem permanecer
// protegidos e fora do repositório, de capturas e de compartilhamentos.

const fs = require('fs');

const DEFAULT_ANNOUNCE_BASE = 'https://amigos-share.club/announce';
const TOKEN_IN_PATH = /^(https?:\/\/[^/]+\/announce)\/([A-Za-z0-9]{16,})$/i;

// Extrai "https://host/announce" de uma URL que talvez carregue token.
function announceBaseOf(url) {
  if (!url) return null;
  const withToken = TOKEN_IN_PATH.exec(url);
  if (withToken) return withToken[1];
  const clean = String(url).split('?')[0].replace(/\/+$/, '');
  return clean.length > 0 ? clean : null;
}

// Lê a passkey de PASSKEY_FILE (arquivo) ou PASSKEY (ambiente).
// Nunca loga o valor; devolve null quando não configurada.
function readPasskey({ env = process.env, file = null } = {}) {
  const fromEnv = (env.PASSKEY || '').trim();
  if (fromEnv) return sanitize(fromEnv);

  const target = file || env.PASSKEY_FILE || null;
  if (!target) return null;

  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const value = sanitize(raw);
  if (!value) return null;

  const mode = fs.statSync(target).mode & 0o777;
  if (mode & 0o077) {
    console.warn(`[passkey] ${target} está com permissão ${mode.toString(8)}; use chmod 600`);
  }
  return value;
}

function sanitize(value) {
  // Aceita "abc123", "PASSKEY=abc123" ou a URL de announce inteira.
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const asUrl = TOKEN_IN_PATH.exec(trimmed);
  if (asUrl) return asUrl[2];
  const pair = /(?:^|[\s;&])(?:passkey|token)=([A-Za-z0-9]+)/i.exec(trimmed);
  if (pair) return pair[1];
  return /^[A-Za-z0-9]{8,}$/.test(trimmed) ? trimmed : null;
}

// Monta a URL de announce em memória; não altera o .torrent salvo no disco.
function announceWithPasskey(base, passkey) {
  const clean = announceBaseOf(base) || DEFAULT_ANNOUNCE_BASE;
  if (!passkey) return clean;
  return `${clean}/${encodeURIComponent(passkey)}`;
}

module.exports = { readPasskey, announceWithPasskey, announceBaseOf, DEFAULT_ANNOUNCE_BASE };

if (require.main === module) {
  // Diagnóstico sem expor o segredo.
  const passkey = readPasskey({ file: process.argv[2] });
  if (!passkey) {
    console.log('passkey: não configurada (grave a passkey em passkey.txt na pasta de dados ou defina PASSKEY)');
  } else {
    console.log(`passkey: carregada (${passkey.length} caracteres) — valor não exibido`);
    console.log(`announce: ${announceWithPasskey(DEFAULT_ANNOUNCE_BASE, passkey).replace(/\/[^/]+$/, '/****')}`);
  }
}
