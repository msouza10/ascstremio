# Avisos legais e condições de uso do ascstremio

Versão do aviso: 1 — 14 de novembro de 2026.

## 1. Escopo e independência

O ascstremio é um software de código aberto para integrar uma instalação pessoal do
Stremio à conta individual de quem utiliza o Amigos Share (ASC). O projeto é independente
e não representa o ASC nem o Stremio. A referência a esses nomes identifica a integração;
não significa aprovação, parceria, patrocínio ou autorização dos respectivos responsáveis.

A arquitetura documentada destina-se a uma pessoa por instalação. As orientações de
operação pessoal e segurança deste documento não alteram as permissões sobre o código
concedidas pela [licença MIT](LICENSE).

## 2. Direitos sobre o código e sobre o conteúdo

A licença MIT abrange o código disponibilizado sob ela. Componentes de terceiros mantêm
suas próprias licenças. Nenhuma dessas licenças concede acesso ao ASC, credenciais,
convites ou direitos sobre filmes, séries, imagens, legendas ou outros materiais de terceiros.

Utilize a integração somente quando o acesso, a reprodução e o compartilhamento envolvidos
estiverem autorizados pelos titulares ou amparados pela legislação aplicável. A autorização
de uma modalidade de uso não deve ser presumida para as demais. Ter conta no tracker,
possuir uma cópia, pagar por outro serviço ou não obter lucro não comprova, por si só,
autorização para baixar e redistribuir uma obra.

O software não verifica a cadeia de direitos das obras e a presença de uma fonte na busca
não certifica sua legalidade. Não utilize o projeto para infringir direitos de terceiros,
contornar restrições de acesso ou divulgar credenciais e arquivos sem autorização.

## 3. Conta, automação e regras do ASC

Cada instalação utiliza a sessão e a passkey da conta configurada por seu responsável.
Confira as regras atuais do ASC e a permissão para automação e para o cliente utilizado
antes de conectar a conta. O projeto não apresenta a integração como aprovada pelo tracker.

A permissão do tracker para uso de sua plataforma é distinta da autorização dos titulares
das obras. O acompanhamento de ratio, seed, hit-and-run e inatividade é auxiliar: não garante
aceitação do cliente, contagem de tráfego, regularidade da conta ou ausência de sanções.
Informações incompletas, alterações do site, falhas de conexão e mudanças de regras podem
afetar os resultados. A confirmação do tracker orienta as ações operacionais de seed;
ela não certifica direitos autorais.

## 4. Download, upload e exposição de rede

A máquina que executa o ascstremio baixa arquivos e os compartilha por BitTorrent.
O upload pode ocorrer durante o download, durante a reprodução e depois de fechar o player.
Pendências podem ser retomadas quando o aplicativo inicia. Há também ações de conclusão
de download em segundo plano. Interromper a reprodução ou revogar uma credencial de player
não equivale a encerrar o seed ou revogar a sessão/passkey do ASC.

Listar fontes não inicia o download do `.torrent`; a reprodução de uma fonte sob demanda
pode iniciá-lo. Sondagens `HEAD` não devem iniciar download nem anúncio. O aplicativo também
lê arquivos `.torrent` presentes na biblioteca local: sua origem e seus destinos de rede
devem ser verificados por quem os adiciona. A configuração de descoberta do motor não é
uma garantia de que um arquivo importado contenha somente destinos do ASC.

Tracker e peers recebem informações necessárias à comunicação, incluindo o endereço IP
usado na conexão e identificadores do torrent. Não há promessa de anonimato. Os serviços
HTTP ficam no loopback por padrão; habilitar LAN altera sua exposição e pode transmitir
credenciais por HTTP sem criptografia. A porta de peers é distinta das portas HTTP.
Não exponha painel, addon ou ponte à internet nem compartilhe conta ou credenciais com terceiros.

## 5. Dados locais e comunicações externas

O aplicativo mantém no diretório de dados informações de configuração, sessão, credenciais,
biblioteca, histórico operacional de seed e logs, além dos arquivos baixados. Os `.torrent`
recebidos do ASC podem conter a passkey: configurar uma passkey separada não limpa esses
arquivos. Permissões de arquivo e redação de logs reduzem riscos, mas não garantem sigilo.

As principais comunicações identificadas na implementação são:

| Destino | Finalidade e informações envolvidas |
|---|---|
| Site do ASC | Login, sessão por cookies, buscas, dados da conta e obtenção de `.torrent` |
| Cinemeta | Consulta de títulos, identificadores e metadados; o serviço recebe o IP da conexão |
| Tracker e peers | Anúncios, identificação do torrent, tráfego e transferência de partes dos arquivos |
| Webhook opcional | Eventos operacionais, contagens e horários enviados ao destino configurado; desligado por padrão |
| Plataformas de distribuição e serviços usados na instalação | Obtenção de código, dependências, binários e atualizações, conforme a forma de instalação |

Serviços externos têm suas próprias práticas e condições. Esta descrição não é uma auditoria
de todos os componentes de terceiros. Não envie senhas, cookies, passkeys, URLs com credenciais,
`.torrent` reais ou logs sem revisão em pedidos de suporte. Títulos, hashes, caminhos e horários
podem revelar hábitos mesmo quando os segredos são redigidos.

Logs têm retenção local configurável, de 14 dias por padrão, com limpeza enquanto o aplicativo
executa suas rotinas; isso não apaga cópias exportadas ou backups. Outros dados têm ciclos de
vida diferentes. Desinstalar ou revogar uma credencial não significa apagar todos os dados,
encerrar todas as sessões externas ou eliminar cópias mantidas por terceiros.
Consulte as instruções de [segurança](https://github.com/msouza10/ascstremio/blob/main/docs/seguranca.md)
e [manutenção](https://github.com/msouza10/ascstremio/blob/main/docs/manutencao.md).

## 6. Disco, seed e disponibilidade

Download e seed consomem armazenamento, banda e energia. A máquina pode precisar permanecer
ligada; o bloqueio de suspensão depende da plataforma. Fechar o player não encerra obrigações
do tracker. Freeleech não significa dispensa de seed nem autorização autoral.

O padrão `AFTER_SEED=delete` permite apagar os vídeos depois da confirmação operacional
do tracker. Outras políticas podem manter os arquivos ou o seed. Ações de retenção e limpeza
também podem remover dados quando seus requisitos forem atendidos. Confira a configuração
antes do uso e mantenha backups próprios do que precisa preservar. Reproduzir um arquivo
removido pode gerar outro download e novas obrigações no tracker.

Falhas de software, disco, rede, energia ou serviços externos podem interromper reprodução,
download, registro de estatísticas ou seed. Não há garantia de disponibilidade contínua,
compatibilidade permanente, correção de todo defeito ou recuperação de arquivos.

## 7. Garantias e limites de responsabilidade

Aplicam-se as condições de fornecimento, garantia e responsabilidade da [licença MIT](LICENSE),
na extensão permitida pela legislação aplicável. O projeto não promete adequação a uma
finalidade específica, resultado jurídico, autorização sobre conteúdo ou ausência de sanções.

Nenhuma disposição deste aviso afasta direitos irrenunciáveis, deveres legais ou responsabilidades
que não possam ser excluídos ou limitados. As orientações ao usuário não transferem automaticamente
a ele responsabilidades próprias de autores, distribuidores ou outras pessoas. Este documento
não vincula titulares de direitos que não sejam partes de eventual relação contratual e não
constitui isenção geral de responsabilidade civil, penal ou administrativa.

## 8. Contato, reclamações e segurança

O mantenedor identificado no repositório é `msouza10`. Questões gerais e alegações sobre materiais
publicados pelo projeto podem ser encaminhadas pelas
[issues do repositório](https://github.com/msouza10/ascstremio/issues), com identificação do material,
localização pública, descrição objetiva e indicação da titularidade ou representação alegada.
Esse canal é público: não inclua dados pessoais desnecessários, material restrito ou segredos.
Ainda não há canal jurídico privado específico documentado; não envie material sensível por issue.

Relatos de vulnerabilidade seguem a
[política de segurança](https://github.com/msouza10/ascstremio/blob/main/.github/SECURITY.md).
O canal de vulnerabilidades não substitui um canal jurídico geral. Solicitações serão avaliadas
conforme o caso e os deveres aplicáveis, sem garantia de prazo voluntário. O projeto pode atuar
sobre seus próprios materiais e distribuições; não dispõe de controle remoto para apagar arquivos
nas instalações pessoais ou remover conteúdo de serviços de terceiros.

## 9. Alcance deste aviso

Este aviso explica o funcionamento e os limites conhecidos da distribuição. Sua leitura ou uma
eventual confirmação de ciência não comprova autorização sobre conteúdo nem afasta direitos de
terceiros. Ele não modifica a MIT, não impõe foro exclusivo e não pretende substituir leis
obrigatórias ou análise jurídica do caso concreto. Mudanças relevantes devem ser identificadas
em nova versão do aviso, sem presumir concordância retroativa.

Referências brasileiras: [Lei de Direitos Autorais](https://www.planalto.gov.br/ccivil_03/leis/l9610.htm),
[Código Civil](https://www.planalto.gov.br/ccivil_03/leis/2002/l10406compilada.htm),
[Código de Defesa do Consumidor](https://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm),
[Marco Civil da Internet](https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2014/lei/l12965.htm)
e [LGPD](https://www2.camara.leg.br/legin/fed/lei/2018/lei-13709-14-agosto-2018-787077-normaatualizada-pl.html).
