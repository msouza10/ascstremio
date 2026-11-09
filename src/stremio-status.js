// Status do addon DENTRO do Stremio: um catálogo "ASC — status" com o resumo da
// conta (ratio, filmes, seed pendente, disco), um cartão por risco e um por filme
// em andamento, mais um aviso no topo das fontes quando há risco crítico.
//
// O Stremio não tem notificações para addons, então o que dá para fazer é:
//  - o primeiro item do catálogo muda de cor e de título conforme o risco;
//  - cada aviso do painel vira um item com o texto completo;
//  - fontes de filmes ASC ganham uma entrada `externalUrl` de alerta quando há risco crítico.
// Os cartões (pôsteres) são SVG gerados aqui a partir do estado atual: nenhum texto
// vem da URL, só um id de uma lista fechada, então não há injeção em SVG.
//
// Tudo é função pura sobre o snapshot da ponte (`Bridge.snapshot()` + `stats` da conta).

const num = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const num0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

const bytes = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${num.format(v)} ${u[i]}`;
};
const hours = (h) => `${num.format(h)} h`;
const days = (d) => (d === null || d === undefined ? '—' : d <= 0 ? 'vencido' : d < 1 ? `${num.format(d * 24)} h` : `${num.format(d)} dias`);

const cap = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);

// Cores do design system do ASC (tokens escuros), em hex para o SVG.
const TONES = {
  ok: { color: '#38d080', mark: '✓' },
  info: { color: '#3a9bfd', mark: '↓' },
  warn: { color: '#f0b135', mark: '!' },
  crit: { color: '#ff6a65', mark: '!' },
  neutral: { color: '#989fa8', mark: '·' },
};
const SURFACE = '#13181e';
const BACKGROUND = '#0a0e12';
const FOREGROUND = '#ebeff4';
const MUTED = '#989fa8';

const STATE_LABEL = {
  hnr: 'hit-and-run registrado', missing: 'sem arquivo para semear', paused: 'seed parado', seeding: 'semeando',
  awaiting: 'aguardando o tracker', completing: 'baixando o restante', partial: 'só streaming', done: 'cumprido', unstarted: 'não iniciado',
};
const ORDER = { hnr: 0, missing: 1, paused: 1, seeding: 2, awaiting: 3, completing: 4, partial: 5, done: 6, unstarted: 7 };
const RISK_ORDER = { crit: 0, warn: 1, ok: 2 };

// ---------------------------------------------------------------- itens
// Cada item: { id, tone, name, releaseInfo, headline, lines[], description }
function buildItems(snap, { panelUrl = 'http://127.0.0.1:7020' } = {}) {
  if (!snap || !snap.summary) {
    return [{
      id: 'resumo', tone: 'neutral', name: 'Monitor ASC: sem dados', releaseInfo: 'aguardando',
      headline: 'Sem dados ainda', lines: ['O addon acabou de iniciar.', 'Confirme a sessão do ASC no painel.', panelUrl],
      description: `O addon ainda não leu o estado da conta. Abra o painel: ${panelUrl}`,
    }];
  }
  const s = snap.summary;
  const st = snap.stats;
  const acc = snap.account;
  const titles = snap.titles ?? [];
  const items = [];

  const critical = titles.some((t) => t.risk === 'crit') || Boolean(acc?.hitAndRuns) || Boolean(acc?.prisonUntil);
  const semLeitura = !st || st.ratio === null;
  const warnAny = semLeitura || titles.some((t) => t.risk === 'warn') || Boolean(snap.notices?.length) || Boolean(s.disk?.blocked) || (st && st.ratio !== null && st.ratio < 1);
  const level = critical ? 'crit' : warnAny ? 'warn' : 'ok';

  const count = (f) => titles.filter(f).length;
  const emSeed = count((t) => ['seeding', 'paused', 'missing', 'awaiting', 'hnr'].includes(t.state));
  const resumoLines = [
    st ? `Ratio ${st.ratio === null ? '—' : num.format(st.ratio)} · enviado ${bytes(st.uploaded)} · baixado ${bytes(st.downloaded)}` : 'Ratio ainda não lido',
    `Biblioteca: ${s.total} filme(s) · ${emSeed} em seed · ${count((t) => t.state === 'completing')} baixando · ${count((t) => t.state === 'done')} cumprido(s)`,
    `Seed pendente: ${hours(s.hoursPending)} em ${s.pending} filme(s)${s.machineHoursPerDay ? ` · máquina ligada ≥ ${num.format(s.machineHoursPerDay)} h/dia` : ''}`,
    `Disco: ${bytes(s.diskUsed)} ocupados · ${s.freeBytes === null || s.freeBytes === undefined ? 'livres desconhecidos' : `${bytes(s.freeBytes)} livres`}${s.disk?.blocked ? ' · novos downloads bloqueados' : ''}`,
    `Hit-and-run: ${acc ? acc.hitAndRuns : '—'} · prisão: ${acc?.prisonUntil ? `até ${new Date(acc.prisonUntil).toLocaleDateString('pt-BR')}` : 'nenhuma'}`,
  ];
  const nCrit = titles.filter((t) => t.risk === 'crit').length;
  const nWarn = titles.filter((t) => t.risk === 'warn').length;
  const risco = level === 'crit' ? `${nCrit || 1} risco(s) crítico(s)` : level === 'warn' ? (semLeitura && !nWarn ? 'dados da conta ainda não lidos (tentando de novo)' : `${nWarn || 1} aviso(s)`) : 'tudo em dia';
  items.push({
    id: 'resumo',
    tone: level,
    name: level === 'crit' ? '⚠ Monitor ASC: aja agora' : level === 'warn' ? '⚠ Monitor ASC: atenção' : '✓ Monitor ASC: tudo em dia',
    releaseInfo: `${st && st.ratio !== null ? `Ratio ${num.format(st.ratio)} · ` : ''}${emSeed} em seed`,
    headline: level === 'crit' ? 'Aja agora' : level === 'warn' ? 'Atenção' : 'Tudo em dia',
    big: st && st.ratio !== null ? num.format(st.ratio) : '—', bigLabel: 'ratio',
    // O número é o ratio: a cor dele segue o ratio, não o risco geral do cartão.
    bigTone: st && st.ratio !== null ? (st.ratio >= 1 ? 'ok' : 'warn') : 'neutral',
    lines: [`${s.total} filmes · ${emSeed} em seed`, `${hours(s.hoursPending)} de seed pendente`, risco],
    description: `${resumoLines.join('\n')}\n\nSituação: ${risco}.\nPainel completo: ${panelUrl}`,
  });

  // um cartão por aviso (crítico primeiro)
  const avisos = [];
  for (const t of titles) for (const w of t.warnings ?? []) avisos.push({ tone: t.risk === 'crit' ? 'crit' : 'warn', text: w, name: t.name });
  for (const n of snap.notices ?? []) avisos.push({ tone: 'warn', text: n, name: 'Conta' });
  avisos.sort((a, b) => (a.tone === 'crit' ? 0 : 1) - (b.tone === 'crit' ? 0 : 1));
  avisos.slice(0, 8).forEach((a, i) => {
    items.push({
      id: `aviso-${i}`, tone: a.tone,
      name: `${a.tone === 'crit' ? '⚠ ' : '! '}${a.text.slice(0, 54)}${a.text.length > 54 ? '…' : ''}`,
      releaseInfo: a.tone === 'crit' ? 'aja agora' : 'atenção',
      headline: a.tone === 'crit' ? 'Aja agora' : 'Atenção',
      lines: [a.text],
      description: `${a.text}\n\nPainel: ${panelUrl}/filmes`,
    });
  });

  // conta no ASC
  const ratioOk = st && st.ratio !== null && st.ratio >= 1;
  items.push({
    id: 'conta', tone: acc?.hitAndRuns || acc?.prisonUntil ? 'crit' : ratioOk ? 'ok' : 'warn',
    name: `Conta: ratio ${st && st.ratio !== null ? num.format(st.ratio) : '—'}`,
    releaseInfo: `${acc ? acc.hitAndRuns : '—'} HnR · ${acc ? acc.pendingSeeds : '—'} pendente(s)`,
    headline: 'Conta no ASC',
    big: st && st.ratio !== null ? num.format(st.ratio) : '—', bigLabel: ratioOk ? 'ratio · acima do mínimo' : 'ratio · abaixo do mínimo',
    bigTone: st && st.ratio !== null ? (ratioOk ? 'ok' : 'warn') : 'neutral',
    lines: [st ? `↑ ${bytes(st.uploaded)}  ↓ ${bytes(st.downloaded)}` : '', `${acc ? acc.hitAndRuns : '—'} hit-and-run`, acc?.prisonUntil ? 'em prisão de download' : 'sem prisão'].filter(Boolean),
    description: [
      st ? `Ratio ${st.ratio === null ? '—' : num.format(st.ratio)} (mínimo do site: 1,0)` : 'Ratio ainda não lido',
      st ? `Enviado ${bytes(st.uploaded)} · baixado ${bytes(st.downloaded)}` : '',
      acc ? `Hit-and-runs: ${acc.hitAndRuns} · resolvidos: ${acc.cleared} · seeds pendentes no site: ${acc.pendingSeeds}` : '',
      acc ? `Prisão de download: ${acc.prisonUntil ? `até ${new Date(acc.prisonUntil).toLocaleString('pt-BR')}` : 'nenhuma'} · isento (VIP): ${acc.exempt ? 'sim' : 'não'}` : '',
      ...(snap.notices ?? []),
    ].filter(Boolean).join('\n'),
  });

  // filmes em andamento (obrigação, download ou concluídos recentes)
  const ativos = titles
    .filter((t) => ['hnr', 'missing', 'paused', 'seeding', 'awaiting', 'completing', 'done'].includes(t.state))
    .sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || a.name.localeCompare(b.name, 'pt-BR'))
    .slice(0, 20);
  for (const t of ativos) {
    const tone = t.risk === 'crit' ? 'crit' : t.risk === 'warn' ? 'warn' : t.state === 'completing' ? 'info' : t.state === 'done' ? 'ok' : 'ok';
    const prog = t.state === 'completing' ? `${num0.format(t.progress * 100)}% baixado` : t.state === 'done' ? 'cumprido' : `${hours(t.seededHours)} de ${hours(t.requiredHours)}`;
    const slug = String(t.infoHash).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
    items.push({
      id: `filme-${slug}`, tone, name: t.name.slice(0, 60),
      releaseInfo: `${STATE_LABEL[t.state] ?? t.state} · ${prog}`,
      headline: cap(STATE_LABEL[t.state] ?? t.state),
      big: t.state === 'completing' ? `${num0.format(t.progress * 100)}%` : t.state === 'done' ? '72 h' : num.format(t.seededHours),
      bigLabel: t.state === 'completing' ? 'baixado' : t.state === 'done' ? 'cumpridas' : `h de ${num.format(t.requiredHours)} h`,
      lines: [t.name.slice(0, 60), t.daysLeft !== null && t.state !== 'done' ? `prazo: ${days(t.daysLeft)}` : ''].filter(Boolean),
      description: [
        `Situação: ${STATE_LABEL[t.state] ?? t.state}`,
        `Seed: ${hours(t.seededHours)} de ${hours(t.requiredHours)}${t.state === 'completing' ? ` · download ${num0.format(t.progress * 100)}%` : ''}`,
        t.daysLeft !== null && t.state !== 'done' ? `Prazo: ${days(t.daysLeft)}` : '',
        t.tracker ? `Tracker: ${t.tracker.satisfied ? 'cumprido' : t.tracker.remainingHours === null ? 'sem dado' : `faltam ${hours(t.tracker.remainingHours)}`}` : '',
        t.freeleech === true ? 'Freeleech' : t.freeleech === false ? 'Sem freeleech: o download conta no ratio' : '',
        ...(t.warnings ?? []),
      ].filter(Boolean).join('\n'),
    });
  }
  return items;
}

// ------------------------------------------------------------ Stremio
const idFor = (item) => `ascstatus:${item.id}`;
const posterUrl = (base, item) => `${base.replace(/\/$/, '')}/status/poster/${item.id}.svg`;

function catalogMetas(items, base) {
  return items.map((item) => ({
    id: idFor(item), type: 'movie', name: item.name, releaseInfo: item.releaseInfo,
    poster: posterUrl(base, item), posterShape: 'poster', description: item.description,
  }));
}

function metaFor(items, id, base) {
  const item = items.find((x) => idFor(x) === id);
  if (!item) return null;
  return {
    id, type: 'movie', name: item.name, releaseInfo: item.releaseInfo,
    poster: posterUrl(base, item), background: posterUrl(base, item), description: item.description,
  };
}

// "Abrir o painel": o único stream dos itens de status.
function statusStreams(panelUrl) {
  return [{ name: 'Monitor ASC', description: 'Abrir o painel no navegador', externalUrl: `${panelUrl}/` }];
}

// Aviso no topo das fontes de qualquer filme ASC quando há risco crítico.
function alertStream(snap, panelUrl) {
  if (!snap?.summary) return null;
  const crit = (snap.titles ?? []).filter((t) => t.risk === 'crit');
  const acc = snap.account;
  if (!crit.length && !acc?.hitAndRuns && !acc?.prisonUntil) return null;
  const first = crit[0]?.warnings?.[0]
    ?? (acc?.prisonUntil ? 'Conta em prisão de download.' : 'Hit-and-run registrado na conta.');
  return {
    name: '⚠ Monitor ASC',
    description: `${crit.length > 1 ? `${crit.length} riscos críticos. ` : ''}${first}\nToque para abrir o painel.`,
    externalUrl: `${panelUrl}/filmes?estado=atencao`,
  };
}

// ----------------------------------------------------------------- pôster
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function wrap(text, width, max) {
  const words = String(text).split(/\s+/);
  const out = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  if (out.length > max) { out.length = max; out[max - 1] = `${out[max - 1].slice(0, width - 1)}…`; }
  return out;
}

function posterSvg(item) {
  const tone = TONES[item.tone] ?? TONES.neutral;
  const head = wrap(item.headline, 15, 2);
  const text = [];
  let y = 340;
  head.forEach((l) => { text.push(`<text x="48" y="${y}" font-size="48" font-weight="700" fill="${FOREGROUND}">${esc(l)}</text>`); y += 58; });
  if (item.big) {
    // O número que importa (ratio, horas de seed, % baixado) é o destaque do cartão.
    y += 112;
    const size = String(item.big).length > 5 ? 118 : 150;
    const bigColor = (TONES[item.bigTone] ?? tone).color;
    text.push(`<text x="44" y="${y}" font-size="${size}" font-weight="700" letter-spacing="-4" fill="${bigColor}">${esc(item.big)}</text>`);
    y += 52;
    text.push(`<text x="48" y="${y}" font-size="24" font-weight="600" letter-spacing="2" fill="${MUTED}">${esc(String(item.bigLabel ?? '').toUpperCase())}</text>`);
    y += 70;
  } else y += 24;
  const size = item.big ? 28 : 32;
  const width = item.big ? 26 : 22;
  const room = Math.floor((842 - y) / (size + 12));
  item.lines.flatMap((l) => wrap(l, width, item.big ? 3 : 9)).slice(0, Math.max(2, room)).forEach((l) => {
    text.push(`<text x="48" y="${y}" font-size="${size}" fill="${item.big ? MUTED : FOREGROUND}" fill-opacity="${item.big ? 1 : 0.88}">${esc(l)}</text>`);
    y += size + 12;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900" width="600" height="900" font-family="Inter, system-ui, -apple-system, 'Segoe UI', sans-serif">
<rect width="600" height="900" fill="${BACKGROUND}"/>
<rect x="24" y="24" width="552" height="852" rx="28" fill="${SURFACE}" stroke="#2a323b" stroke-width="2"/>
<rect x="24" y="24" width="552" height="14" rx="7" fill="${tone.color}"/>
<circle cx="110" cy="140" r="62" fill="${tone.color}" fill-opacity="0.16"/>
<text x="110" y="166" font-size="80" font-weight="700" text-anchor="middle" fill="${tone.color}">${esc(tone.mark)}</text>
<text x="48" y="262" font-size="22" font-weight="600" letter-spacing="3" fill="${tone.color}">MONITOR ASC</text>
${text.join('\n')}
</svg>`;
}

// Rota HTTP dos cartões: devolve true se atendeu. O id só vale se existir no estado atual.
function posterRoute(req, res, getSnapshot, panelUrl) {
  const m = /^\/status\/poster\/([a-z0-9-]{1,40})\.svg$/.exec(String(req.url).split('?')[0]);
  if (!m || req.method !== 'GET') return false;
  let items;
  try { items = buildItems(getSnapshot(), { panelUrl }); } catch { items = []; }
  const item = items.find((x) => x.id === m[1]);
  if (!item) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('cartão inexistente'); return true; }
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  res.end(posterSvg(item));
  return true;
}

module.exports = { buildItems, catalogMetas, metaFor, statusStreams, alertStream, posterSvg, posterRoute, idFor, STATUS_PREFIX: 'ascstatus:' };
