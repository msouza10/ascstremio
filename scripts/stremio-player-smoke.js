#!/usr/bin/env node
// Sonda especializada: usa o shell Linux instalado, não inicia sessão em serviços.
// A página de controle substitui a UI web; não prova instalação/navegação de addons.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { CredentialStore } = require('../src/credentials');
const { createAddon } = require('../src/addon');
const { createAddonHandler } = require('../src/addon-auth');
const { getRouter } = require('stremio-addon-sdk');

const HASH = 'a'.repeat(40);

function pagina(manifestUrl) {
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>ascstremio — teste sem conta</title>
<body style="background:#151515;color:white"><h1>Teste do player instalado</h1><p id="estado">Preparando vídeo sintético…</p>
<script>
const estado = document.getElementById('estado');
const props = {};
let fase = 'início', instante = 0, posicaoPausa = 0, inicioSeek = 0, posicaoSeek = 0;
const enviar = (nome, valor) => window.ipc.postMessage(JSON.stringify({type: 6, args: valor === undefined ? [nome] : [nome, valor]}));
const registrar = (dados) => fetch('/evidencia', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(dados)});
window.qt.webChannelTransport.onmessage = () => {};
window.ipc.addEventListener('message', async ({data}) => {
  const mensagem = typeof data === 'string' ? JSON.parse(data) : data;
  const [evento, valor] = mensagem.args || [];
  if (evento === 'mpv-event-ended' && valor.error) {
    estado.textContent = 'Falha no player';
    await registrar({erro:'player encerrou com erro'});
  }
  if (evento !== 'mpv-prop-change') return;
  props[valor.name] = valor.data;
  if (valor.name !== 'time-pos' || typeof valor.data !== 'number') return;
  estado.textContent = fase + ' — ' + valor.data.toFixed(1) + ' s';
  if (fase === 'início' && valor.data > 2 && Number(props['video-params']?.w) > 0) {
    fase = 'pausa'; posicaoPausa = valor.data; instante = performance.now();
    await registrar({etapa:'reprodução',posicao:valor.data,largura:props['video-params'].w});
    enviar('mpv-set-prop',['pause',true]);
    setTimeout(async () => {
      if (props.pause !== true || Math.abs(props['time-pos'] - posicaoPausa) > 0.5) {
        await registrar({erro:'pausa não confirmada'}); return;
      }
      await registrar({etapa:'pausa',posicao:props['time-pos'],esperaMs:Math.round(performance.now()-instante)});
      fase = 'retomada'; enviar('mpv-set-prop',['pause',false]);
    },1500);
  } else if (fase === 'retomada' && valor.data > posicaoPausa + 1) {
    fase = 'seek'; await registrar({etapa:'retomada',posicao:valor.data});
    inicioSeek = performance.now(); posicaoSeek = valor.data;
    enviar('mpv-command',['seek','30','absolute']);
    setTimeout(() => {
      if (fase === 'seek') { fase = 'falha'; registrar({erro:'seek não confirmou salto em 3 segundos'}); }
    },3000);
  } else if (fase === 'seek' && valor.data >= 29 && valor.data < 35 &&
      valor.data - posicaoSeek > 20 && performance.now() - inicioSeek < 3000) {
    fase = 'concluído'; enviar('mpv-set-prop',['pause',true]);
    await registrar({etapa:'seek',posicao:valor.data});
  }
});
(async () => {
  for (const nome of ['time-pos','pause','video-params','duration']) enviar('mpv-observe-prop',nome);
  const manifestUrl = ${JSON.stringify(manifestUrl)};
  const base = manifestUrl.slice(0,-'manifest.json'.length);
  const manifest = await (await fetch(manifestUrl)).json();
  const catalog = await (await fetch(base+'catalog/movie/asc-online.json')).json();
  const item = catalog.metas[0];
  const meta = await (await fetch(base+'meta/movie/'+encodeURIComponent(item.id)+'.json')).json();
  const resultado = await (await fetch(base+'stream/movie/'+encodeURIComponent(item.id)+'.json')).json();
  if (!manifest.id || meta.meta.id !== item.id || !resultado.streams[0]?.url) throw Error('contrato inválido');
  await registrar({etapa:'addon',titulo:item.name});
  enviar('mpv-set-prop',['volume',0]);
  enviar('mpv-command',['loadfile',resultado.streams[0].url]);
})().catch(() => registrar({erro:'preparo do teste falhou'}));
</script></body></html>`;
}

async function iniciar(video, raiz = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(raiz, 'ascstremio-player-'));
  const store = new CredentialStore({ file: path.join(dir, 'credentials.json') });
  const { token, credential } = store.create({ name: 'Player sintético' });
  const bridge = new Bridge({ torrentDir: dir, storeDir: dir, credentials: store, vault: new SeedVault({ file: path.join(dir, 'cofre.json') }) });
  const length = fs.statSync(video).size;
  const arquivo = { index: 0, path: 'sintetico.mp4', length, isVideo: true };
  bridge.entries.set(HASH, { infoHash: HASH, files: [arquivo] });
  // Só o motor torrent é simulado: a ponte serve o arquivo válido pelo HTTP real.
  bridge.getTorrent = async () => ({ ready: true, numPeers: 0, files: [{ ...arquivo, createReadStream: (range) => fs.createReadStream(video, range) }] });
  const evidencias = { etapas: [], erros: [], pedidosVideo: [] };
  const servidorVideo = http.createServer((req, res) => {
    res.once('finish', () => evidencias.pedidosVideo.push({ metodo: req.method, range: req.headers.range ?? null, status: res.statusCode }));
    bridge.handle(req, res).catch(() => res.destroy());
  });
  await new Promise((resolve) => servidorVideo.listen(0, '127.0.0.1', resolve));
  bridge.publicUrl = `http://127.0.0.1:${servidorVideo.address().port}`;
  const item = { id: 'ascfilm:1', type: 'movie', name: 'ascstremio — vídeo sintético' };
  const remote = {
    async catalog() { return [item]; },
    meta() { return item; },
    async streamsFor() { return [{ name: 'Ponte real · arquivo sintético', url: bridge.urlFor(HASH, 0) }]; },
  };
  const addon = createAddon({ remote });
  const handler = createAddonHandler({ addon, router: getRouter(addon), store });
  let manifestUrl;
  const server = http.createServer(async (req, res) => {
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403); res.end(); return; }
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(pagina(manifestUrl)); return;
    }
    if (req.url === '/evidencia' && req.method === 'POST') {
      if (req.headers.origin !== `http://127.0.0.1:${server.address().port}`) { res.writeHead(403); res.end(); return; }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) { res.writeHead(413); res.end(); return; }
      }
      try {
        const dado = JSON.parse(body);
        if (typeof dado.erro === 'string') evidencias.erros.push(dado.erro.slice(0,100));
        else if (['addon','reprodução','pausa','retomada','seek'].includes(dado.etapa)) {
          evidencias.etapas.push({ etapa: dado.etapa, posicao: Number(dado.posicao) || 0, largura: Number(dado.largura) || 0 });
        }
        fs.writeFileSync(path.join(dir, 'evidencias.json'), JSON.stringify(evidencias, null, 2), { mode: 0o600 });
        console.log(JSON.stringify({ etapa: dado.etapa ?? 'erro' }));
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
      return;
    }
    handler(req,res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  manifestUrl = `http://127.0.0.1:${server.address().port}/${token}/manifest.json`;
  fs.writeFileSync(path.join(dir, 'sessao.json'), JSON.stringify({ manifestUrl }), { mode: 0o600 });
  console.log(JSON.stringify({ pagina: `http://127.0.0.1:${server.address().port}/`, evidencias: path.join(dir, 'evidencias.json') }));
  const encerrar = () => {
    store.revoke(credential.id);
    let fechados = 0;
    const limpar = () => { if (++fechados === 2) fs.rmSync(dir, { recursive: true, force: true }); };
    server.close(limpar); server.closeAllConnections();
    servidorVideo.close(limpar); servidorVideo.closeAllConnections();
  };
  process.once('SIGTERM', encerrar);
  process.once('SIGINT', encerrar);
}

if (require.main === module) {
  const video = process.argv[2];
  if (!video) { console.error('Uso: node scripts/stremio-player-smoke.js /caminho/video-sintetico.mp4'); process.exitCode = 1; }
  else iniciar(path.resolve(video), process.argv[3]).catch(() => { console.error('Não foi possível preparar a sonda do player.'); process.exitCode = 1; });
}
