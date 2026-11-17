'use strict';

// Protocolo WebKit Inspector: não confundir com Chrome DevTools Protocol.
async function conectar(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let targetPath;
  while (Date.now() < deadline) {
    try {
      const html = await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })).text();
      const rows = html.match(/<tr>.*?<\/tr>/gs) ?? [];
      targetPath = rows.find((row) => row.includes('Stremio - Freedom to Stream'))?.match(/\/socket\/[\w/-]+/)?.[0];
      if (targetPath) break;
    } catch { /* aguarda apenas a instância isolada que o runner iniciou */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!targetPath) throw new Error('Interface oficial não apareceu no WebKit Inspector.');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${targetPath}`);
  const pendentes = new Map();
  let serial = 0;
  let target;
  const pronto = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebKit não anunciou o alvo da página.')), 5000);
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Falha na conexão WebKit.')); });
    ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.method === 'Target.targetCreated' && msg.params.targetInfo.type === 'page') {
        target = msg.params.targetInfo.targetId; clearTimeout(timer); resolve();
      }
      if (msg.method === 'Target.dispatchMessageFromTarget') {
        const inner = JSON.parse(msg.params.message);
        const pending = pendentes.get(inner.id);
        if (pending) {
          clearTimeout(pending.timer); pendentes.delete(inner.id);
          if (inner.error || inner.result?.wasThrown) pending.reject(new Error('Comando da interface falhou.'));
          else pending.resolve(inner.result?.result?.value);
        }
      }
    });
  });
  try { await pronto; } catch (error) { ws.close(); throw error; }
  return {
    evaluate(expression) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { pendentes.delete(id); reject(new Error('Timeout lendo a interface.')); }, 5000);
        pendentes.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method: 'Target.sendMessageToTarget', params: { targetId: target,
          message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }) } }));
      });
    },
    close() { ws.close(); for (const pending of pendentes.values()) { clearTimeout(pending.timer); pending.reject(new Error('Inspector encerrado.')); } },
  };
}

module.exports = { conectar };
