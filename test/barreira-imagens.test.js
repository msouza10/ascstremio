const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const barrier = path.resolve(__dirname, '..', 'scripts', 'check-no-secrets.sh');
// Cada caso roda uma cópia da barreira com uma lista pública própria, que libera os nomes das
// fixtures: o que está em teste são as regras de imagem, não a lista de documentos.
const PNG = 'docs/imagens/painel-claro.png';

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (tipo, dados) => {
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const cabeca = Buffer.alloc(4); cabeca.writeUInt32BE(dados.length);
  const fim = Buffer.alloc(4); fim.writeUInt32BE(crc32(corpo));
  return Buffer.concat([cabeca, corpo, fim]);
};
// PNG sintético (cinza 8 bits) gerado em memória; `extras` entram antes do IDAT.
function png({ largura = 8, altura = 2, extras = [] } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0); ihdr.writeUInt32BE(altura, 4); ihdr[8] = 8; ihdr[9] = 0;
  const linhas = Buffer.alloc((largura + 1) * altura);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), ...extras, chunk('IDAT', zlib.deflateSync(linhas)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
// Um arquivo grande e ainda PNG válido: chunk privado (não é metadado de texto) cheio de bytes.
const pngGrande = () => png({ extras: [chunk('prVt', Buffer.alloc(210 * 1024, 7))] });

// WebP mínimo (1x1, sem perdas) e variante com chunk de metadados antes da imagem.
const WEBP_1X1 = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
function webpCom(tipo) {
  const dados = Buffer.from('dados-sinteticos');
  const cab = Buffer.alloc(8); cab.write(tipo, 0, 'ascii'); cab.writeUInt32LE(dados.length, 4);
  const imagem = WEBP_1X1.subarray(12);
  const corpo = Buffer.concat([Buffer.from('WEBP'), cab, dados, imagem]);
  const riff = Buffer.alloc(8); riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(corpo.length, 4);
  return Buffer.concat([riff, corpo]);
}

function varrer(t, arquivos) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-imagens-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const app = path.join(temp, 'pacote');
  fs.mkdirSync(path.join(app, 'docs', 'imagens'), { recursive: true });
  fs.mkdirSync(path.join(app, 'scripts'));
  fs.copyFileSync(barrier, path.join(app, 'scripts', 'check-no-secrets.sh'));
  fs.writeFileSync(path.join(app, 'README.md'), '# Exemplo público\n');
  fs.writeFileSync(path.join(app, 'scripts', 'documentation-files.txt'), `${Object.keys(arquivos).join('\n')}\n`);
  for (const [nome, conteudo] of Object.entries(arquivos)) fs.writeFileSync(path.join(app, nome), conteudo);
  const r = spawnSync('bash', [path.join(app, 'scripts', 'check-no-secrets.sh'), app], { encoding: 'utf8' });
  return { status: r.status, saida: r.stdout + r.stderr };
}

const opcoes = { skip: process.platform === 'win32' };

test('barreira de imagens aceita PNG e WebP limpos', opcoes, (t) => {
  const r = varrer(t, { [PNG]: png(), 'docs/imagens/painel-escuro.png': png({ largura: 1280 }) });
  assert.equal(r.status, 0, r.saida);
  const w = varrer(t, { 'docs/imagens/painel-claro.webp': WEBP_1X1 });
  assert.equal(w.status, 0, w.saida);
});

test('barreira de imagens barra extensão fora de png/webp', opcoes, (t) => {
  for (const nome of ['docs/imagens/painel-claro.gif', 'docs/imagens/painel-claro.svg', 'docs/imagens/painel-claro.jpg', 'docs/imagens/painel-claro.PNG.exe']) {
    const r = varrer(t, { [nome]: png() });
    assert.equal(r.status, 1, `${nome}\n${r.saida}`);
    assert.match(r.saida, /extensão/);
  }
});

test('barreira de imagens barra arquivo acima de 200 KiB', opcoes, (t) => {
  const r = varrer(t, { [PNG]: pngGrande() });
  assert.equal(r.status, 1, r.saida);
  assert.match(r.saida, /200 KiB/);
  // Exatamente no limite passa: 200 KiB = 204800 bytes.
  const limite = png({ extras: [chunk('prVt', Buffer.alloc(204800 - png().length - 12, 7))] });
  assert.equal(limite.length, 204800);
  assert.equal(varrer(t, { [PNG]: limite }).status, 0);
});

test('barreira de imagens barra largura acima de 1280 px', opcoes, (t) => {
  const r = varrer(t, { [PNG]: png({ largura: 1281 }) });
  assert.equal(r.status, 1, r.saida);
  assert.match(r.saida, /1280 px/);
});

test('barreira de imagens barra metadados em PNG (tEXt, iTXt, zTXt, eXIf)', opcoes, (t) => {
  for (const tipo of ['tEXt', 'iTXt', 'zTXt', 'eXIf']) {
    const r = varrer(t, { [PNG]: png({ extras: [chunk(tipo, Buffer.from('Author\0dados-sinteticos'))] }) });
    assert.equal(r.status, 1, `${tipo}\n${r.saida}`);
    assert.match(r.saida, /metadados/);
  }
});

test('barreira de imagens barra metadados em WebP (EXIF, XMP )', opcoes, (t) => {
  for (const tipo of ['EXIF', 'XMP ']) {
    const r = varrer(t, { [PNG.replace('.png', '.webp')]: webpCom(tipo) });
    assert.equal(r.status, 1, `${tipo}\n${r.saida}`);
    assert.match(r.saida, /metadados/);
  }
});

test('texto "tEXt" solto dentro dos pixels não é confundido com chunk de metadados', opcoes, (t) => {
  // O chunk é percorrido pela estrutura: bytes iguais ao nome dentro de outro chunk não bloqueiam.
  const r = varrer(t, { [PNG]: png({ extras: [chunk('prVt', Buffer.from('tEXt iTXt zTXt eXIf'))] }) });
  assert.equal(r.status, 0, r.saida);
});

test('barreira de imagens barra arquivo que não é PNG/WebP de verdade', opcoes, (t) => {
  const r = varrer(t, { [PNG]: Buffer.from('isto não é uma imagem') });
  assert.equal(r.status, 1, r.saida);
  assert.match(r.saida, /ilegível|inválid/);
});
