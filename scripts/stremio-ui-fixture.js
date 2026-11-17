'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const network = require('../src/network');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { CredentialStore } = require('../src/credentials');
const { createAscProvider } = require('../src/asc-provider');
const { createAddon } = require('../src/addon');
const { createAddonServer } = require('../src/addon-server');

const TITULO = 'ASC Teste Aurora 1080p';
const OUTRO = 'ASC Teste Boreal 720p';
const HASH = 'b'.repeat(40);

const listen = (server, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, host, resolve);
});

async function iniciarFixture({ video, dir, mode = 'lan' }) {
  const plan = (ports) => network.evaluate({ mode, ports, strict: true });
  let plano = plan({ addon: 0, bridge: 0 });
  if (plano.problems.length || !plano.host) throw new Error('Sem endereço elegível para a integração LAN.');
  const store = new CredentialStore({ file: path.join(dir, 'credentials.json') });
  const { token, credential } = store.create({ name: 'Stremio convidado' });
  const calls = { buscas: [], downloads: 0, aberturas: 0, recursos: [], video: [] };
  const bridge = new Bridge({ torrentDir: dir, storeDir: dir, credentials: store,
    strictHost: true, vault: new SeedVault({ file: path.join(dir, 'cofre.json') }) });
  const length = fs.statSync(video).size;
  const file = { index: 0, path: 'aurora.mp4', length, isVideo: true };
  bridge.entries.set(HASH, { infoHash: HASH, torrentPath: path.join(dir, 'asc-1.torrent'), files: [file] });
  bridge.getTorrent = async () => {
    calls.aberturas++;
    return { ready: true, numPeers: 0,
      files: [{ ...file, createReadStream: (range) => fs.createReadStream(video, range) }] };
  };
  const rows = [
    { id: 1, name: TITULO, size: 5.6 * 1024 ** 3, seeders: 18, freeleech: true, badges: [{ label: '1080p', kind: 'resolution' }, { label: 'WEB-DL', kind: 'source' }] },
    { id: 2, name: OUTRO, size: 4096, seeders: 7, freeleech: false, badges: [{ label: '720p', kind: 'resolution' }] },
  ];
  const asc = {
    connected: true, onlyFreeleech: false,
    async search(query) {
      calls.buscas.push(query);
      return rows.filter((row) => !query || row.name.toLowerCase().includes(query.toLowerCase()));
    },
    async download() { calls.downloads++; throw new Error('Download externo proibido na fixture.'); },
  };
  const remote = createAscProvider(asc, bridge, dir);
  const addon = createAddon({ remote });
  const addonServer = createAddonServer({ addon, credentials: store, activity: {
    record(id, route) { calls.recursos.push(route); },
  } });
  const videoServer = http.createServer((req, res) => {
    res.once('close', () => calls.video.push({ metodo: req.method, status: res.statusCode,
      range: req.headers.range ?? null, hostCorreto: req.headers.host === new URL(plano.urls.bridge).host }));
    bridge.handle(req, res).catch(() => res.destroy());
  });
  try {
    await listen(videoServer, plano.bind);
    await listen(addonServer, plano.bind);
  } catch (error) {
    videoServer.close(); addonServer.close(); throw error;
  }
  plano = plan({ addon: addonServer.address().port, bridge: videoServer.address().port });
  bridge.publicUrl = plano.urls.bridge;
  const close = async () => {
    store.revoke(credential.id);
    await Promise.all([addonServer, videoServer].map((server) => new Promise((resolve) => {
      server.close(resolve); server.closeAllConnections();
    })));
  };
  return { manifestUrl: `${plano.urls.addon}/${token}/manifest.json`, plano, calls, close, TITULO, OUTRO,
    bindings: { addon: addonServer.address().address, bridge: videoServer.address().address },
    revogar: () => store.revoke(credential.id) };
}

module.exports = { iniciarFixture, TITULO, OUTRO };
