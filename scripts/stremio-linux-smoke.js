#!/usr/bin/env node
// Executa o player REAL do Flatpak em perfil descartável, sem conta ASC/Stremio.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createInterface } = require('node:readline');

const APP = 'com.stremio.Stremio';

async function main() {
  if (process.platform !== 'linux') throw new Error('Esta sonda exige Linux com Stremio Flatpak e sessão gráfica.');
  const ativos = execFileSync('flatpak', ['ps', '--columns=application'], { encoding: 'utf8' });
  if (ativos.split('\n').some((line) => line.trim() === APP)) {
    throw new Error('Feche o Stremio antes da sonda: não é seguro reutilizar a instância ou encerrar sua sessão.');
  }
  const version = execFileSync('flatpak', ['info', '--show-commit', APP], { encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ascstremio-linux-smoke-'));
  let fixture;
  let app;
  let instance = '';
  let interrupted = false;
  const interromper = () => { interrupted = true; fixture?.kill('SIGTERM'); };
  process.on('SIGINT', interromper);
  process.on('SIGTERM', interromper);
  try {
    for (const sub of ['home','data','config','cache']) fs.mkdirSync(path.join(dir,sub));
    const video = path.join(dir,'video.mp4');
    execFileSync('flatpak', ['run', `--filesystem=${dir}`, '--command=ffmpeg', APP,
      '-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24',
      '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','60',
      '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',
      '-movflags','+faststart','-y',video], { timeout: 30000, stdio: 'ignore' });
    if (interrupted) throw new Error('Sonda interrompida.');
    fixture = spawn(process.execPath, [path.join(__dirname,'stremio-player-smoke.js'),video,dir], { stdio: ['ignore','pipe','ignore'] });
    const ready = await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('A fixture não iniciou em 10 segundos.')),10000);
      fixture.once('error', (error) => { clearTimeout(timer); reject(error); });
      fixture.once('exit', () => { clearTimeout(timer); reject(new Error('A fixture encerrou antes de iniciar.')); });
      const lines = createInterface({ input: fixture.stdout });
      lines.on('line', (line) => {
        try {
          const data = JSON.parse(line);
          if (data.pagina && data.evidencias) { clearTimeout(timer); resolve(data); }
        } catch { /* logs do produto não são evidência do player */ }
      });
    });
    // Flatpak reescreve XDG_* passados com --env: env dentro do sandbox é necessário.
    app = spawn('flatpak', ['run', '--instance-id-fd=3', `--filesystem=${dir}`, '--command=env', APP,
      `HOME=${path.join(dir,'home')}`, `XDG_DATA_HOME=${path.join(dir,'data')}`,
      `XDG_CONFIG_HOME=${path.join(dir,'config')}`, `XDG_CACHE_HOME=${path.join(dir,'cache')}`,
      'GSETTINGS_BACKEND=memory','/app/bin/stremio','--url',ready.pagina], { stdio: ['ignore','ignore','ignore','pipe'] });
    app.stdio[3].on('data', (data) => { instance += data.toString(); });
    let launchError;
    app.once('error', (error) => { launchError = error; });
    const deadline = Date.now()+45000;
    while (Date.now()<deadline) {
      if (interrupted) throw new Error('Sonda interrompida.');
      if (launchError) throw launchError;
      if (app.exitCode !== null) throw new Error('O Stremio encerrou antes da conclusão da sonda.');
      if (fs.existsSync(ready.evidencias)) {
        const evidence = JSON.parse(fs.readFileSync(ready.evidencias,'utf8'));
        if (evidence.erros.length) throw new Error('O player informou falha; a execução não foi aprovada.');
        const etapas = evidence.etapas.map((item) => item.etapa);
        if (['addon','reprodução','pausa','retomada','seek'].every((etapa) => etapas.includes(etapa))) {
          if (!evidence.pedidosVideo.some((req) => req.status === 206)) throw new Error('Sem evidência de consumo Range na ponte.');
          console.log(JSON.stringify({ resultado: 'aprovado', plataforma: 'linux-flatpak', commitStremio: version,
            limite: 'Player nativo com página de controle; não valida navegação na interface normal nem instalação do addon.', ...evidence },null,2));
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve,250));
    }
    throw new Error('O player não confirmou todas as etapas em 45 segundos.');
  } finally {
    // A instância vem do próprio processo iniciado: nunca usar flatpak kill pelo app ID.
    if (instance.trim()) {
      try { execFileSync('flatpak',['kill',instance.trim()],{ stdio:'ignore',timeout:5000 }); } catch { /* já encerrou */ }
    }
    if (app && !instance.trim()) app.kill('SIGTERM');
    if (app && app.exitCode === null && app.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve,5000);
        app.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (fixture) {
      const exit = fixture.exitCode === null ? new Promise((resolve) => fixture.once('exit',resolve)) : Promise.resolve();
      fixture.kill('SIGTERM');
      const timer = setTimeout(() => fixture.kill('SIGKILL'),3000);
      await exit;
      clearTimeout(timer);
    }
    fs.rmSync(dir,{ recursive:true, force:true });
    process.off('SIGINT', interromper);
    process.off('SIGTERM', interromper);
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
