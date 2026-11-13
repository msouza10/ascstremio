# Changelog

## [0.3.0](https://github.com/msouza10/ascstremio/compare/v0.2.0...v0.3.0) (2026-11-13)


### Novidades

* **painel:** busca testável, mais rótulos e avançadas que abrem sozinhas nas configurações ([#74](https://github.com/msouza10/ascstremio/issues/74)) ([679adf1](https://github.com/msouza10/ascstremio/commit/679adf14b63516bf5b92fcd434458b5af0261fa2))
* **painel:** dê título em português às opções restantes ([#76](https://github.com/msouza10/ascstremio/issues/76)) ([20aed13](https://github.com/msouza10/ascstremio/commit/20aed134e890ba792fb0de06d661d569949c632f))
* **painel:** guarde o progresso do assistente e torne as etapas acessíveis ([#73](https://github.com/msouza10/ascstremio/issues/73)) ([05eb074](https://github.com/msouza10/ascstremio/commit/05eb07496542cc4de5a361b8774a7a77de3c0268))
* **painel:** lembre que falta instalar o addon depois de concluir o assistente ([#75](https://github.com/msouza10/ascstremio/issues/75)) ([e93c87a](https://github.com/msouza10/ascstremio/commit/e93c87abebe05b303f5141e78a9e94d5be673c4e))
* **painel:** reorganize o painel e confirme a instalação do addon no Stremio ([#72](https://github.com/msouza10/ascstremio/issues/72)) ([da81c1a](https://github.com/msouza10/ascstremio/commit/da81c1af33973a3a8d2c648de138b584674d444a))
* **painel:** revogue credenciais de instalação pelo painel ([#77](https://github.com/msouza10/ascstremio/issues/77)) ([ec9fee3](https://github.com/msouza10/ascstremio/commit/ec9fee3f9e12316d4fc1529e653104846ee89a7e))
* **painel:** substitua credenciais e mostre o último uso ([#78](https://github.com/msouza10/ascstremio/issues/78)) ([102f883](https://github.com/msouza10/ascstremio/commit/102f883caac7509532b902acbf8d574a9d0196b2))
* **seed:** permita voltar a semear pelo painel ([#79](https://github.com/msouza10/ascstremio/issues/79)) ([4ce0cb8](https://github.com/msouza10/ascstremio/commit/4ce0cb80c51abdaa0897de0336f3c165db5b27c2))


### Segurança

* remova a ferramenta avulsa de download público ([#58](https://github.com/msouza10/ascstremio/issues/58)) ([5ae1200](https://github.com/msouza10/ascstremio/commit/5ae120035bb257e98248f81c10af9cb34204a7f6))


### Documentação

* esclareça a proteção dos torrents e da passkey ([#61](https://github.com/msouza10/ascstremio/issues/61)) ([82783b2](https://github.com/msouza10/ascstremio/commit/82783b2726913509d0c87d05ee6e7938593e8276))
* reconcilie rede, credenciais e relato de vulnerabilidades ([#62](https://github.com/msouza10/ascstremio/issues/62)) ([6c2ef2e](https://github.com/msouza10/ascstremio/commit/6c2ef2ed646d12cea0bbd6a193e34885fd7c828a)), closes [#12](https://github.com/msouza10/ascstremio/issues/12)


### Esteira (CI/CD)

* **auditoria:** varre a imagem do contêiner e o instalador com o gitleaks ([#59](https://github.com/msouza10/ascstremio/issues/59)) ([568dea7](https://github.com/msouza10/ascstremio/commit/568dea7d6ba75cd5c4f2bd7a5f9cef8248400e7b)), closes [#11](https://github.com/msouza10/ascstremio/issues/11)

## [0.2.0](https://github.com/msouza10/ascstremio/compare/v0.1.1...v0.2.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* **addon:** a bridge-key deixa de valer e o manifesto sem prefixo dá 403. É preciso emitir uma credencial (npm run credenciais -- garantir) e reinstalar o addon no Stremio com a URL nova.

### Novidades

* **addon:** mantém acesso aos arquivos locais quando o ASC está indisponível ([#42](https://github.com/msouza10/ascstremio/issues/42)) ([0da9117](https://github.com/msouza10/ascstremio/commit/0da91174e0ac651d5583bae7ee3279c6c9bd36ec)), closes [#30](https://github.com/msouza10/ascstremio/issues/30)
* **alertas:** alertas operacionais por webhook com deduplicação ([#47](https://github.com/msouza10/ascstremio/issues/47)) ([560c786](https://github.com/msouza10/ascstremio/commit/560c786812ddf032f726729d2d6f22d471ad27a9)), closes [#31](https://github.com/msouza10/ascstremio/issues/31)
* **config:** centraliza configuração persistente e validação para os modos local e LAN ([#36](https://github.com/msouza10/ascstremio/issues/36)) ([6b4e796](https://github.com/msouza10/ascstremio/commit/6b4e79613f37cf43903f27f51fd3c878a682aa75)), closes [#19](https://github.com/msouza10/ascstremio/issues/19)
* **config:** configuração guiada e comandos no terminal ([#40](https://github.com/msouza10/ascstremio/issues/40)) ([38f75a3](https://github.com/msouza10/ascstremio/commit/38f75a31dcb829ab8b1c5698da3f7ccb7c43b8d6)), closes [#20](https://github.com/msouza10/ascstremio/issues/20)
* **config:** move o filtro somente freeleech do login para as configurações ([#56](https://github.com/msouza10/ascstremio/issues/56)) ([b32bd90](https://github.com/msouza10/ascstremio/commit/b32bd9059747312b619305b841e65be25dda08b5)), closes [#54](https://github.com/msouza10/ascstremio/issues/54)
* **disco:** reserva configurável e admissão única para novos downloads ([#39](https://github.com/msouza10/ascstremio/issues/39)) ([8389ae8](https://github.com/msouza10/ascstremio/commit/8389ae83bab1293cb5e79af06d0b9b822c5ae820)), closes [#26](https://github.com/msouza10/ascstremio/issues/26)
* **network:** seleciona e diagnostica o endereço anunciado aos clientes da LAN ([#38](https://github.com/msouza10/ascstremio/issues/38)) ([04d2f14](https://github.com/msouza10/ascstremio/commit/04d2f14d21e517d6143af99db3eb4b2307a73f0a)), closes [#21](https://github.com/msouza10/ascstremio/issues/21)
* **painel:** assistente pós-login e página permanente de configurações ([#43](https://github.com/msouza10/ascstremio/issues/43)) ([0b7e618](https://github.com/msouza10/ascstremio/commit/0b7e618b3ffb7acd29a76a939577a7adae2d7de8)), closes [#23](https://github.com/msouza10/ascstremio/issues/23)
* **ponte:** limita reproduções simultâneas sem contar HEAD, seeks e retentativas ([#41](https://github.com/msouza10/ascstremio/issues/41)) ([7d5563d](https://github.com/msouza10/ascstremio/commit/7d5563dcf3cb61cf314e1ab593120666aa0b81eb)), closes [#28](https://github.com/msouza10/ascstremio/issues/28)
* **ponte:** mede stalls, seeks e 504 da reprodução e traz benchmark offline ([#51](https://github.com/msouza10/ascstremio/issues/51)) ([f84daa8](https://github.com/msouza10/ascstremio/commit/f84daa8ac0d6c74b055b35a0d9c3e8a5eb394d81)), closes [#33](https://github.com/msouza10/ascstremio/issues/33)
* **ponte:** reduz o upload durante a reprodução e restaura depois ([#45](https://github.com/msouza10/ascstremio/issues/45)) ([1045bdd](https://github.com/msouza10/ascstremio/commit/1045bdd917869ceb4286816f0037752a65060bbe)), closes [#29](https://github.com/msouza10/ascstremio/issues/29)
* **rede:** diagnóstico em camadas da porta de peers ([#46](https://github.com/msouza10/ascstremio/issues/46)) ([d0eedfa](https://github.com/msouza10/ascstremio/commit/d0eedfafa808e3050f72a191f5d6a2f30b8b92aa)), closes [#34](https://github.com/msouza10/ascstremio/issues/34)
* **retencao:** retenção opcional por orçamento com prévia e execução confirmada ([#50](https://github.com/msouza10/ascstremio/issues/50)) ([e767460](https://github.com/msouza10/ascstremio/commit/e76746086c4ab58fb87d7325141060a1ab71db8a)), closes [#27](https://github.com/msouza10/ascstremio/issues/27)
* **seed:** permita decidir no painel quando parar ou excluir arquivos ([#57](https://github.com/msouza10/ascstremio/issues/57)) ([366504c](https://github.com/msouza10/ascstremio/commit/366504c37f241981e80fcbd26acf82e7f5f6fa43))
* **seed:** prioriza a retomada por risco de seed e mede o custo da verificação ([#49](https://github.com/msouza10/ascstremio/issues/49)) ([c66a8bc](https://github.com/msouza10/ascstremio/commit/c66a8bcfd4027b3a2288933871cfa158e2f41ef2)), closes [#32](https://github.com/msouza10/ascstremio/issues/32)


### Correções

* impede dois processos de usar a mesma pasta de dados ([#35](https://github.com/msouza10/ascstremio/issues/35)) ([fa9f5a2](https://github.com/msouza10/ascstremio/commit/fa9f5a2be5efe535f76e1a709ead8c59de897ac2)), closes [#25](https://github.com/msouza10/ascstremio/issues/25)
* **install:** tenta o npm ci de novo quando o download de binários nativos falha ([3867516](https://github.com/msouza10/ascstremio/commit/3867516227f96059513ac299b939bd4a03e5a104))
* **ponte:** envia o 504 sem esperar o iterador do primeiro trecho ([#53](https://github.com/msouza10/ascstremio/issues/53)) ([953fc9b](https://github.com/msouza10/ascstremio/commit/953fc9b24387b018483b73f16114f4892e6db228)), closes [#52](https://github.com/msouza10/ascstremio/issues/52)


### Segurança

* **addon:** autentica addon e reprodução por credencial de instalação revogável ([#37](https://github.com/msouza10/ascstremio/issues/37)) ([72a1ed0](https://github.com/msouza10/ascstremio/commit/72a1ed046d5fe2cadaf9c3344186aa8029eb09c7)), closes [#22](https://github.com/msouza10/ascstremio/issues/22)
* **bridge:** exige token administrativo e remove o force=1 do cleanup ([#15](https://github.com/msouza10/ascstremio/issues/15)) ([7d9dfea](https://github.com/msouza10/ascstremio/commit/7d9dfeace9b40a698a990b4d6dca503c93559bae))
* **painel:** administração opcional pela LAN com sessão própria e recuperação local ([#48](https://github.com/msouza10/ascstremio/issues/48)) ([afa9be8](https://github.com/msouza10/ascstremio/commit/afa9be870f16a9873dce0a04f5ccf4d7b4cd89c6)), closes [#24](https://github.com/msouza10/ascstremio/issues/24)


### Documentação

* reorganiza o README, separa os guias e adiciona licença e arquivos de comunidade ([#16](https://github.com/msouza10/ascstremio/issues/16)) ([8fa64c4](https://github.com/msouza10/ascstremio/commit/8fa64c4668ad9001a67cc2bce6084f9b3bcba558))


### Build e empacotamento

* novas tentativas no npm ci do instalador Windows e da imagem ([b42a33f](https://github.com/msouza10/ascstremio/commit/b42a33f7494ab18d0783eb0f59528199bc3dee6d))
* **windows:** oferece a primeira credencial do addon no instalador e no Menu Iniciar ([#55](https://github.com/msouza10/ascstremio/issues/55)) ([856a710](https://github.com/msouza10/ascstremio/commit/856a7100277436a0c6a2ebc77c9b0a5dbb3bda3a))


### Esteira (CI/CD)

* audita segredos em todo o histórico com gitleaks fixado por checksum ([#18](https://github.com/msouza10/ascstremio/issues/18)) ([598c42d](https://github.com/msouza10/ascstremio/commit/598c42d276bd928f7f7d82bced301bd8172cf652))
* auditoria de segredos do PR olha só o histórico do commit testado ([#44](https://github.com/msouza10/ascstremio/issues/44)) ([0fb7191](https://github.com/msouza10/ascstremio/commit/0fb719122d8a3348db3ecbf376d4df628771629f))
* cache dos binários nativos e npm ci com novas tentativas ([b10ca93](https://github.com/msouza10/ascstremio/commit/b10ca93085ba6a2d0367f798a61cf5a1507b88f8))
* Dependabot com títulos Conventional Commits e sem major do Node na imagem ([0f4513d](https://github.com/msouza10/ascstremio/commit/0f4513ddb1952a9f617b62df9e6c9301ad1f5c20))
* **deps:** bump actions/download-artifact from 4 to 8 ([#6](https://github.com/msouza10/ascstremio/issues/6)) ([b93cabb](https://github.com/msouza10/ascstremio/commit/b93cabb43fcb844684ce757ee88bdfc24753c64d))
* **deps:** bump actions/setup-node from 4 to 7 ([#2](https://github.com/msouza10/ascstremio/issues/2)) ([d59b1fe](https://github.com/msouza10/ascstremio/commit/d59b1feb016626a54b264a78184e2acba0111511))
* **deps:** bump docker/login-action from 3 to 4 ([#3](https://github.com/msouza10/ascstremio/issues/3)) ([fa0ac30](https://github.com/msouza10/ascstremio/commit/fa0ac3048f285b5743cdca83bee4f316266c3274))
* **deps:** bump docker/setup-buildx-action from 3 to 4 ([#5](https://github.com/msouza10/ascstremio/issues/5)) ([49acf9b](https://github.com/msouza10/ascstremio/commit/49acf9bf6bf529266b0bc04f7351255f7633b12f))
* **deps:** bump docker/setup-qemu-action from 3 to 4 ([#4](https://github.com/msouza10/ascstremio/issues/4)) ([5f5da10](https://github.com/msouza10/ascstremio/commit/5f5da10de09a64d1223e0a8f199ae308f95d5032))
* publicação baixa só os artefatos do pacote e do instalador ([7679431](https://github.com/msouza10/ascstremio/commit/76794315fadbfd58d598be5d286cce18a1be9e5f))
* release refazível por tag, sem atestado em repositório privado e sem tag latest duplicada ([97a3120](https://github.com/msouza10/ascstremio/commit/97a3120abc018dea3192cc206aac9449be3e47f2))

## [0.1.1](https://github.com/msouza10/ascstremio/compare/v0.1.0...v0.1.1) (2026-11-09)


### Documentação

* AGENTS.md com padrões de desenvolvimento, commits, release e links ([89bb0b8](https://github.com/msouza10/ascstremio/commit/89bb0b8e835daadd2d62bcf57df31b60f607cb86))


### Esteira (CI/CD)

* tag do release como vX.Y.Z (sem o nome do componente) ([7ca27ee](https://github.com/msouza10/ascstremio/commit/7ca27ee136d1810c0fba36c90ffa96110f966997))
* versão, changelog e release automáticos pelos commits (release-please), imagem no GHCR ([68d9a2a](https://github.com/msouza10/ascstremio/commit/68d9a2a9d521192443ea6feff718ecfb6383d343))
