#!/usr/bin/env node
// Configuração pelo terminal (issue #20): consultar, alterar, validar e recuperar a
// configuração, no host ou por SSH. Não é um terminal servido no navegador.
//
//   npm run configurar                              (em terminal interativo: modo guiado)
//   npm run configurar -- listar [--json] [--detalhes]
//   npm run configurar -- obter CHAVE [--json]
//   npm run configurar -- definir CHAVE=VALOR [CHAVE=VALOR...] [--revisao N] [--json]
//   npm run configurar -- remover CHAVE [CHAVE...] [--revisao N] [--json]
//   npm run configurar -- modo [local|lan]
//   npm run configurar -- validar [--json]
//   npm run configurar -- diagnosticar [--json]
//   npm run configurar -- recuperar [--sim]
//
// Códigos de saída: 0 ok; 1 recusado/inválido; 2 uso incorreto ou sem terminal; 3 aplicativo
// em execução (a escrita exige a trava da instância); 4 conflito de revisão.
//
// Segredos nunca entram por argumento nem aparecem na saída (a passkey e afins existem só no
// ambiente). Sem terminal, nada espera entrada: ou o comando é completo, ou falha com o uso.
// Lógica em src/config-admin.js; aqui ficam só texto, JSON e o menu.

const readline = require('readline');
const settings = require('./settings');
const admin = require('./config-admin');

const USO = `uso: configurar [comando]
  (sem comando, em terminal interativo)   modo guiado
  listar [--json] [--detalhes]            opções, valor efetivo, origem e se exige reinício
  obter CHAVE [--json]
  definir CHAVE=VALOR... [--revisao N] [--json]
  remover CHAVE... [--revisao N] [--json] volta ao valor do ambiente/padrão
  modo [local|lan]                        mostra ou troca o modo de uso
  validar [--json]                        confere ambiente + arquivo (sai com 1 se houver problema)
  diagnosticar [--json]                   estado da configuração, da instância e como consertar
  recuperar [--sim]                       isola um settings.json quebrado (renomeia; não apaga)
  guiado                                  menu interativo (exige terminal)
Altera só com o aplicativo parado. Segredos nunca vão por argumento.`;

const EXIT = { ok: 0, fail: 1, usage: 2, instance: 3, conflict: 4 };

function exitFor(err) {
  if (err instanceof admin.AdminError) return err.code === 'instance' ? EXIT.instance : EXIT.fail;
  if (err instanceof settings.SettingsError) return err.code === 'conflict' ? EXIT.conflict : EXIT.fail;
  return EXIT.fail;
}

function problemsOf(err) {
  if (err instanceof settings.SettingsError) return err.problems;
  return [err.message];
}

function codeOf(err) {
  return err.code || 'error';
}

function show(value, o) {
  if (o.secret) return o.defined ? '(definido)' : '(não definido)';
  if (value === null || value === undefined || value === '') return '(vazio)';
  return String(value);
}

function originText(o) {
  if (o.source === 'env') return o.viaServiceEnv ? 'ambiente (service.env)' : 'ambiente';
  return o.origin;
}

function restartText(o) {
  if (o.access === 'readonly' && o.source !== 'file') return 'só leitura';
  return o.restart ? 'exige reinício' : 'sem reinício';
}

// Forma estruturada para automação (sem segredos: view() já os omite).
function jsonOption(o) {
  return {
    key: o.key,
    group: o.group,
    type: o.type,
    value: o.secret ? null : o.value,
    defined: o.secret ? o.defined : undefined,
    default: o.default,
    fileValue: o.fileValue,
    source: o.source,
    viaServiceEnv: o.viaServiceEnv,
    overridden: o.overridden,
    secret: o.secret,
    access: o.access,
    restart: o.restart,
    risky: o.risky,
    editable: !o.locked,
    locked: o.locked,
    values: o.values,
    min: o.min,
    max: o.max,
    unit: o.unit,
  };
}

function statusJson(st) {
  return {
    dataDir: st.snapshot.dataDir,
    file: st.snapshot.file,
    fileExists: st.snapshot.fileExists,
    fileBroken: st.fileBroken,
    revision: st.snapshot.revision,
    serviceEnv: st.ctx.serviceEnv.exists ? st.ctx.serviceEnv.file : null,
    mode: st.snapshot.mode,
    ok: st.snapshot.ok,
    problems: st.snapshot.problems,
    warnings: st.snapshot.warnings,
    instance: st.instance,
  };
}

function printOption(out, o, detalhes) {
  const extra = o.overridden ? `; o arquivo tem ${show(o.fileValue, o)} mas o ambiente vence` : '';
  const un = o.unit && !o.secret ? ` ${o.unit}` : '';
  out(`  ${o.key} = ${show(o.value, o)}${o.value !== null && !o.secret && o.value !== '' ? un : ''}`);
  out(`      origem: ${originText(o)}${extra} · ${restartText(o)}${o.locked ? ` · ${o.locked}` : ''}`);
  if (detalhes) {
    out(`      ${o.description}`);
    if (o.values) out(`      valores: ${o.values.join(' | ')}`);
    if (o.min !== null || o.max !== null) out(`      faixa: ${o.min ?? '-∞'} a ${o.max ?? '∞'}`);
    if (!o.secret && o.default !== null) out(`      padrão: ${show(o.default, o)}`);
  }
}

function printStatusNotes(out, st) {
  for (const p of st.snapshot.problems) out(`PROBLEMA: ${p}`);
  for (const w of st.snapshot.warnings) out(`aviso: ${w}`);
}

function parseArgs(args) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json' || a === '--detalhes' || a === '--sim') flags[a.slice(2)] = true;
    else if (a === '--revisao') { flags.revisao = args[i + 1]; i += 1; } else if (a.startsWith('--revisao=')) flags.revisao = a.slice(10);
    else if (a.startsWith('--')) return { error: 'opção desconhecida (nunca passe segredos por argumento).' };
    else pos.push(a);
  }
  if ('revisao' in flags) {
    if (!/^\d+$/.test(String(flags.revisao ?? ''))) return { error: '--revisao exige um inteiro (a revisão lida em "listar --json").' };
    flags.revisao = Number(flags.revisao);
  }
  return { flags, pos };
}

// "CHAVE=VALOR" ... ou "CHAVE VALOR". Devolve { changes } ou { error }; nunca ecoa valores.
function parseAssignments(pos) {
  const changes = {};
  if (pos.length === 2 && !pos[0].includes('=')) {
    changes[pos[0]] = admin.typed(pos[0], pos[1]);
    return { changes };
  }
  for (const item of pos) {
    const i = item.indexOf('=');
    if (i <= 0) return { error: 'use CHAVE=VALOR (ou: definir CHAVE VALOR).' };
    const key = item.slice(0, i);
    const value = item.slice(i + 1);
    if (value.trim() === '') return { error: `${key.slice(0, 64)}: valor vazio; use "remover ${key.slice(0, 64)}" para voltar ao padrão.` };
    changes[key] = admin.typed(key, value);
  }
  return { changes };
}

function afterWrite(out, res, json) {
  const snap = res.snapshot;
  if (json) {
    out(JSON.stringify({
      ok: true,
      changed: res.changed,
      restart: res.restart,
      revision: snap.revision,
      warnings: snap.warnings,
    }));
    return;
  }
  if (res.changed.length === 0) out('Nada mudou: já era esse o valor do arquivo.');
  else out(`Gravado em ${snap.file} (revisão ${snap.revision}): ${res.changed.join(', ')}.`);
  for (const w of snap.warnings) out(`aviso: ${w}`);
  if (res.restart.length) out(`Exige reinício do aplicativo: ${res.restart.join(', ')}. Inicie o serviço para aplicar.`);
}

function fail(io, err, json) {
  const code = exitFor(err);
  if (json) io.out(JSON.stringify({ ok: false, code: codeOf(err), problems: problemsOf(err) }));
  else for (const p of problemsOf(err)) io.err(`erro: ${p}`);
  if (!json && err instanceof settings.SettingsError && ['corrupt', 'newer'].includes(err.code)) {
    io.err('Dica: "recuperar" isola o arquivo quebrado sem apagar nada.');
  }
  return code;
}

// ---------------------------------------------------------------------------
// Modo guiado. Lê linhas da entrada; EOF cancela sem gravar nada.

function lineReader(input) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const it = rl[Symbol.asyncIterator]();
  return {
    async ask(io, prompt) {
      io.write(prompt);
      const { value, done } = await it.next();
      if (done) return null;
      return String(value).trim();
    },
    close: () => rl.close(),
  };
}

async function guided(io, env) {
  const reader = lineReader(io.input);
  const ask = (p) => reader.ask(io, p);
  try {
    io.out('Configuração do ASCStremio (Enter volta; q sai).');
    for (;;) {
      const st = admin.inspect({ env });
      io.out('');
      io.out(`Pasta de dados: ${st.snapshot.dataDir}`);
      io.out(`Arquivo: ${st.snapshot.fileExists ? `${st.snapshot.file} (revisão ${st.snapshot.revision})` : 'não existe (valem ambiente e padrões)'}`);
      io.out(`Modo: ${st.snapshot.mode === 'lan' ? 'LAN (host pessoal na rede local)' : 'local (só este computador)'}`);
      if (st.instance.active) io.out('Aplicativo em execução: aqui só é possível consultar; para alterar, pare o serviço.');
      printStatusNotes(io.out, st);
      io.out('  1) Ver todas as opções');
      io.out('  2) Trocar modo local/LAN');
      io.out('  3) Alterar uma opção');
      io.out('  4) Remover uma opção do arquivo (voltar ao padrão)');
      io.out('  5) Diagnóstico');
      io.out('  6) Recuperar arquivo quebrado');
      io.out('  q) Sair');
      const choice = await ask('Escolha: ');
      if (choice === null || choice === 'q' || choice === 'Q') return EXIT.ok;
      if (choice === '1') {
        for (const o of st.options) printOption(io.out, o, true);
      } else if (choice === '2') {
        const alvo = await ask(`Novo modo (local/lan; atual ${st.snapshot.mode}): `);
        if (alvo === null) return EXIT.ok;
        if (alvo) await guidedWrite(io, env, st, { ASCSTREMIO_MODE: alvo });
      } else if (choice === '3') {
        const key = await pickOption(io, ask, st, (o) => !o.locked);
        if (key === null) return EXIT.ok;
        if (key) {
          const o = st.options.find((x) => x.key === key);
          printOption(io.out, o, true);
          const text = await ask('Novo valor (vazio cancela): ');
          if (text === null) return EXIT.ok;
          if (text) await guidedWrite(io, env, st, { [key]: admin.typed(key, text) });
        }
      } else if (choice === '4') {
        const key = await pickOption(io, ask, st, (o) => o.fileValue !== null);
        if (key === null) return EXIT.ok;
        if (key) await guidedWrite(io, env, st, { [key]: null });
      } else if (choice === '5') {
        printDiagnostic(io.out, st);
      } else if (choice === '6') {
        const r = await guidedRecover(io, ask, env);
        if (r === null) return EXIT.ok;
      }
    }
  } finally {
    reader.close();
  }
}

// Mostra as opções e lê a escolha por número ou nome. null = EOF; '' = cancelou.
async function pickOption(io, ask, st, filter) {
  const lista = st.options.filter(filter);
  if (lista.length === 0) { io.out('Nenhuma opção disponível para isso.'); return ''; }
  lista.forEach((o, i) => io.out(`  ${String(i + 1).padStart(2)}) ${o.key} = ${show(o.value, o)}  [${originText(o)}]`));
  const raw = await ask('Número ou nome da opção (vazio cancela): ');
  if (raw === null) return null;
  if (!raw) return '';
  const byNumber = /^\d+$/.test(raw) ? lista[Number(raw) - 1] : null;
  const found = byNumber || lista.find((o) => o.key === raw.toUpperCase());
  if (!found) { io.out('Opção não encontrada.'); return ''; }
  return found.key;
}

async function guidedWrite(io, env, st, changes) {
  try {
    const res = admin.change({ env, changes, expectedRevision: st.snapshot.revision });
    afterWrite(io.out, res, false);
  } catch (err) {
    for (const p of problemsOf(err)) io.out(`Recusado: ${p}`);
  }
}

async function guidedRecover(io, ask, env) {
  const st = admin.inspect({ env });
  if (!st.fileBroken && !st.snapshot.problems.some((p) => p.startsWith(`${settings.FILE_NAME}: `))) {
    io.out('O arquivo de configuração não tem problema.');
    return true;
  }
  io.out(`O arquivo ${st.snapshot.file} será renomeado (não apagado) e a configuração volta a ambiente + padrões.`);
  const r = await ask('Digite "sim" para confirmar: ');
  if (r === null) return null;
  if (r.toLowerCase() === 'sim') {
    try {
      const res = admin.recover({ env });
      io.out(`Arquivo isolado em ${res.backup}.`);
    } catch (err) { for (const p of problemsOf(err)) io.out(`Recusado: ${p}`); }
  }
  return true;
}

function printDiagnostic(out, st) {
  const s = st.snapshot;
  out(`Pasta de dados : ${s.dataDir}`);
  out(`Arquivo        : ${s.file} ${s.fileExists ? `(revisão ${s.revision})` : st.fileBroken ? '(EXISTE, mas está quebrado)' : '(não existe)'}`);
  out(`service.env    : ${st.ctx.serviceEnv.exists ? st.ctx.serviceEnv.file : 'não encontrado'}`);
  out(`Modo           : ${s.mode}`);
  if (st.instance.active) {
    out(`Aplicativo     : em execução (PID ${st.instance.pid}${st.instance.hostname ? ` em ${st.instance.hostname}` : ''})${st.instance.certain === false ? ' [outra máquina/contêiner: não verificável]' : ''}`);
  } else out(`Aplicativo     : parado${st.instance.stale ? ' (trava obsoleta; a próxima partida a recupera)' : ''}`);
  out(`Configuração   : ${s.ok ? 'válida' : 'COM PROBLEMAS'}`);
  printStatusNotes(out, st);
  if (!s.ok) {
    out('Como consertar:');
    const doEnv = s.problems.filter((p) => p.startsWith('Ambiente:') || p.startsWith('Contradição') || p.startsWith('Porta') || p.startsWith('Modo LAN'));
    if (st.fileBroken || s.problems.some((p) => p.startsWith(`${settings.FILE_NAME}: `))) out('  - arquivo: "recuperar" isola o settings.json quebrado (mantém cópia), ou corrija a opção com "definir"/"remover".');
    if (doEnv.length || s.problems.length) out('  - ambiente/combinação: edite o service.env (Linux), o Compose/docker.sh (contêiner) ou as variáveis do processo (Windows) e valide de novo.');
  }
}

// ---------------------------------------------------------------------------

async function run(argv, opts = {}) {
  const env = opts.env ?? process.env;
  const input = opts.input ?? process.stdin;
  const tty = opts.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const output = opts.output ?? process.stdout;
  const io = {
    out: opts.out ?? ((l) => process.stdout.write(`${l}\n`)),
    err: opts.err ?? ((l) => process.stderr.write(`${l}\n`)),
    write: (t) => output.write(t),
    input,
  };
  const [cmd, ...rest] = argv;
  const parsed = parseArgs(rest);
  if (parsed.error) { io.err(`erro: ${parsed.error}`); io.err(USO); return EXIT.usage; }
  const { flags, pos } = parsed;
  const json = Boolean(flags.json);

  if (!cmd) {
    if (!tty) { io.err('Sem terminal interativo: informe um comando.'); io.err(USO); return EXIT.usage; }
    return guided(io, env);
  }
  if (['ajuda', '--ajuda', '-h', '--help', 'help'].includes(cmd)) { io.out(USO); return EXIT.ok; }
  if (cmd === 'guiado') {
    if (!tty) { io.err('O modo guiado exige terminal interativo; use os comandos (listar, definir, ...).'); return EXIT.usage; }
    return guided(io, env);
  }

  try {
    if (cmd === 'listar' && pos.length === 0) {
      const st = admin.inspect({ env });
      if (json) {
        io.out(JSON.stringify({ ...statusJson(st), options: st.options.map(jsonOption) }));
      } else {
        io.out(`Pasta de dados: ${st.snapshot.dataDir}`);
        io.out(`Arquivo: ${st.snapshot.fileExists ? `${st.snapshot.file} (revisão ${st.snapshot.revision})` : 'não existe (valem ambiente e padrões)'}`);
        let grupo = null;
        for (const o of st.options) {
          if (o.group !== grupo) { grupo = o.group; io.out(''); io.out(`${o.groupLabel}:`); }
          printOption(io.out, o, Boolean(flags.detalhes));
        }
        io.out('');
        printStatusNotes(io.out, st);
      }
      return st.snapshot.ok ? EXIT.ok : EXIT.fail;
    }
    if (cmd === 'obter' && pos.length === 1) {
      const st = admin.inspect({ env });
      const o = st.options.find((x) => x.key === pos[0]);
      if (!o) { io.err(`erro: ${pos[0].slice(0, 64)}: opção desconhecida (veja "listar").`); return EXIT.fail; }
      if (json) io.out(JSON.stringify(jsonOption(o)));
      else printOption(io.out, o, true);
      return EXIT.ok;
    }
    if (cmd === 'definir' && pos.length >= 1) {
      const a = parseAssignments(pos);
      if (a.error) { io.err(`erro: ${a.error}`); return EXIT.usage; }
      const res = admin.change({ env, changes: a.changes, expectedRevision: flags.revisao });
      afterWrite(io.out, res, json);
      return EXIT.ok;
    }
    if (cmd === 'remover' && pos.length >= 1) {
      const changes = Object.fromEntries(pos.map((k) => [k, null]));
      const res = admin.change({ env, changes, expectedRevision: flags.revisao });
      afterWrite(io.out, res, json);
      return EXIT.ok;
    }
    if (cmd === 'modo' && pos.length <= 1) {
      if (pos.length === 0) {
        const st = admin.inspect({ env });
        io.out(`Modo: ${st.snapshot.mode} (origem: ${originText(st.options.find((o) => o.key === 'ASCSTREMIO_MODE'))})`);
        return EXIT.ok;
      }
      const res = admin.change({ env, changes: { ASCSTREMIO_MODE: pos[0] }, expectedRevision: flags.revisao });
      afterWrite(io.out, res, false);
      return EXIT.ok;
    }
    if (cmd === 'validar' && pos.length === 0) {
      const st = admin.inspect({ env });
      if (json) io.out(JSON.stringify({ ok: st.snapshot.ok, problems: st.snapshot.problems, warnings: st.snapshot.warnings }));
      else {
        io.out(st.snapshot.ok ? 'Configuração válida.' : 'Configuração com problemas:');
        printStatusNotes(io.out, st);
      }
      return st.snapshot.ok ? EXIT.ok : EXIT.fail;
    }
    if (cmd === 'diagnosticar' && pos.length === 0) {
      const st = admin.inspect({ env });
      if (json) io.out(JSON.stringify(statusJson(st)));
      else printDiagnostic(io.out, st);
      return st.snapshot.ok ? EXIT.ok : EXIT.fail;
    }
    if (cmd === 'recuperar' && pos.length === 0) {
      const st = admin.inspect({ env });
      if (!st.fileBroken && !st.snapshot.problems.some((p) => p.startsWith(`${settings.FILE_NAME}: `))) {
        io.out('O arquivo de configuração não tem problema; nada a recuperar.');
        return EXIT.ok;
      }
      if (!flags.sim) {
        if (!tty) { io.err('Confirmação necessária: rode "recuperar --sim" (sem terminal não há como perguntar).'); return EXIT.usage; }
        const reader = lineReader(input);
        io.write(`O arquivo ${st.snapshot.file} será renomeado (não apagado). Digite "sim" para confirmar: `);
        const r = await reader.ask({ write() {} }, '');
        reader.close();
        if (!r || r.toLowerCase() !== 'sim') { io.out('Cancelado; nada foi alterado.'); return EXIT.ok; }
      }
      const res = admin.recover({ env });
      if (json) io.out(JSON.stringify({ ok: true, backup: res.backup }));
      else io.out(`Arquivo isolado em ${res.backup}. A próxima partida usa ambiente + padrões.`);
      return EXIT.ok;
    }
  } catch (err) {
    if (err instanceof admin.AdminError || err instanceof settings.SettingsError) {
      return fail(io, err, json);
    }
    throw err;
  }
  io.err(USO);
  return EXIT.usage;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`erro: ${err.message}`); process.exit(1); });
}

module.exports = { run, USO, EXIT };
