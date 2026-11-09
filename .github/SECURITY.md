# Política de segurança

O ascstremio lida com a **passkey, a sessão e a conta** de quem o instala no Amigos Share. Levamos
segurança a sério, principalmente os pontos que isolam o programa do restante do computador e da rede.

## Versões com correção

Só a **última versão publicada** recebe correções de segurança (veja os
[releases](https://github.com/msouza10/ascstremio/releases)). Atualize antes de reportar.

## Como reportar uma vulnerabilidade

**Não abra issue pública.** Use o relato privado do GitHub:

1. Abra [Security → Report a vulnerability](https://github.com/msouza10/ascstremio/security/advisories/new).
2. Descreva o problema, a versão, o sistema (Linux, Windows ou Docker) e como reproduzir.
3. **Não inclua** sua passkey, cookies, `.torrent` ou o conteúdo de `private/`. Se o exemplo precisar de
   um segredo, troque por um valor falso.

Você recebe uma primeira resposta em até **7 dias**. Mantemos você informado, corrigimos com
prioridade e publicamos a correção com crédito a quem reportou (se quiser), depois de a versão
corrigida estar disponível.

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
