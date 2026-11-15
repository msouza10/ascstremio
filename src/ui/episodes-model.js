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

  const api = { tag, acaoExcluir };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.EpisodesModel = api;
})();
