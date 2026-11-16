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
      case 'restore': return { perigo: false, titulo: 'Baixar o que falta', texto: `O restante baixa em segundo plano e o seed volta a contar para o pack inteiro.${custo}` };
      default: throw new Error('ação desconhecida');
    }
  }

  const api = { tag, acaoExcluir, estadoInicial, escolher, cancelar, confirmar, mensagem, concluido, falhou, pedido, temporadas, descricao };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.EpisodesModel = api;
})();
