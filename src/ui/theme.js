// Tema: escuro por padrão (como o site), claro opcional. Roda antes da pintura
// para não piscar; arquivo próprio porque o CSP não admite script inline.
(function () {
  var theme = 'dark';
  try { theme = localStorage.getItem('monitor.theme') || 'dark'; } catch (e) { /* sem storage */ }
  document.documentElement.classList.toggle('dark', theme !== 'light');
})();
