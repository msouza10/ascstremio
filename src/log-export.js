// Exportações usam uma fotografia: o navegador baixa exatamente o texto revisado.
const fs = require('node:fs');
const { Logger, LEVEL_NAMES } = require('./logger');
const LIMIT = 32 * 1024 * 1024;
const SOURCES = new Set(['app', 'ponte', 'torrent', 'asc', 'addon', 'config', 'admin-painel', 'credenciais', 'hnr', 'alertas', 'meta-cache', 'retencao', 'vault']);
class LogExportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function buildLogExport(logs, params, { defaultMode = 'suporte', file = false } = {}) {
  const mode = params.get('modo') || defaultMode;
  const format = params.get('formato') || (file || params.has('nome') ? 'ndjson' : 'txt');
  if (!['suporte', 'completo'].includes(mode) || !['txt', 'ndjson'].includes(format)) throw new LogExportError(400, 'Modo ou formato de exportação inválido.');
  let entries; let skippedLines = 0;
  const daily = file || params.has('nome');
  if (daily) {
    const full = logs.filePath(params.get('nome'));
    if (!full) throw new LogExportError(404, 'Arquivo de log inexistente.');
    if (fs.statSync(full).size > LIMIT) throw new LogExportError(413, 'Arquivo grande demais para revisão no painel.');
    const raw = fs.readFileSync(full, 'utf8');
    if (Buffer.byteLength(raw) > LIMIT) throw new LogExportError(413, 'Arquivo grande demais para revisão no painel.');
    entries = [];
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        if (!e || !Number.isFinite(e.t) || !LEVEL_NAMES.includes(e.level) || typeof e.msg !== 'string' || typeof e.src !== 'string') throw new Error('registro inválido');
        entries.push(e);
      } catch { skippedLines++; }
    }
  } else entries = logs.query(Logger.parseFilter(params), { limit: 20_000 }).entries;
  const first = entries[0]?.t || 0;
  const clean = entries.map((e) => mode === 'suporte'
    ? { decorridoMs: Math.max(0, e.t - first), level: e.level, src: SOURCES.has(e.src) ? e.src : 'outros' }
    : logs.redactData(e));
  const content = clean.map((e) => format === 'ndjson' ? JSON.stringify(e)
    : mode === 'suporte' ? `+${e.decorridoMs}ms ${e.level.toUpperCase()} [${e.src}]` : logs.format(e)).join('\n') + (clean.length ? '\n' : '');
  if (Buffer.byteLength(content) > LIMIT) throw new LogExportError(413, 'Exportação grande demais para revisão no painel.');
  return { mode, content, count: clean.length, skippedLines, retentionDays: logs.retentionDays,
    filename: `asc-logs-${mode}.${format}`, contentType: format === 'ndjson' ? 'application/x-ndjson; charset=utf-8' : 'text/plain; charset=utf-8',
    scope: daily ? 'Arquivo diário inteiro; filtros da tela não se aplicam.' : 'Registros em memória que correspondem aos filtros (até 20 mil).',
    notice: 'O modo de suporte omite mensagens, dados e horários absolutos; não garante anonimização. O modo completo pode conter títulos, caminhos e identificadores. Revise antes de compartilhar. A redação automática reconhece somente segredos conhecidos e padrões previstos.' };
}
module.exports = { buildLogExport, LogExportError };
