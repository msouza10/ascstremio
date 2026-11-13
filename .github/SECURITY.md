# Política de segurança

O ascstremio lida com a **passkey, a sessão e a conta** de quem o instala no Amigos Share. Levamos
segurança a sério, principalmente os pontos que isolam o programa do restante do computador e da rede.

## Versões com correção

Só a **última versão publicada** recebe correções de segurança (veja os
[releases](https://github.com/msouza10/ascstremio/releases)). Atualize antes de reportar.

## Como reportar uma vulnerabilidade

**Não publique detalhes exploráveis, segredos nem reproduções com dados reais em issue pública.**

Use o relato privado do GitHub: [abrir um relato de vulnerabilidade](https://github.com/msouza10/ascstremio/security/advisories/new)
(aba *Security* → *Report a vulnerability*). Só o mantenedor vê o relato. Informe a versão, a área
afetada (por exemplo, "ponte" ou "painel") e os passos para reproduzir, com valores falsos no lugar de
qualquer credencial.

O projeto é mantido por uma pessoa, em tempo livre: a resposta é por melhor esforço e **não há prazo
garantido**. Se o relato for aceito, a correção segue o fluxo normal de releases e o aviso é publicado
quando já houver versão corrigida.

### O que nunca enviar (em issue, relato, captura ou log)

- Passkey do tracker, cookies/sessão do ASC (`asc-session.json`), senha do ASC ou do painel.
- A chave `?k=` e a URL do addon com `/<token>/` (`ascc_…`): são credenciais reutilizáveis; troque por
  um valor falso. Também o `admin-key` e qualquer conteúdo de `private/` ou `DATA_DIR`.
- Logs sem redação, backups dos dados e arquivos `.torrent` (podem conter a passkey no announce).

Se algo disso vazou, a recuperação depende do que foi exposto; uma ação não invalida as outras:

- **Credencial do addon** (`/<token>/`, `?k=`): `npm run credenciais -- rotacionar <id>` ou `revogar`.
- **Token administrativo** (`admin-key`): pare a instância, remova `admin-key` e reinicie.
- **Senha do painel ou do ASC:** troque a senha afetada.
- **Passkey ou sessão do ASC:** não se revogam pelo programa; gere uma nova passkey no site do
  Amigos Share e encerre a sessão pelo tracker.

## O que consideramos vulnerabilidade

- Qualquer forma de uma página web ou de outra máquina disparar ações com a sua conta: download de
  `.torrent`, anúncio no tracker, `/cleanup`, leitura de `/status` (CSRF, DNS rebinding, contornar a
  chave `?k=` ou a checagem de `Host`/`Origin`).
- Vazamento de passkey, cookies ou da chave de acesso (logs, arquivos, respostas HTTP, imagem,
  pacotes ou instalador).
- Escuta fora de `127.0.0.1` sem que o usuário tenha pedido (`BRIDGE_ALLOW_LAN`).
- Execução de código, travessia de diretório ou escalada de privilégio pelo painel, pela ponte, pelos
  scripts de instalação ou pelo instalador do Windows.
- Falha na verificação de SHA-256 do instalador por curl ou do Node baixado.

## Fora do escopo

- Hospedagem remota ou compartilhada: o programa é de uma pessoa por instalação e não tem suporte a
  exposição na internet.
- A porta de peers (TCP 7030 no contêiner) estar publicada: é o recebimento de conexões BitTorrent, não a
  API HTTP; só é problema se permitir acesso a addon, ponte ou painel.
- Uso deliberadamente inseguro: expor as portas à internet, `BRIDGE_ALLOW_LAN=1` em rede não
  confiável, publicar as portas do contêiner em `0.0.0.0`, compartilhar a conta.
- Problemas do site do Amigos Share, do Stremio ou do tracker (reporte a eles).
- Vulnerabilidades já listadas e justificadas em `scripts/audit-check.js` (dependências sem correção
  publicada e sem caminho de exploração aqui), a menos que haja uma exploração concreta.
- Acesso físico ou outro usuário com acesso ao seu perfil do sistema.

## Boas práticas para quem instala

- Mantenha as portas em `127.0.0.1` e nunca as abra no roteador.
- Guarde a pasta de dados (`private/` ou `DATA_DIR`) com permissão 700 e não a compartilhe.
- Verifique o `SHA256SUMS` do release e prefira o instalador e a imagem oficiais.
- Se suspeitar de vazamento da passkey, **gere uma nova no site do Amigos Share** e apague
  `passkey.txt`.
