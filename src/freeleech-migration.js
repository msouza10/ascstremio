// Migração única do filtro "somente freeleech" (issue #54). Versões antigas guardavam a escolha do
// login em asc-session.json (`onlyFreeleech`); agora ela é a configuração ASC_ONLY_FREELEECH.
//
// Regras:
//   - só migra o valor `false` (o padrão "ligado" não precisa de arquivo);
//   - só se não houver configuração própria (nem ambiente nem settings.json): quem já escolheu
//     ali manda, e o valor antigo é descartado;
//   - escreve por settings.update (trava da instância já detida pelo processo, expectedRevision,
//     escrita atômica) e só então tira o campo antigo da sessão, de modo que uma segunda partida
//     não repete nada;
//   - se não conseguir gravar, não reverte em silêncio: avisa no log, mantém o campo antigo na
//     sessão (tenta de novo na próxima partida) e o filtro fica no padrão seguro (ligado).

const settings = require('./settings');

const KEY = 'ASC_ONLY_FREELEECH';

// client: AscClient já carregado (load()). Devolve { migrated, reason, value? }.
async function migrateLegacyFreeleech({ client, dataDir, env, log = { info() {}, warn() {} } }) {
  if (client.legacyOnlyFreeleech !== false) return { migrated: false, reason: 'sem valor antigo' };
  const snap = settings.resolve({ dataDir, env });
  if (!snap.ok) return { migrated: false, reason: 'configuração com problemas' };
  if (snap.sources[KEY] !== 'default') {
    client.legacyOnlyFreeleech = null;
    await client.save().catch(() => {});
    log.info(`filtro freeleech: ${KEY} já está configurada (${snap.sources[KEY] === 'env' ? 'ambiente' : 'settings.json'}); o valor antigo da sessão foi descartado`);
    return { migrated: false, reason: 'configuração existente prevalece' };
  }
  try {
    const out = settings.update({ dataDir, env, changes: { [KEY]: false }, expectedRevision: snap.revision });
    client.legacyOnlyFreeleech = null;
    await client.save();
    log.info(`filtro freeleech: escolha antiga (todos os releases) migrada para o settings.json (${KEY}=false)`);
    return { migrated: true, value: out.snapshot.values[KEY] };
  } catch (error) {
    log.warn(`filtro freeleech: não foi possível migrar a escolha antiga para o settings.json (${error?.message ?? error}); o filtro ficou ligado (padrão). Ajuste em Configurações.`);
    return { migrated: false, reason: 'falha ao gravar' };
  }
}

module.exports = { migrateLegacyFreeleech };
