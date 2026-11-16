#!/usr/bin/env node
'use strict';

// Usa o Chrome instalado e o protocolo DevTools; não adiciona dependência ao addon.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function main() {
  for (const porta of [18020, 18022]) {
    const status = await (await fetch(`http://127.0.0.1:${porta}/api/status`)).json();
    if (status.demoCapturas !== true || status.username !== 'demo-user') {
      throw new Error('Captura recusada: inicie scripts/demo-capturas.js com dados fictícios.');
    }
  }
  const destino = path.resolve(process.argv[2] || 'dist/capturas');
  fs.mkdirSync(destino, { recursive: true });
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-chrome-demo-'));
  const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${perfil}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let saida = '';
      const limite = setTimeout(() => reject(new Error('Chrome não iniciou em 15 segundos.')), 15000);
      chrome.once('error', error => { clearTimeout(limite); reject(error); });
      chrome.once('exit', () => { clearTimeout(limite); reject(new Error('Chrome encerrou antes da captura.')); });
      chrome.stderr.on('data', chunk => {
        saida += chunk;
        const match = saida.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(limite); resolve(match[1]); }
      });
    });
    const origem = new URL(endpoint);
    const paginas = await (await fetch(`http://${origem.host}/json/list`)).json();
    socket = new WebSocket(paginas.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let numero = 0;
    const pendentes = new Map();
    socket.addEventListener('message', event => {
      const mensagem = JSON.parse(event.data);
      const pedido = pendentes.get(mensagem.id);
      if (!pedido) return;
      pendentes.delete(mensagem.id);
      clearTimeout(pedido.limite);
      if (mensagem.error) pedido.reject(new Error(mensagem.error.message));
      else pedido.resolve(mensagem.result);
    });
    const enviar = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++numero;
      const limite = setTimeout(() => { pendentes.delete(id); reject(new Error(`Tempo excedido: ${method}`)); }, 15000);
      pendentes.set(id, { resolve, reject, limite });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await enviar('Page.enable');
    await enviar('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1120, deviceScaleFactor: 0.8, mobile: false });
    await enviar('Page.navigate', { url: 'http://127.0.0.1:18020' });
    const esperar = async expression => {
      const inicio = Date.now();
      while (Date.now() - inicio < 15000) {
        const resposta = await enviar('Runtime.evaluate', { expression, returnByValue: true });
        if (resposta.result.value) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const atual = await enviar('Runtime.evaluate', { expression: 'document.body?.textContent', returnByValue: true });
      throw new Error(`O painel de demonstração não ficou pronto: ${atual.result.value}`);
    };
    await esperar('document.body?.textContent.includes("Projeto Aurora")');
    const cenas = [
      { nome: 'painel', rota: '/', pronto: 'Projeto Aurora' },
      { nome: 'logs', rota: '/logs', pronto: 'Somente demonstração: nenhum torrent' },
      { nome: 'torrent', rota: `/filmes/${'a'.repeat(40)}`, pronto: 'Última conferência' },
      { nome: 'wizard-uso', rota: '/assistente', pronto: 'Como você vai usar', passo: 'modo' },
      { nome: 'wizard-seed', rota: '/assistente', pronto: 'Seed, disco e filtro de releases', passo: 'seed' },
      { nome: 'wizard-instalar', rota: '/assistente', pronto: 'Criar credencial', passo: 'instalar' },
      { nome: 'login', rota: '/entrar', porta: 18022, pronto: 'Conectar ao Amigos Share' },
    ];
    const erros = [];
    socket.addEventListener('message', event => {
      const mensagem = JSON.parse(event.data);
      if (mensagem.method === 'Runtime.exceptionThrown') erros.push(mensagem.params.exceptionDetails.text);
    });
    await enviar('Runtime.enable');
    for (const cena of cenas) {
      const url = `http://127.0.0.1:${cena.porta || 18020}${cena.rota}`;
      // Inicializa storage na origem certa, incluindo a página de login separada.
      await enviar('Page.navigate', { url });
      await esperar(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`);
      for (const tema of ['dark', 'light']) {
        await enviar('Runtime.evaluate', { expression: `localStorage.setItem('monitor.theme', '${tema}'); sessionStorage.setItem('ascstremio.wizard', JSON.stringify({step: ${JSON.stringify(cena.passo || 'modo')}, drafts: {}})); location.reload();` });
        await esperar(`document.body?.textContent.includes(${JSON.stringify(cena.pronto)}) && document.documentElement.classList.contains('dark') === ${tema === 'dark'}`);
        await enviar('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))', awaitPromise: true });
        const layout = await enviar('Page.getLayoutMetrics');
        const captura = await enviar('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 1600, height: Math.max(1120, layout.cssContentSize.height), scale: 1 } });
        const arquivo = path.join(destino, `${cena.nome}-${tema === 'dark' ? 'escuro' : 'claro'}.png`);
        fs.writeFileSync(arquivo, Buffer.from(captura.data, 'base64'));
        console.log(`Captura salva: ${arquivo}`);
      }
    }
    if (erros.length) throw new Error(`Exceções no navegador: ${erros.join('; ')}`);
  } finally {
    socket?.close();
    if (chrome.exitCode === null) {
      const encerrou = new Promise(resolve => chrome.once('exit', resolve));
      chrome.kill();
      await encerrou;
    }
    // Processos auxiliares do Chrome podem terminar a última gravação após o processo principal.
    fs.rmSync(perfil, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
