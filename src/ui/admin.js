// Entrada da administração do painel pela LAN (issue #24). Só aparece quando o servidor informa
// que a administração está ativa e não há sessão. A senha é a de ADMINISTRAÇÃO (definida no
// terminal do host), não a do ASC; ela só trafega no corpo do POST e o campo é limpo em seguida.
(() => {
  const { el, setText, card, badge } = window.UI;

  function adminEntrar() {
    const root = el('div', 'page');
    const wrap = el('div', 'hero');
    wrap.append(badge('Administração do painel', 'primary', { upper: true }));
    const h1 = el('h1'); h1.append(document.createTextNode('Entrar como '), el('span', '', 'administrador'));
    wrap.append(h1, el('p', 'muted', 'Esta é a senha de administração definida no terminal do computador (npm run admin-painel), não a senha do ASC. Perdeu a senha? No terminal do host: npm run admin-painel -- definir --trocar.'));
    const c = card();
    const form = el('form', 'form');
    form.method = 'post'; form.action = '/api/admin/session';
    const f = el('label', 'field'); f.htmlFor = 'admin-password';
    const input = el('input', 'input'); input.id = 'admin-password'; input.name = 'admin-password'; input.type = 'password'; input.required = true;
    input.maxLength = 256; input.autocomplete = 'current-password';
    f.append(el('span', '', 'Senha de administração'), input);
    const submit = el('button', 'btn btn-primary', 'Entrar');
    const status = el('p', 'status'); status.setAttribute('role', 'status');
    form.append(f, submit);
    c.append(form, status);
    wrap.append(c);
    root.append(wrap);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true; status.classList.remove('error'); setText(status, 'Entrando…');
      try {
        await window.App.adminLogin(input.value);
      } catch (err) { setText(status, err.message); status.classList.add('error'); }
      input.value = ''; submit.disabled = false;
    });
    return { root, update() {} };
  }

  window.Views.adminEntrar = adminEntrar;
})();
