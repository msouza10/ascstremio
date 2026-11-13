// Atividade do addon por credencial, só em memória (some ao reiniciar; é um sinal, não um registro).
//
// O Stremio não avisa quando um addon é instalado nem removido: a única prova é o que ele pede
// depois. Ler o manifesto acontece também na tela de confirmação ("Instalar?"), então só prova
// que o link foi aberto. Pedir catálogo, meta ou stream só acontece com o addon já instalado.
// Por isso o estado é conservador (fail-closed): sem pedido de catálogo/stream nunca se diz
// "instalado", e remover o addon no Stremio não é detectável (só "visto pela última vez").
// Guarda apenas ids de credencial e horários: nada de token, IP, User-Agent ou título.

const KINDS = ['manifest', 'catalog', 'meta', 'stream'];

// Classifica o caminho já sem o prefixo /<token>.
function kindOf(rest) {
  if (rest === '/manifest.json') return 'manifest';
  const m = /^\/(catalog|meta|stream)\//.exec(rest);
  return m ? m[1] : null;
}

function createAddonActivity({ now = () => Date.now() } = {}) {
  const seen = new Map();

  function record(credentialId, rest) {
    const kind = kindOf(rest);
    if (!credentialId || !kind) return;
    const entry = seen.get(credentialId) ?? {};
    entry[kind] = now();
    seen.set(credentialId, entry);
  }

  // Estados: aguardando < manifesto_lido < instalado (catálogo/meta) < em_uso (stream).
  function stateOf(entry) {
    if (!entry) return 'aguardando';
    if (entry.stream) return 'em_uso';
    if (entry.catalog || entry.meta) return 'instalado';
    if (entry.manifest) return 'manifesto_lido';
    return 'aguardando';
  }

  function get(credentialId) {
    const entry = seen.get(credentialId);
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    const times = entry ? KINDS.map((k) => entry[k]).filter(Boolean) : [];
    return {
      state: stateOf(entry),
      manifestAt: iso(entry?.manifest),
      catalogAt: iso(entry?.catalog ?? entry?.meta),
      streamAt: iso(entry?.stream),
      lastSeenAt: times.length ? iso(Math.max(...times)) : null,
    };
  }

  return { record, get };
}

module.exports = { createAddonActivity, kindOf };
