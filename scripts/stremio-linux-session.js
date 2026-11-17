'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

async function preparar() {
  if (process.platform !== 'linux') throw new Error('Integração exige Linux com sessão gráfica e Stremio Flatpak.');
  const apps = execFileSync('flatpak', ['ps', '--columns=application'], { encoding: 'utf8' });
  if (apps.split('\n').some((app) => app.trim() === 'com.stremio.Stremio')) throw new Error('Feche o Stremio antes do teste: sessão pessoal não será reutilizada.');
  const commit = execFileSync('flatpak', ['info', '--show-commit', 'com.stremio.Stremio'], { encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ascstremio-ui-'));
  const video = path.join(dir, 'video.mp4');
  let app;
  let instancia = '';
  let fechando;
  const close = () => {
    fechando ??= (async () => {
      if (instancia.trim()) {
        try { execFileSync('flatpak', ['kill', instancia.trim()], { stdio: 'ignore', timeout: 5000 }); } catch { /* já terminou */ }
      } else app?.kill('SIGTERM');
      if (app && app.exitCode === null && app.signalCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 5000);
          app.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
      fs.rmSync(dir, { recursive: true, force: true });
      process.off('SIGINT', interromper); process.off('SIGTERM', interromper);
    })();
    return fechando;
  };
  const interromper = () => { close().finally(() => process.exit(1)); };
  process.once('SIGINT', interromper); process.once('SIGTERM', interromper);
  try {
    for (const sub of ['home', 'data', 'cache', 'config']) fs.mkdirSync(path.join(dir, sub));
    execFileSync('flatpak', ['run', `--filesystem=${dir}`, '--command=ffmpeg', 'com.stremio.Stremio',
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
      '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', video],
    { stdio: 'ignore', timeout: 30000 });
    return { dir, video, commit, close,
      async abrir() {
        // Porta aleatória de inspeção, acessível somente por loopback nesta execução.
        const reserva = net.createServer();
        await new Promise((resolve, reject) => { reserva.once('error', reject); reserva.listen(0, '127.0.0.1', resolve); });
        const port = reserva.address().port;
        await new Promise((resolve) => reserva.close(resolve));
        app = spawn('flatpak', ['run', '--instance-id-fd=3', `--filesystem=${dir}`, '--command=env', 'com.stremio.Stremio',
          `HOME=${path.join(dir, 'home')}`, `XDG_DATA_HOME=${path.join(dir, 'data')}`,
          `XDG_CONFIG_HOME=${path.join(dir, 'config')}`, `XDG_CACHE_HOME=${path.join(dir, 'cache')}`,
          'GSETTINGS_BACKEND=memory', `WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:${port}`, '/app/bin/stremio'],
        { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Flatpak não informou a instância criada.')), 5000);
          app.once('error', () => { clearTimeout(timer); reject(new Error('Falha ao abrir o Flatpak.')); });
          app.stdio[3].on('data', (data) => { instancia += data.toString(); if (instancia.trim()) { clearTimeout(timer); resolve(); } });
        });
        return port;
      },
    };
  } catch (error) { await close(); throw error; }
}

module.exports = { preparar };
