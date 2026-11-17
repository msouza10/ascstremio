// Lógica pura do card "Episódios em disco" (sem DOM), para ser testada no Node. A mesma regra que o
// servidor aplica em src/file-actions.js: não se exclui episódio antes de o tracker confirmar o seed.
// Aqui ela só decide se o botão aparece habilitado e, se não, explica por quê. O servidor continua
// sendo quem recusa; esta regra nunca autoriza nada por conta própria.
(() => {
  const two = (n) => String(n).padStart(2, '0');

  // S01E03, S01E01-E02 (episódio duplo). Zero à esquerda só até dois dígitos: S12E104 fica como está.
  function tag(e) {
    return `S${two(e.season)}E${two(e.episode)}${e.episodeEnd ? `-E${two(e.episodeEnd)}` : ''}`;
  }

  // Excluir um episódio de um pack. Sem conclusão registrada não há obrigação de seed. Com conclusão,
  // o tracker precisa ter confirmado o cumprimento e não pode haver hit-and-run; sem leitura do
  // tracker a resposta é "não" (fail-closed).
  function acaoExcluir(t) {
    if (!t || !Array.isArray(t.episodes) || t.episodes.length === 0) {
      return { permitida: false, motivo: 'Não há episódios para excluir.' };
    }
    if (!t.completedAt) return { permitida: true, motivo: '' };
    if (t.tracker?.hitAndRun) {
      return { permitida: false, motivo: 'O tracker registrou hit-and-run neste pack: excluir agora seria reincidência. Continue semeando.' };
    }
    if (t.tracker?.satisfied === true) return { permitida: true, motivo: '' };
    if (!t.tracker || t.tracker.satisfied === undefined) {
      return { permitida: false, motivo: 'O tracker ainda não foi consultado para este pack. Disponível depois que ele confirmar o seed.' };
    }
    return { permitida: false, motivo: 'Disponível depois que o tracker confirmar o seed: excluir um episódio agora pararia o seed com a obrigação de 72 h aberta.' };
  }

  // ---- Estado do card (uma ação por vez, sempre com confirmação) ----------------------------------
  // Funções puras: devolvem o estado novo e quem desenha só aplica. `busy` impede clique duplo e
  // troca de ação com um pedido em voo; o fim do pedido (bem ou mal) sempre libera e fecha a ação.
  const estadoInicial = () => ({ action: null, busy: false, result: '' });
  const escolher = (st, action) => (st.busy ? st : { ...st, action, result: '' });
  const cancelar = (st) => (st.busy ? st : { ...st, action: null });
  const confirmar = (st) => (st.busy || !st.action ? null : { ...st, busy: true });
  const mensagem = (res) => res?.message ?? (res?.aviso ? `Iniciado. ${res.aviso}` : 'Iniciado. O restante baixa em segundo plano.');
  const concluido = (st, res) => ({ action: null, busy: false, result: mensagem(res) });
  const falhou = (st, err) => ({ action: null, busy: false, result: err?.message || 'Não foi possível concluir a ação.' });

  // Só números e o infoHash: quem escolhe os arquivos de uma temporada é o servidor.
  function pedido(action, infoHash) {
    switch (action?.kind) {
      case 'exclude': return { route: 'exclude', body: { infoHash, file: action.file } };
      case 'excludeSeason': return { route: 'exclude', body: { infoHash, season: action.season } };
      case 'completeFile': return { route: 'complete', body: { infoHash, file: action.file } };
      case 'completeSeason': return { route: 'complete', body: { infoHash, season: action.season } };
      case 'verify': return { route: 'verify-pieces', body: { infoHash } };
      case 'restore': return { route: 'complete', body: { infoHash } };
      default: throw new Error('ação desconhecida');
    }
  }

  // Episódios agrupados por temporada. `podeExcluir`: há algo em disco (inclusive parcial) que a
  // exclusão liberaria; `falta`: há episódio não baixado, em parte ou excluído.
  function temporadas(eps) {
    const por = new Map();
    for (const e of Array.isArray(eps) ? eps : []) {
      const t = por.get(e.season) ?? { season: e.season, episodes: [], podeExcluir: false, falta: false };
      t.episodes.push(e);
      if (!e.excluded && e.state !== 'ausente') t.podeExcluir = true;
      if (e.excluded || e.state === 'ausente' || e.state === 'parcial') t.falta = true;
      por.set(e.season, t);
    }
    return [...por.values()].sort((a, b) => a.season - b.season);
  }

  // Texto da confirmação: o alcance sempre visível. `perigo` pinta o botão de confirmar.
  function descricao(action, t) {
    const custo = t?.freeleech === true ? '' : ' Este release não é freeleech: o que baixar conta no seu ratio.';
    switch (action?.kind) {
      case 'exclude': return { perigo: true, titulo: `Excluir ${action.tag}`, texto: 'O arquivo deste episódio será apagado, o seed deste pack para até você baixar o que falta e nada será baixado de volta sozinho.' };
      case 'excludeSeason': return { perigo: true, titulo: `Excluir a temporada ${action.season}`, texto: `Os arquivos de todos os episódios da temporada ${action.season} serão apagados, o seed deste pack para até você baixar o que falta e nada será baixado de volta sozinho.` };
      case 'completeFile': return { perigo: false, titulo: `Baixar ${action.tag}`, texto: `Baixa só este episódio em segundo plano. Não conclui o pack: a obrigação de 72 h só nasce com o torrent inteiro.${custo}` };
      case 'completeSeason': return { perigo: false, titulo: `Baixar a temporada ${action.season}`, texto: `Baixa só os episódios da temporada ${action.season} em segundo plano. Não conclui o pack: a obrigação de 72 h só nasce com o torrent inteiro.${custo}` };
      case 'verify': return { perigo: false, titulo: 'Verificar peças', texto: 'Confere por peças, no disco, os episódios que só parecem completos. Lê os arquivos, mas não baixa nem anuncia nada.' };
      case 'restore': return { perigo: false, titulo: 'Baixar o que falta', texto: `O restante baixa em segundo plano e o seed volta a contar para o pack inteiro.${custo}` };
      default: throw new Error('ação desconhecida');
    }
  }

  // Há episódio cujo tamanho só "parece" cheio? Com o motor aberto o estado já vem das peças.
  const podeVerificar = (eps, flags = {}) => !flags.verified && Array.isArray(eps) && eps.some((e) => e.state === 'provavel');

  // Fluxo do "Confirmar": monta o pedido ANTES de ocupar (ação desconhecida não deixa o card preso),
  // ocupa, chama o servidor e sempre termina liberado, com sucesso ou erro. `aplicar` recebe cada
  // estado novo (o DOM só redesenha); `call(route, body)` é a chamada autenticada do painel.
  // Devolve false quando não havia o que confirmar (clique duplo ou nenhuma ação escolhida).
  async function executar(st, infoHash, call, aplicar) {
    const indo = confirmar(st);
    if (!indo) return false;
    const req = pedido(indo.action, infoHash);
    aplicar(indo);
    // Só a chamada ao servidor entra no try: um erro ao redesenhar o sucesso não pode virar "falhou"
    // com a ação já concluída (quem tentasse de novo repetiria a exclusão ou o download).
    let res; let erro; let deuErro = false;
    try { res = await call(req.route, req.body); } catch (err) { erro = err; deuErro = true; }
    aplicar(deuErro ? falhou(indo, erro) : concluido(indo, res));
    return true;
  }

  // O que o card mostra: quais botões existem, em que ordem, e se estão habilitados. O DOM só desenha.
  // Cada botão: { rotulo, icone, acao, titulo, desabilitado }. `completing` (conclusão em segundo
  // plano) esconde todo download, e "Excluir" segue a regra do tracker (fail-closed) em `acaoExcluir`.
  function plano(t, st) {
    const eps = Array.isArray(t?.episodes) ? t.episodes : [];
    const completing = t?.state === 'completing';
    const acao = acaoExcluir(t);
    const botao = (rotulo, icone, a, titulo, off) => ({ rotulo, icone, acao: a, titulo, desabilitado: st.busy || off });
    const excluir = (a, permitidaTitulo) => botao('Excluir', acao.permitida ? 'trash-2' : 'clock', a, acao.permitida ? permitidaTitulo : acao.motivo, !acao.permitida);
    const grupos = temporadas(eps);
    const out = grupos.map((ts) => ({
      season: ts.season,
      cabecalho: grupos.length > 1,
      baixar: ts.falta && !completing
        ? botao('Baixar temporada', 'download', { kind: 'completeSeason', season: ts.season }, `Baixa só os episódios da temporada ${ts.season}.`, false) : null,
      excluir: ts.podeExcluir
        ? { ...excluir({ kind: 'excludeSeason', season: ts.season }, `Excluir os arquivos da temporada ${ts.season}`), rotulo: 'Excluir temporada' } : null,
      episodios: ts.episodes.map((e) => {
        const tg = tag(e);
        return {
          ep: e, tag: tg,
          baixar: e.state !== 'completo' && !completing
            ? botao('Baixar', 'download', { kind: 'completeFile', file: e.index, tag: tg }, `Baixa só ${tg} em segundo plano.`, false) : null,
          excluir: e.state !== 'ausente' && !e.excluded
            ? excluir({ kind: 'exclude', file: e.index, tag: tg }, `Excluir o arquivo de ${tg}`) : null,
        };
      }),
    }));
    const livre = !st.action;
    return {
      temporadas: out,
      restaurar: grupos.some((x) => x.falta) && !completing && livre
        ? botao('Baixar o que falta', 'download', { kind: 'restore' }, 'Baixa o que falta do torrent com prioridade baixa e traz de volta os episódios que você excluiu.', false) : null,
      verificar: livre && podeVerificar(eps)
        ? botao('Verificar peças', 'shield-check', { kind: 'verify' }, 'Confere por peças, no disco, os episódios que só parecem completos.', false) : null,
    };
  }

  const api = { podeVerificar, tag, acaoExcluir, estadoInicial, escolher, cancelar, confirmar, mensagem, concluido, falhou, pedido, temporadas, descricao, executar, plano };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.EpisodesModel = api;
})();
