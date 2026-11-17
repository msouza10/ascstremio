const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { preparar } = require('../../../scripts/stremio-linux-session');
const { conectar } = require('../../../scripts/stremio-webkit');
const { iniciarFixture } = require('../../../scripts/stremio-ui-fixture');

async function aguardar(ui, expression, mensagem, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await ui.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(mensagem);
}

const texto = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const clicar = (text) => `(() => {
  const candidates = [...document.querySelectorAll('div,button,a')]
    .filter((el) => el.textContent.trim() === ${JSON.stringify(text)} && el.getBoundingClientRect().width > 0)
    .sort((a,b) => a.querySelectorAll('*').length-b.querySelectorAll('*').length);
  if (!candidates.length) throw Error('Controle não encontrado');
  candidates[0].click(); return true;
})()`;

test('Stremio instalado: LAN, catálogo e fonte na interface oficial sem conta', { timeout: 90000 }, async (t) => {
  const session = await preparar();
  let fixture;
  let ui;
  t.after(async () => { try { ui?.close(); await fixture?.close(); } finally { await session.close(); } });
  fixture = await iniciarFixture({ video: session.video, dir: session.dir });
  ui = await conectar(await session.abrir());
  t.diagnostic(`Stremio Flatpak commit ${session.commit}; perfil temporário; cenário LAN no próprio host.`);

  await t.test('TEST-STREMIO-010: instala pelo endereço LAN calculado em produção', async () => {
    assert.notEqual(fixture.plano.host, '127.0.0.1');
    assert.equal(fixture.plano.bind, '0.0.0.0');
    assert.equal(new URL(fixture.manifestUrl).hostname === fixture.plano.host, true, 'manifesto deve anunciar o IP LAN escolhido');
    await ui.evaluate(`location.hash='/addons';true`);
    await aguardar(ui, texto('Add addon'), 'Tela de addons não carregou.');
    await ui.evaluate(clicar('Add addon'));
    await aguardar(ui, `!!document.querySelector('input[placeholder="Paste addon URL"]')`, 'Campo de URL ausente.');
    await ui.evaluate(`(() => {
      const el=document.querySelector('input[placeholder="Paste addon URL"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(fixture.manifestUrl)});
      el.dispatchEvent(new Event('input',{bubbles:true})); return true;
    })()`);
    await ui.evaluate(clicar('Add'));
    await aguardar(ui, texto('Supported types:'), 'Manifesto não foi aceito pelo Stremio.');
    await ui.evaluate(clicar('Install'));
    await aguardar(ui, `!document.body.innerText.includes('Supported types:')`, 'Instalação não concluiu.');
    assert.ok(fixture.calls.recursos.includes('/manifest.json'));
    assert.equal(fixture.calls.downloads, 0);
  });

  await t.test('TEST-STREMIO-011: títulos gerados pelo provedor aparecem no catálogo', async () => {
    await ui.evaluate(`location.hash='/';true`);
    await aguardar(ui, texto(fixture.TITULO), 'Título Aurora não apareceu no catálogo.');
    assert.equal(await ui.evaluate(texto(fixture.OUTRO)), true);
    const expected = await ui.evaluate(`JSON.stringify([...document.querySelectorAll('a')]
      .filter(el=>el.textContent.startsWith('ASC Teste ')).map(el=>({nome:el.textContent,rota:el.getAttribute('href')})))`);
    const links = JSON.parse(expected);
    assert.deepEqual(links.map((link) => link.nome).sort(), [fixture.TITULO, fixture.OUTRO].sort());
    assert.ok(links.every((link) => link.rota.startsWith('#/detail/movie/ascfilm')));
    assert.ok(fixture.calls.recursos.some((route) => route.includes('/catalog/movie/asc-online')));
    assert.equal(fixture.calls.downloads, 0, 'listar não pode baixar torrent');
  });

  await t.test('TEST-STREMIO-012: informação exibida, URL LAN e vídeo selecionado são reais', async () => {
    await ui.evaluate(clicar(fixture.TITULO));
    await aguardar(ui, `!!document.querySelector('a[href^="#/player/"]')`, 'Fonte não apareceu.');
    for (const expected of ['🆓', '1080p', 'WEB-DL', '18 seeders', '5,6 GB']) {
      assert.equal(await ui.evaluate(texto(expected)), true, `Campo ausente: ${expected}`);
    }
    const encoded = await ui.evaluate(`document.querySelector('a[href^="#/player/"]').getAttribute('href').split('/')[2]`);
    const stream = JSON.parse(zlib.inflateSync(Buffer.from(decodeURIComponent(encoded), 'base64')));
    assert.equal(new URL(stream.url).host === new URL(fixture.plano.urls.bridge).host, true, 'fonte deve usar endereço calculado');
    assert.equal(new URL(stream.url).hostname === fixture.plano.host, true, 'fonte LAN não pode anunciar loopback');
    assert.equal(new URL(stream.url).pathname, '/a/1');
    assert.equal(new URL(stream.url).searchParams.has('k'), true);
    assert.equal(stream.behaviorHints.filename, 'aurora.mp4');
    assert.equal(stream.infoHash, undefined, 'torrent não pode ser delegado ao cliente');
    // Só observação da IPC; abrir o vídeo continua sendo ação na UI oficial.
    await ui.evaluate(`(() => {
      window.__ascTeste = {};
      window.ipc.addEventListener('message', ({data}) => {
        const msg=JSON.parse(data), args=msg.args;
        if(args?.[0]==='mpv-prop-change' && ['time-pos','video-params'].includes(args[1].name))
          window.__ascTeste[args[1].name]=args[1].data;
      });
      for(const prop of ['time-pos','video-params']) window.ipc.postMessage(JSON.stringify({type:6,args:['mpv-observe-prop',prop]}));
      document.querySelector('a[href^="#/player/"]').click(); return true;
    })()`);
    await aguardar(ui, `window.__ascTeste?.['time-pos']>2 && window.__ascTeste?.['video-params']?.w===640`, 'Player não confirmou vídeo e avanço.', 20000);
    assert.ok(fixture.calls.video.some((req) => req.status === 206 && req.hostCorreto));
    assert.equal(fixture.calls.downloads, 0);
    t.diagnostic('UI oficial → fonte do provedor → ponte LAN → vídeo 640 px e posição > 2 s.');
  });
});
