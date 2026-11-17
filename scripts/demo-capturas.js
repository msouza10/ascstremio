#!/usr/bin/env node
'use strict';

// Demonstração isolada: não instancia cliente ASC, ponte ou motor de torrents.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startConfig } = require('../src/config-server');
const { Logger } = require('../src/logger');
const settings = require('../src/settings');
const { createPanelSettings } = require('../src/panel-settings');

function snapshot() {
  const gib = 1024 ** 3;
  const agora = Date.now();
  const titulo = (letra, name, extra = {}) => ({
    infoHash: letra.repeat(40), name, state: 'seeding', risk: 'ok',
    seededHours: 48, requiredHours: 72, progress: 1, daysLeft: 10,
    freeleech: true, warnings: [], size: 2 * gib,
    diskBytes: 2 * gib, peers: 4, active: true, uploaded: gib,
    downloaded: 2 * gib, upSpeed: 256 * 1024, downSpeed: 0,
    ratio: 0.5, onDisk: 'full', seedChoice: 'auto',
    completedAt: new Date(agora - 2 * 86400000).toISOString(),
    deadline: new Date(agora + 10 * 86400000).toISOString(), hoursPerDayNeeded: 2.4,
    tracker: { satisfied: false, remainingHours: 24, hitAndRun: false, checkedAt: new Date(agora - 60000).toISOString() }, ...extra,
  });
  return {
    generatedAt: new Date(agora).toISOString(),
    summary: { total: 4, pending: 2, hoursPending: 42, machineHoursPerDay: 3,
      atRisk: 0, critical: 0, done: 1, active: 3, peers: 12,
      upSpeed: 768 * 1024, downSpeed: 3 * 1024 ** 2,
      diskUsed: 8 * gib, freeBytes: 120 * gib, diskReclaimable: 0 },
    stats: { ratio: 2.4, uploaded: 240 * gib, downloaded: 100 * gib, seeding: 2, leeching: 1 },
    account: { hitAndRuns: 0, pendingSeeds: 2, prisonUntil: null, exempt: false, cleared: 1 },
    settings: { requiredHours: 72, backgroundMode: 'always', afterSeed: 'keep', keepAwake: true },
    notices: [],
    titles: [
      titulo('a', 'Projeto Aurora — demonstração'),
      titulo('b', 'Viagem às Estrelas de Papel — demonstração', { seededHours: 54, tracker: { satisfied: false, remainingHours: 18, hitAndRun: false, checkedAt: new Date(agora - 60000).toISOString() } }),
      titulo('c', 'Jardim de Nuvens — demonstração', { state: 'completing', progress: 0.64, downSpeed: 3 * 1024 ** 2, completedAt: null, tracker: null, onDisk: 'partial' }),
      titulo('d', 'Horizonte de Tinta — demonstração', { state: 'done', seededHours: 72, active: false, tracker: { satisfied: true, remainingHours: 0, hitAndRun: false, checkedAt: new Date(agora - 60000).toISOString() } }),
    ],
    traffic: Array.from({ length: 60 }, (_, i) => ({
      t: agora - (59 - i) * 60000, down: (2 + Math.sin(i / 6)) * 1024 ** 2,
      up: (600 + 150 * Math.cos(i / 8)) * 1024,
    })),
  };
}

function createDemoPanel(dataDir) {
  // O esquema e o assistente são reais; nenhuma variável da instalação pessoal é herdada.
  const bootEnv = { DATA_DIR: dataDir, PORT: '18000', BRIDGE_PORT: '18010', CONFIG_PORT: '18020' };
  const interfaces = {};
  const running = settings.load({ dataDir, env: bootEnv, interfaces }).values;
  const real = createPanelSettings({ dataDir, bootEnv, running, interfaces, addonBase: 'http://127.0.0.1:18000' });
  return { state: () => ({ ...real.state(), hostname: 'computador-demo' }) };
}

function seedDemoLogs(logs) {
  const eventos = [
    ['info', 'app', 'Demonstração iniciada com dados fictícios.'],
    ['info', 'config', 'Painel de demonstração disponível somente neste computador.'],
    ['info', 'asc', 'Sessão fictícia confirmada; nenhuma conexão ao tracker.'],
    ['info', 'bridge', 'Biblioteca de demonstração: 4 títulos sintéticos.'],
    ['info', 'hnr', 'Conciliação simulada: 2 seeds pendentes e nenhum hit-and-run.'],
    ['info', 'bridge', 'Projeto Aurora — demonstração: seed em andamento (simulado).'],
    ['warn', 'disk', 'Exemplo de aviso: reserva de espaço de demonstração em revisão.'],
    ['info', 'disk', 'Verificação simulada concluída: espaço suficiente para novos downloads.'],
    ['info', 'bridge', 'Jardim de Nuvens — demonstração: download simulado em 64%.'],
    ['info', 'seed', 'Horizonte de Tinta — demonstração: seed cumprido no cenário fictício.'],
    ['info', 'app', 'Somente demonstração: nenhum torrent foi aberto ou anunciado.'],
  ];
  const inicio = Date.now() - eventos.length * 30000;
  for (const [i, [nivel, fonte, mensagem]] of eventos.entries()) {
    logs.now = () => inicio + i * 30000;
    logs.write(nivel, fonte, mensagem);
  }
  logs.now = () => Date.now();
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-capturas-'));
  const logs = new Logger({ dir: path.join(dataDir, 'logs') });
  const status = { demoCapturas: true, connected: true, saved: false, username: 'demo-user', lastLoginAt: new Date().toISOString() };
  const asc = { connected: true, status: () => ({ ...status }) };
  const panel = createDemoPanel(dataDir);
  seedDemoLogs(logs);
  const server = await startConfig(asc, 18020, { snapshot }, logs, panel);
  const login = { connected: false, status: () => ({ ...status, connected: false, lastLoginAt: null }) };
  const loginServer = await startConfig(login, 18022, null, new Logger());
  console.log('Demonstração com dados fictícios: http://127.0.0.1:18020');
  console.log('Login com sessão fictícia desconectada: http://127.0.0.1:18022/entrar');
  const fechar = () => loginServer.close(() => server.close(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  }));
  process.once('SIGINT', fechar);
  process.once('SIGTERM', fechar);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { snapshot, createDemoPanel, seedDemoLogs };
