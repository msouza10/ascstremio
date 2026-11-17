# Permissões da integração e canal de contato jurídico

Estado em 16/11/2026: **permissões pendentes**; o canal de contato jurídico está
**definido: as issues públicas do repositório** (decisão do mantenedor, sem canal privado).
Este roteiro apoia a [#94](https://github.com/msouza10/ascstremio/issues/94) e registra a
decisão da [#95](https://github.com/msouza10/ascstremio/issues/95); não registra aprovação do
tracker, autorização de obras nem revisão profissional.
Os [avisos legais](../LEGAL.md) descrevem o funcionamento e os limites atuais.

## Registrar permissões e limites

O mantenedor deve registrar uma conclusão para cada linha, com data, responsável e
referência à evidência. O registro público deve conter somente uma síntese sem
credenciais, dados da conta, documentos pessoais ou cópia de regras restritas.
Evidências privadas permanecem sob acesso restrito; não devem ser anexadas às issues.

| Decisão | Evidência a obter | Estado |
|---|---|---|
| Automação, cliente e distribuição da integração | Regras atuais obtidas legitimamente, versão/data e alcance da permissão do ASC | Orientação informal recebida, sem autorização formal; ver a seção Orientação informal da staff (nov/2026), abaixo |
| Reprodução e compartilhamento das obras | Base aplicável a cada uso pretendido; a permissão do tracker não substitui a dos titulares | Não verificado |
| Distribuição e suporte | Países atendidos, receita/doações, canais de suporte e limites do modelo de uma pessoa por instalação | Decisão do mantenedor pendente |
| Nomes, metadados, exemplos e demonstrações | Origem e permissão dos materiais efetivamente utilizados; inventário complementar na [#103](https://github.com/msouza10/ascstremio/issues/103) | Verificação pendente |
| Enquadramento e ajustes necessários | Revisão qualificada dos usos e registro da decisão do mantenedor, sem publicar parecer privado | Pendente |

Para cada conclusão, anotar também quais usos ela cobre, quais ficam excluídos e o que
exige nova revisão. Ausência de resposta não comprova autorização. Se faltar base para
um uso pretendido, registrar o ajuste ou a suspensão desse uso específico. Não declarar
a #94 concluída somente porque este roteiro ou um aviso foi publicado.

## Orientação informal da staff (nov/2026)

Entre 14 e 16/11/2026, o mantenedor conversou de modo informal e privado com a staff do ASC.
Esta seção é um resumo em palavras próprias do que foi informado. **Não é autorização,
aprovação nem permissão formal**, e a staff pediu que se aguardasse. Nada aqui indica que o
ASC considere a ferramenta oficial, liberada ou suportada.

- **Proposta:** a staff achou a proposta interessante, mas pediu que o mantenedor aguarde
  antes de divulgar o projeto ou incentivar o uso por outros membros.
- **API de integração:** em conversa com a staff, foi informado que o ASC testa uma API de
  integração voltada ao Prowlarr. Com ela, o usuário precisaria apenas de uma chave de API,
  sem login, senha e passkey do site. Quando a API estiver estável, a staff pode liberar o
  projeto para integrá-la. Hoje o projeto lê o site com a sessão do próprio membro (consulta
  as páginas e lê os dados estruturados embutidos no HTML). O mantenedor informou que adaptará
  a integração à API e respeitará os limites quando ela for liberada.
- **Uso da chave e limites:** o usuário poderá usar a chave como quiser, e a API terá limites
  de uso. A staff não espera que o uso normal do addon entre em conflito com esses limites.
- **Hit-and-run:** a staff pode rever os dias e as regras; por isso devem ser parametrizados
  ou atualizados pelo projeto. Depois, a staff acrescentou que a própria API informará os
  critérios de hit-and-run de cada usuário, de modo que o addon não precisaria calcular nada
  localmente.
- **Reprodução durante o download:** a staff disse não saber se isso seria possível, pela
  forma como o torrent funciona. O mantenedor respondeu que o programa consegue, priorizando
  os trechos do arquivo necessários para começar a tocar. Reproduzir pela rede doméstica foi
  descrito como algo que os usuários em geral já fazem.
- **Divulgação e canal:** a staff disse que vai conversar internamente sobre o assunto; ainda
  não há resposta nem canal definido.

**Continua sem resposta:**

- permissão formal para a consulta automatizada (scraping) do site;
- permissão formal para baixar o `.torrent` com o cliente integrado;
- condições de divulgação do projeto;
- o que o tracker faz com um snatch parcial vencido ([#109](https://github.com/msouza10/ascstremio/issues/109)),
  pergunta que nunca foi feita à staff.

Este registro é um resumo sem valor de autorização. Ele muda quando a staff publicar a API ou
responder formalmente, e a [#94](https://github.com/msouza10/ascstremio/issues/94) segue aberta
até lá.

## Canal de contato: issues públicas

Por decisão do mantenedor `msouza10` (16/11/2026), o canal de contato jurídico do projeto são
as **issues públicas do repositório**. **Não há canal privado**, e isso é deliberado. Para
começar, [abra uma issue](https://github.com/msouza10/ascstremio/issues/new) com o assunto e a
localização pública do material do projeto. Inclua uma descrição objetiva e, se couber sem
dados sensíveis, a titularidade ou representação alegada.

Tudo o que for escrito na issue é público. Não anexe obras, `.torrent`, logs, credenciais,
documentos pessoais, endereços, telefones ou provas privadas, e não peça nem ofereça um meio
privado de resposta por esse canal. Se o assunto exigir informação confidencial, escreva
apenas que ele é confidencial; o mantenedor não receberá nem solicitará esse material por aqui.
Essa solicitação pública não dispensa eventual meio de notificação legal aplicável.

Vulnerabilidades seguem a [política de segurança](../.github/SECURITY.md), pelo
[relato privado de vulnerabilidade](https://github.com/msouza10/ascstremio/security/advisories/new).
Esse recurso está habilitado no repositório e é destinado a vulnerabilidades, conforme a
[documentação do GitHub](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
Não o utilize como caixa de entrada para reclamações jurídicas gerais.

## Acompanhar as mensagens e receber e-mail

O mantenedor pode acompanhar novos contatos no próprio GitHub:

1. No repositório, abrir **Watch → Custom**, marcar **Issues** e salvar; **All Activity**
   é uma alternativa para acompanhar também os demais eventos.
2. Em [Settings → Notifications](https://github.com/settings/notifications), habilitar
   **Email** para **Watching** e salvar. **Participating** permite receber atualizações
   das conversas em que participa.
3. Para relatos de vulnerabilidade, incluir **Security alerts** em **Watch → Custom**,
   além das preferências de e-mail correspondentes.

Essas são instruções de configuração; as preferências pessoais de e-mail do mantenedor
não foram verificadas nem alteradas. O recebimento depende delas e da entrega do provedor.
Veja [como configurar notificações no GitHub](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications).
**Responder ao e-mail de uma issue publica a resposta na conversa da issue.** E-mail de
notificação não transforma a issue pública em conversa privada. Não envie dados sensíveis
por esse caminho.

## Se um canal privado vier a existir

Não está planejado. Se o mantenedor mudar a decisão, antes de anunciar qualquer canal privado
precisa confirmar:

- Endereço ou formulário real, responsável pelo acompanhamento e pessoas com acesso.
- Finalidade dos dados recebidos, armazenamento restrito, retenção e descarte; definir
  como atender solicitações e quando preservar evidências necessárias, com revisão qualificada.
- Capacidade de recebimento e resposta, sem prometer prazo voluntário que não possa cumprir
  nem afastar eventual prazo legal obrigatório.
- Link acessível sem conta do projeto e destino correto, verificados sem enviar dados reais.

Só então atualizar o § 8 de `LEGAL.md` (nova versão do aviso), a linha J13 da
[matriz](conformidade-juridica.md) e abrir uma nova issue; a #95 foi encerrada com a decisão
das issues públicas.

## Tratamento das solicitações

1. **Receber o mínimo necessário:** assunto e localização pública, conforme acima. Não solicitar
   informações sensíveis nem meio privado de resposta por esse canal.
2. **Triar:** separar suporte, vulnerabilidades e reclamações jurídicas. Vulnerabilidades vão
   pelo relato privado de segurança; material privado recebido por engano não é copiado nem
   mantido na issue.
3. **Analisar e decidir:** verificar se o material está sob controle do projeto e obter
   avaliação qualificada quando necessária. Registrar na própria issue a decisão, o responsável
   e a data, sem dados privados.
4. **Responder e executar:** comunicar a decisão sem dados privados e registrar a ação
   sobre materiais ou distribuições do projeto. Não prometer apagar arquivos em máquinas
   pessoais nem conteúdo do ASC ou de terceiros.
5. **Encerrar o registro:** issues públicas e suas notificações podem ter cópias fora do
   controle do mantenedor; não prometer apagá-las.

Como o canal é público, o mantenedor não deve solicitar nem aceitar material privado por ele.
Uma rotina documental não comprova autorização nem assegura imunidade jurídica.
