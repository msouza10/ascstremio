const fs = require('node:fs/promises');
const path = require('node:path');
const { readTorrent, mainVideo, isVideo } = require('./library');
const { buildEpisodeIndex, findEpisode, nameExcludes, scopeOfName } = require('./episodes');
const log = require('./logger').logger.child('asc');

const MAX_OPTIONS = 12; // listar é de graça: filmes com muitas versões aparecem inteiros
const SERIES_FILE_LOOKUPS = 8; // páginas de release lidas por pedido de episódio (o resto fica "não visto")
const FILES_TTL_MS = 6 * 3600_000; // lista de arquivos completa de um release muda raramente
const FILES_CACHE_MAX = 200;
const num = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

function fmtBytes(n) {
  if (!Number.isFinite(n)) return null;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${num.format(v)} ${u[i]}`;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Release em imagem/estrutura de disco: o player não toca (e não há vídeo para a ponte servir).
const DISC = /\b(iso|bdmv|bd25|bd50|bd66|bd100|dvd5|dvd9|video_ts)\b/i;

// Motivo claro quando um torrent não tem filme tocável (usado no play).
function whyNoMain(entry) {
  const files = entry?.files ?? [];
  const videos = files.filter((f) => f.isVideo);
  if (files.some((f) => /\.(iso|img|bin)$/i.test(f.path)) && videos.length === 0) {
    return 'Este release é uma imagem de disco (.iso): não tem arquivo de vídeo que o player consiga tocar.';
  }
  if (videos.length === 0) return 'Este release não tem nenhum arquivo de vídeo reconhecido.';
  return `Este release tem ${videos.length} vídeos de tamanho parecido (pack ou coleção); só filmes com um vídeo principal são suportados.`;
}

// Fontes do ASC para o Stremio.
//
// LISTAR NÃO BAIXA NADA: o nome, o tamanho, os selos (1080p, WEB-DL, áudio), os
// seeders e o freeleech vêm da própria busca. O .torrent só é baixado quando o
// player faz o primeiro GET na URL da fonte (`resolve`), que é o momento do play.
// Assim abrir a página de um filme não grava .torrent (com a sua passkey) nem
// consome requisições à conta por opções que você não vai tocar.
function createAscProvider(asc, bridge, torrentDir, { readTorrentImpl = readTorrent, cache = null, now = Date.now } = {}) {
  const records = new Map(); // id -> { row, query }
  const prepared = new Map(); // id -> Promise<{ infoHash, fileIdx }>  (download sob demanda)
  const unsupported = new Set(); // ids que não são filme de arquivo único: saem das listas

  function meta(row) {
    return { id: `ascfilm:${row.id}`, type: 'movie', name: row.name,
      description: `${row.freeleech === true ? 'Freeleech' : 'Normal'} · ${row.seeders ?? '?'} seeders` };
  }

  async function search(query = '') {
    const rows = await asc.search(query);
    for (const row of rows) records.set(String(row.id), { row, query });
    return rows;
  }

  const isDisc = (row) => DISC.test(`${row.name} ${(row.badges ?? []).map((b) => b?.label).join(' ')}`);

  // Selos da busca separados por assunto. Resolução e fonte vão no título da fonte
  // (é o que o Stremio mostra na coluna da esquerda); o resto, na descrição.
  const RES = /^(4k|2160p|1440p|1080p|720p|576p|480p)$/i;
  const SOURCE = /^(remux|web-?dl|webrip|bluray|blu-ray|bdrip|brrip|hdrip|hdtv|dvdrip|dvd|cam|hdcam|ts)$/i;
  const SOUND = /(atmos|truehd|dts|dd\+?|ddp|eac3|ac3|aac|flac|opus|\d\.\d)/i;
  function groups(row) {
    const labels = [...new Set((Array.isArray(row.badges) ? row.badges : []).map((b) => b?.label).filter(Boolean))];
    const kindOf = new Map((Array.isArray(row.badges) ? row.badges : []).map((b) => [b?.label, b?.kind]));
    const resolution = labels.find((l) => RES.test(l)) ?? null;
    const source = labels.find((l) => SOURCE.test(l) || kindOf.get(l) === 'source') ?? null;
    const audio = labels.filter((l) => kindOf.get(l) === 'audio' || SOUND.test(l));
    const video = labels.filter((l) => l !== resolution && l !== source && !audio.includes(l));
    const lang = audio.filter((l) => !SOUND.test(l)); // idioma (Dual Áudio, Dublado…), sem codec de som
    return { resolution, source, audio, video, lang };
  }

  // Idioma original (atributo do release no ASC, em português) -> bandeira.
  const ORIGIN = {
    'inglês': '🇺🇸', coreano: '🇰🇷', 'japonês': '🇯🇵', 'francês': '🇫🇷', espanhol: '🇪🇸', 'alemão': '🇩🇪',
    italiano: '🇮🇹', 'chinês': '🇨🇳', mandarim: '🇨🇳', cantonês: '🇭🇰', russo: '🇷🇺', hindi: '🇮🇳',
    'português': '🇧🇷', sueco: '🇸🇪', 'dinamarquês': '🇩🇰', 'norueguês': '🇳🇴', finlandês: '🇫🇮',
    'holandês': '🇳🇱', polonês: '🇵🇱', turco: '🇹🇷', 'tailandês': '🇹🇭', 'árabe': '🇸🇦', hebraico: '🇮🇱',
    persa: '🇮🇷', grego: '🇬🇷', tcheco: '🇨🇿', 'húngaro': '🇭🇺', ucraniano: '🇺🇦', vietnamita: '🇻🇳',
    'indonésio': '🇮🇩', romeno: '🇷🇴',
  };
  const originFlag = (lang) => (lang ? (ORIGIN[lang.toLowerCase()] ?? lang) : null);

  // Idioma em bandeiras. A busca só traz o selo (Dual/Dublado/Legendado); o idioma original
  // vem da página de um release do filme (uma leitura por filme). Sem ele: 🌐 no lugar.
  function flagsOf(g, original) {
    const orig = originFlag(original) ?? '🌐';
    const out = g.lang.map((l) => {
      if (/dual/i.test(l)) return orig === '🇧🇷' ? '🇧🇷' : `🇧🇷${orig}`;
      if (/dublad|nacional|portugu/i.test(l)) return '🇧🇷';
      if (/legendad/i.test(l)) return orig === '🌐' ? '💬 Legendado' : `${orig}💬`;
      if (/ingl[eê]s|english/i.test(l)) return '🇺🇸';
      return l;
    });
    return [...new Set(out)].join(' ');
  }

  // Idioma original por busca (imdbId): lido uma vez e guardado; falha não fica em cache.
  const originals = new Map(); // query -> idioma | null
  const originalPending = new Map();
  const temIdioma = (rows) => rows.some((r) => (r.badges ?? []).some((b) => b?.kind === 'audio' || /áudio|dual|legendad/i.test(b?.label ?? '')));
  async function loadOriginal(query, rows) {
    if (!query || originals.has(query) || !asc.originalLanguage || !rows.length || !temIdioma(rows)) return;
    if (!originalPending.has(query)) {
      const top = [...rows].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))[0];
      const task = Promise.race([
        asc.originalLanguage(top.id),
        new Promise((_, rej) => setTimeout(() => rej(new Error('tempo esgotado')), 10_000).unref()),
      ]).then((lang) => { originals.set(query, lang); })
        .catch((err) => log.warn(`idioma original de ${query} não lido: ${err?.message ?? err}`))
        .finally(() => originalPending.delete(query));
      originalPending.set(query, task);
    }
    await originalPending.get(query);
  }

  // Coluna da esquerda do Stremio: só o que decide à primeira vista (🆓, resolução, fonte).
  function titleOf(row) {
    const g = groups(row);
    const topo = [row.freeleech === true ? '🆓' : null, g.resolution].filter(Boolean).join(' ');
    return [topo || g.source || 'ASC', topo ? g.source : null].filter(Boolean).join('\n');
  }

  // Descrição (coluna da direita): o que a esquerda não mostra, sem repetir nada.
  function describe(row, local, original = null) {
    const g = groups(row);
    const jaNaEsquerda = new Set([g.resolution, g.source]);
    const imagem = g.video.filter((l) => !jaNaEsquerda.has(l)).join(' · ');
    const som = g.audio.filter((l) => !g.lang.includes(l)).join(' · ');
    const idioma = [flagsOf(g, original), som].filter(Boolean).join(' ');
    const saude = [
      `👤 ${row.seeders ?? '?'} seeders`,
      row.leechers ? `${row.leechers} leechers` : null,
      fmtBytes(row.size) ? `💾 ${fmtBytes(row.size)}` : null,
      Number.isFinite(row.timesCompleted) ? `✅ ${row.timesCompleted}` : null,
    ].filter(Boolean).join(' · ');
    return [
      imagem || null,
      idioma || null,
      saude,
      // Regra 2.7: fora do freeleech o download conta no ratio. Sem seeders basta o 👤 0.
      row.freeleech === true ? null : '⚠ Não é freeleech',
      isDisc(row) ? '⚠ ISO' : null,
      // Já cumpriu e foi removido: assistir de novo baixa tudo e abre nova obrigação de 72 h.
      local && bridge.vault?.get?.(local.infoHash)?.releasedAs
        ? '⚠ Baixa de novo (72 h)' : null,
    ].filter(Boolean).join('\n');
  }

  function streamFromRow(row, query = null) {
    const id = String(row.id);
    const local = bridge.entryByAscId?.(id) ?? null;
    // Já sabemos que não serve (sem filme principal): não oferece.
    if (unsupported.has(id) || (local && !mainVideo(local.files))) return null;
    const video = local ? mainVideo(local.files) : null;
    return {
      name: titleOf(row),
      description: describe(row, local, originals.get(query) ?? null),
      url: bridge.lazyUrl(id),
      behaviorHints: {
        notWebReady: true,
        bingeGroup: `asc-${id}`,
        // Nome real do arquivo só quando o .torrent já está na biblioteca.
        ...(video ? { filename: path.basename(video.path) } : {}),
      },
    };
  }

  async function streamsFor(id, validatedRow = null) {
    const record = records.get(String(id));
    if (!record) return [];
    // Revalida a condição antes de disponibilizar uma nova fonte.
    const rows = validatedRow ? [validatedRow] : await search(record.query);
    const row = rows.find((item) => String(item.id) === String(id));
    if (!row) return [];
    await loadOriginal(record.query, [row]);
    const stream = streamFromRow(row, record.query);
    return stream ? [stream] : [];
  }

  // Chamado pela ponte no primeiro GET de /a/<id>: baixa o .torrent, confere e
  // registra na biblioteca. Devolve onde tocar. Erros levam `status` HTTP.
  function resolve(rawId) {
    const id = String(rawId);
    if (!/^\d{1,9}$/.test(id)) return Promise.reject(httpError(400, 'Id de release inválido.'));
    if (unsupported.has(id)) return Promise.reject(httpError(422, 'Este release não tem um filme principal que o player toque.'));
    const local = bridge.entryByAscId?.(id);
    const known = records.get(id)?.row;
    // Sem seeders ninguém envia os dados: abrir só criaria um snatch vazio no tracker. Se os
    // dados já estão completos em disco dá para tocar mesmo assim.
    const noSeeders = known?.seeders === 0 && !(local && bridge.diskState?.(local.infoHash) === 'full');
    if (noSeeders) return Promise.reject(httpError(503, 'Este release está sem seeders agora; escolha outra fonte.'));
    if (local) {
      const main = mainVideo(local.files);
      if (main) return Promise.resolve({ infoHash: local.infoHash, fileIdx: main.index });
      unsupported.add(id);
      return Promise.reject(httpError(422, whyNoMain(local)));
    }

    let task = prepared.get(id);
    if (!task) {
      task = (async () => {
        const entry = await prepareEntry(id, known);
        // O filme é o vídeo que domina o torrent (extras pequenos não contam). ISO, pack ou
        // coleção não têm filme principal: recusa antes de abrir o torrent (sem anunciar).
        const main = mainVideo(entry.files);
        if (!main) {
          unsupported.add(id);
          const motivo = whyNoMain(entry);
          log.info(`release #${id} ignorado: ${motivo}`);
          throw httpError(422, motivo);
        }
        bridge.entries.set(entry.infoHash, entry);
        return { infoHash: entry.infoHash, fileIdx: main.index };
      })();
      prepared.set(id, task);
      // Falha não fica em cache (tenta de novo no próximo play); sucesso fica.
      task.catch(() => prepared.delete(id));
    }
    return task;
  }

  // Baixa o .torrent do release e o lê, UMA vez por release: filme e episódios compartilham este
  // preparo (dois episódios do mesmo pack tocados juntos não baixam duas vezes nem criam dois
  // snatches). Só prepara: quem chama decide se o release serve e o registra na biblioteca.
  const entryTasks = new Map(); // id -> Promise<entry>
  function prepareEntry(id, known) {
    let task = entryTasks.get(id);
    if (!task) {
      task = (async () => {
        // Regra 2.7: com o filtro "somente freeleech" ligado, nunca baixa de release que não seja.
        let freeleech = known ? known.freeleech === true : null;
        if (asc.onlyFreeleech) {
          if (freeleech === null) {
            const page = await asc.history(id);
            freeleech = page.freeleech === true;
          }
          if (!freeleech) throw httpError(409, 'Este release não é freeleech e o filtro "somente freeleech" está ligado.');
        }

        log.info(`play: baixando o .torrent do release #${id} sob demanda`);
        let bytes;
        try { bytes = await asc.download(id); } catch (error) {
          throw httpError(asc.connected === false ? 401 : 502, error?.message || 'Não foi possível baixar o .torrent.');
        }
        const file = path.join(torrentDir, `asc-${id}.torrent`);
        await fs.mkdir(torrentDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(file, bytes, { mode: 0o600 });
        await fs.chmod(file, 0o600);
        const entry = await readTorrentImpl(file);
        // Só releases freeleech podem ser concluídos sozinhos em segundo plano (regra 2.7).
        entry.freeleech = freeleech;
        return entry;
      })();
      entryTasks.set(id, task);
      // Falha não fica em cache (tenta de novo no próximo play); sucesso fica.
      task.catch(() => entryTasks.delete(id));
    }
    return task;
  }

  // Episódio de um release já com o .torrent lido: o arquivo vem dos nomes do PRÓPRIO .torrent
  // (índice real), nunca da ordem da página do site. A lista da página só serve de conferência:
  // se o arquivo escolhido não tem o nome-base e o tamanho que o site mostrou, recusa.
  function pickEpisode(entry, season, episode, expected) {
    const tag = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    const found = findEpisode(buildEpisodeIndex(entry.files), season, episode);
    if (found?.conflict) throw httpError(422, `Este release tem mais de um arquivo para ${tag}; escolha outra fonte.`);
    if (!found) throw httpError(404, `Este release não traz o episódio ${tag}; escolha outra fonte.`);
    const { file } = found;
    if (expected) {
      const base = (p) => path.posix.basename(String(p).replace(/\\/g, '/')).normalize('NFC');
      const sizeOk = !Number.isFinite(expected.length) || expected.length === file.length;
      if (!sizeOk || base(expected.path) !== base(file.path)) {
        log.warn(`episódio ${tag}: a lista do site não confere com o .torrent; recusado`);
        throw httpError(409, `O arquivo de ${tag} no .torrent não confere com a lista do site; recusado por segurança.`);
      }
    }
    return { infoHash: entry.infoHash, fileIdx: file.index };
  }

  // Chamado pela ponte no primeiro GET de /e/<id>/<temporada>/<episódio>. Erros levam `status` HTTP.
  function resolveEpisode(rawId, rawSeason, rawEpisode) {
    const id = String(rawId);
    const season = Number(rawSeason);
    const episode = Number(rawEpisode);
    if (!/^\d{1,9}$/.test(id)) return Promise.reject(httpError(400, 'Id de release inválido.'));
    if (!Number.isInteger(season) || season < 0 || season > 99 || !Number.isInteger(episode) || episode < 1 || episode > 9999) {
      return Promise.reject(httpError(400, 'Episódio inválido.'));
    }
    const record = seriesRows.get(id);
    const known = record?.row;
    const expected = record?.expected.get(`${season}:${episode}`) ?? null;
    const local = bridge.entryByAscId?.(id);
    // Mesma regra do filme: sem seeders ninguém envia os dados e abrir só criaria um snatch vazio.
    if (known?.seeders === 0 && !(local && bridge.diskState?.(local.infoHash) === 'full')) {
      return Promise.reject(httpError(503, 'Este release está sem seeders agora; escolha outra fonte.'));
    }
    if (local) {
      try { return Promise.resolve(pickEpisode(local, season, episode, expected)); } catch (error) { return Promise.reject(error); }
    }
    // Falta de episódio num release NÃO o marca como `unsupported`: o pack serve a outros episódios.
    return prepareEntry(id, known).then((entry) => {
      const chosen = pickEpisode(entry, season, episode, expected);
      bridge.entries.set(entry.infoHash, entry);
      return chosen;
    });
  }

  // ---- Consulta por IMDb com queda para os arquivos locais -------------------------------------
  // `availability`: a última tentativa online. Fora do ar NÃO há nova tentativa em laço: falha de
  // sessão só tenta de novo quando a conta voltar a estar conectada (login no painel); falha de
  // site/rede espera um intervalo. O cliente nunca relogia sozinho.
  const OFFLINE_RETRY_MS = 30_000;
  const OFFLINE_TEXT = {
    session: 'a sessão do ASC está ausente ou expirou; entre novamente no painel',
    network: 'sem conexão com o site do ASC (site fora do ar ou rede caída)',
    site: 'o site do ASC recusou ou não concluiu a consulta',
  };
  let availability = { online: true, kind: null, message: null, since: null };
  let retryAt = 0;

  function markOffline(kind) {
    const k = OFFLINE_TEXT[kind] ? kind : 'site';
    if (availability.online) log.warn(`fontes online indisponíveis: ${OFFLINE_TEXT[k]}`);
    availability = { online: false, kind: k, message: OFFLINE_TEXT[k], since: availability.since ?? now() };
    retryAt = now() + OFFLINE_RETRY_MS;
  }

  // Dá para tentar o site agora? Sem sessão nunca vista (nem salva) nem se tenta; sessão que acabou
  // de falhar só volta quando `connected`; os demais respeitam o intervalo.
  function onlineGate() {
    if (asc.connected === false && asc.saved === false) return 'session';
    if (availability.online) return null;
    if (availability.kind === 'session') return asc.connected === true ? null : 'session';
    return now() < retryAt ? availability.kind : null;
  }

  // Fontes locais COMPLETAS em disco que o cache associa ao filme. Não toca na rede nem no
  // .torrent do site; incompleto, não concluído no cofre ou removido não entra (o play baixaria de novo).
  function localStreams(video) {
    const cached = cache?.get(video.imdbId);
    if (!cached) return [];
    const out = [];
    for (const release of cached.releases) {
      const local = bridge.entryByAscId?.(String(release.id));
      const main = local ? mainVideo(local.files) : null;
      if (!local || !main) continue;
      // Tamanho aparente cheio não basta (arquivo esparso de streaming levado até o fim engana): exige
      // também que o cofre registre a conclusão, como a admissão de downloads da ponte (admitTorrent).
      if (bridge.diskState?.(local.infoHash) !== 'full' || !bridge.vault?.get?.(local.infoHash)?.completedAt) continue;
      const row = { badges: release.badges };
      const g = groups(row);
      const quando = new Date(cached.at).toLocaleDateString('pt-BR');
      out.push({
        name: ['📁 Local', [g.resolution, g.source].filter(Boolean).join(' ')].filter(Boolean).join('\n'),
        description: [
          release.name,
          [g.video.join(' · '), flagsOf(g, null), g.audio.filter((l) => !g.lang.includes(l)).join(' · ')].filter(Boolean).join(' ') || null,
          `💾 ${fmtBytes(main.length)} · arquivo completo neste computador`,
          `ℹ Fontes online indisponíveis: ${availability.message ?? 'ASC não consultado'}.`,
          `Dados salvos em ${quando}${cached.stale ? ' (podem estar desatualizados)' : ''}.`,
        ].filter(Boolean).join('\n'),
        url: bridge.urlFor(local.infoHash, main.index),
        behaviorHints: { notWebReady: true, bingeGroup: `asc-${release.id}`, filename: path.basename(main.path) },
      });
    }
    return out;
  }

  // Imagens de disco e releases sem seeders vão para o fim da lista (continuam visíveis);
  // no resto, mais seeders primeiro e, em empate, freeleech antes.
  function byPreference(rows) {
    const weak = (row) => (isDisc(row) ? 2 : 0) + (row.seeders === 0 ? 1 : 0);
    return [...rows].sort((a, b) => weak(a) - weak(b)
      || (b.seeders ?? 0) - (a.seeders ?? 0)
      || (b.freeleech === true) - (a.freeleech === true));
  }

  // ---- Séries: quais releases têm o episódio pedido (SÓ LEITURA) ---------------------------------
  // Não baixa .torrent, não anuncia e não toca em `records`/`unsupported`/`prepared`: uma temporada
  // que não traz o episódio pedido não é "incompatível", só não serve a este pedido. Os arquivos
  // vêm da lista da página do release; a POSIÇÃO ali não é o índice do torrent (o índice real só
  // sai do .torrent, no play), por isso o candidato leva caminho e tamanho, nunca um fileIdx.
  const filesCache = new Map(); // id -> { at, result }  (só listas completas)
  // id -> { row, expected: Map("T:E" -> { path, length }) }: o que a listagem mostrou, para o play
  // conferir (e para reservar o tamanho do episódio, não o do pack). Limitado: o play é raro.
  const seriesRows = new Map();
  const SERIES_ROWS_MAX = 500;

  async function filesOf(id) {
    const hit = filesCache.get(id);
    if (hit && now() - hit.at < FILES_TTL_MS) return { result: hit.result, fetched: false };
    const result = await asc.releaseFiles(id);
    if (result.complete) {
      filesCache.delete(id);
      filesCache.set(id, { at: now(), result });
      if (filesCache.size > FILES_CACHE_MAX) filesCache.delete(filesCache.keys().next().value);
    }
    return { result, fetched: true };
  }

  // status: 'tem' (o episódio está na lista), 'nao-visto' (lista não lida ou incompleta: segue como
  // candidato, o play confirma). Fora: nome que contradiz, lista completa sem o episódio, ambíguo.
  async function seriesCandidates(video) {
    const { season, episode } = video;
    const { rows, truncated } = await asc.searchSeries(video.imdbId);
    const plausible = byPreference(rows.filter((row) => !nameExcludes(row.name, season, episode)));
    const candidates = [];
    let lookups = 0;
    for (const row of plausible) {
      const id = String(row.id);
      let status = 'nao-visto';
      let file = null;
      if (filesCache.has(id) || lookups < SERIES_FILE_LOOKUPS) {
        try {
          const { result, fetched } = await filesOf(id);
          if (fetched) lookups += 1;
          const index = buildEpisodeIndex(result.files.map((f, i) => ({ index: i, path: f.path, length: f.size, isVideo: isVideo(f.path) })));
          const found = findEpisode(index, season, episode);
          if (found?.conflict) continue; // dois arquivos dizem ser o episódio: não adivinha
          if (found) {
            status = 'tem';
            file = { path: found.file.path, length: found.file.length, confidence: found.file.confidence };
          } else if (result.complete) {
            continue; // lista inteira lida e sem o episódio: este release não serve a este pedido
          }
        } catch (error) {
          log.warn(`lista de arquivos do release #${id} não lida: ${error?.message ?? error}`);
        }
      }
      candidates.push({ row, status, file, scope: scopeOfName(row.name) });
      // Guarda o que a listagem mostrou: o play confere o arquivo escolhido com isto e reserva disco.
      const record = seriesRows.get(id) ?? { row, expected: new Map() };
      record.row = row;
      if (file) record.expected.set(`${season}:${episode}`, { path: file.path, length: file.length });
      seriesRows.delete(id);
      seriesRows.set(id, record);
      if (seriesRows.size > SERIES_ROWS_MAX) seriesRows.delete(seriesRows.keys().next().value);
    }
    return { candidates, truncated, total: rows.length };
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  // Fonte de um episódio: mesma apresentação do filme, com o episódio e o tamanho DELE na descrição
  // (o tamanho do release, de um pack, não diz o que vai ser baixado).
  function streamFromCandidate(candidate, video) {
    const { row, file, status } = candidate;
    const id = String(row.id);
    const local = bridge.entryByAscId?.(id) ?? null;
    const episodio = [
      `📺 S${pad2(video.season)}E${pad2(video.episode)}${file ? ` · 💾 ${fmtBytes(file.length)} o episódio` : ''}`,
      status === 'nao-visto' ? 'ℹ Episódio não confirmado na lista do site; conferido ao tocar' : null,
    ].filter(Boolean).join('\n');
    return {
      name: titleOf(row),
      description: `${episodio}\n${describe(row, local, originals.get(video.imdbId) ?? null)}`,
      url: bridge.episodeUrl(id, video.season, video.episode),
      behaviorHints: {
        notWebReady: true,
        bingeGroup: `asc-${id}`,
        ...(file ? { filename: path.posix.basename(file.path) } : {}),
      },
    };
  }

  // Tamanho do episódio mostrado na listagem (bytes), para reservar disco antes do snatch.
  function episodeSizeOf(rawId, season, episode) {
    const n = Number(seriesRows.get(String(rawId))?.expected.get(`${season}:${episode}`)?.length);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Busca por IMDb: online quando possível; senão cai para os arquivos locais completos. Devolve
  // { streams, offline } — `offline` = null (consulta feita) ou { kind, message } com o motivo.
  // Sem resultados na consulta online é ausência real (não cai para o cache). Nunca baixa .torrent.
  async function lookup(video) {
    const series = video.type === 'series';
    if (video.type !== 'movie' && !series) return { streams: [], offline: null };
    // Sem o ASC, filme cai para os arquivos locais completos; episódio ainda não (disponibilidade por
    // arquivo vem depois): mostra só o aviso de indisponibilidade.
    const fallback = () => (series ? [] : localStreams(video));
    const blocked = onlineGate();
    if (blocked) {
      if (blocked === 'session' && availability.online) markOffline('session');
      return { streams: fallback(), offline: { kind: availability.kind, message: availability.message } };
    }
    let rows;
    let found = null;
    try {
      if (series) {
        found = await seriesCandidates(video);
        rows = found.candidates.map((candidate) => candidate.row);
      } else {
        rows = await search(video.imdbId);
      }
    } catch (error) {
      markOffline(error?.kind ?? (asc.connected === false && asc.saved === false ? 'session' : 'site'));
      return { streams: fallback(), offline: { kind: availability.kind, message: availability.message } };
    }
    if (!availability.online) log.info('fontes online voltaram a responder');
    availability = { online: true, kind: null, message: null, since: null };
    if (series) {
      await loadOriginal(video.imdbId, rows);
      // O filtro por episódio já rodou sobre TODOS os releases; só agora corta nas opções.
      const streams = found.candidates.slice(0, MAX_OPTIONS).map((candidate) => streamFromCandidate(candidate, video));
      console.log(`[asc] ${video.imdbId} S${pad2(video.season)}E${pad2(video.episode)}: ${found.total} release(s), ${streams.length} fonte(s)${found.truncated ? ', busca truncada' : ''}, nenhum .torrent baixado`);
      return { streams, offline: null };
    }
    const ordered = byPreference(rows);
    await loadOriginal(video.imdbId, rows);
    const top = ordered.slice(0, MAX_OPTIONS);
    const streams = top.map((row) => streamFromRow(row, video.imdbId)).filter(Boolean);
    cache?.set(video.imdbId, top);
    // Registrar apenas contagens e identidade pública do filme, sem dados do tracker.
    console.log(`[asc] ${video.imdbId}: ${rows.length} release(s), ${streams.length} fonte(s), nenhum .torrent baixado`);
    return { streams, offline: null };
  }

  // Tamanho anunciado da release na listagem (bytes), para reservar disco antes do snatch.
  function sizeOf(rawId) {
    const n = Number(records.get(String(rawId))?.row?.size);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  return {
    sizeOf,
    episodeSizeOf,
    resolveEpisode,
    async catalog(query) { return (await search(query)).map(meta); },
    // As linhas lembradas descrevem o release (não dependem do filtro) e a query de cada uma
    // permite rebuscar depois de uma troca; por isso não são apagadas. Com o filtro ligado, só a
    // apresentação de release que não é freeleech é recusada (regra 2.7).
    meta(id) {
      const record = records.get(String(id));
      if (!record || (asc.onlyFreeleech && record.row.freeleech !== true)) return null;
      return meta(record.row);
    },
    streamsFor,
    resolve,
    lookup,
    seriesCandidates,
    availability: () => ({ ...availability }),
    // Compatível com quem só quer a lista: a indisponibilidade fica em `lookup`/`availability`.
    async findStreams(video) { return (await lookup(video)).streams; },
  };
}

module.exports = { createAscProvider };
