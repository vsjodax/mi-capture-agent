// Service worker (Manifest V3) — único lugar que fala com o backend do
// VERYS Connect. Nunca fala com o Menu Integrado além de observar o que a
// própria aba já fez (via content-script.js/page-hook.js).

const STORAGE_KEYS = {
  config: 'verys_mi_config', // { miUrlPattern, ingestUrl, token }
  stats: 'verys_mi_stats', // { pedidosHoje, enviados, falhas, ultimoEnvioEm, diaReferencia }
  // CORREÇÃO v1.6.7 (2026-10-19): enviarParaIngest só checava
  // resposta.ok (Response.ok do fetch — true pra QUALQUER status
  // 200-299) e, em falha, só incrementava `falhas` + console.error — o
  // payload era descartado ali mesmo, sem nenhuma retentativa. Mapa
  // { [uuid]: {payload, tentativas, primeiraFalhaEm, ultimaTentativaEm, ultimoMotivo} }
  // — nunca é a mesma coisa que uma "quarentena de auditoria" (não existe
  // nesta versão): aqui é só "ainda não confirmou sucesso, tentar de novo".
  pendentes: 'verys_mi_pendentes',
  // v1.7.0 — sinal de funcionamento (ver enviarSinal):
  agente: 'verys_mi_agente_id', // id aleatório desta instalação (não identifica pessoa)
  painel: 'verys_mi_painel', // { abas: {[tabId]: {vistoEm, paginaLogin}}, ultimaRespostaOkEm, ultimaFalhaSessaoEm, respostasOk: [{em, n}] }
  observados: 'verys_mi_observados', // { [idPedidoMi]: { vistoEm, marca } } — últimas 24 h, só id e marca
  ultimoSinal: 'verys_mi_ultimo_sinal', // { em, ok, motivo, situacao (resposta do VERYS) }
  // v1.8.0 — consulta automática do detalhe (ver escolherConsultas):
  // { modelo, pausaAte, pausaMotivo, pedidos: {[id]: {...}}, consultas: [{em, ok, motivo}] }
  sync: 'verys_mi_sync',
};

const ALARME_RETENTATIVA = 'verys_mi_retry_pendentes';
const INTERVALO_RETENTATIVA_MINUTOS = 5;

const ALARME_SINAL = 'verys_mi_sinal';
const INTERVALO_SINAL_MINUTOS = 2;
const ABA_PRESENTE_MS = 3 * 60 * 1000; // presença é informada a cada 1 min
const JANELA_RESPOSTAS_MS = 30 * 60 * 1000;
const JANELA_OBSERVADOS_MS = 24 * 60 * 60 * 1000;
const MAX_OBSERVADOS = 500;

// Leitura-modificação-escrita do chrome.storage em série: mensagens de abas
// diferentes chegam ao mesmo tempo e não podem sobrescrever uma à outra.
let filaStorage = Promise.resolve();
function emSerie(fn) {
  const p = filaStorage.then(fn, fn);
  filaStorage = p.catch(() => {});
  return p;
}

async function lerChave(chave, padrao) {
  const { [chave]: valor } = await chrome.storage.local.get(chave);
  return valor ?? padrao;
}

async function getConfig() {
  const { [STORAGE_KEYS.config]: config } = await chrome.storage.local.get(STORAGE_KEYS.config);
  return config || null;
}

async function getStats() {
  const { [STORAGE_KEYS.stats]: stats } = await chrome.storage.local.get(STORAGE_KEYS.stats);
  const hoje = new Date().toISOString().slice(0, 10);
  if (!stats || stats.diaReferencia !== hoje) {
    return { pedidosHoje: 0, enviados: 0, falhas: 0, ultimoEnvioEm: null, diaReferencia: hoje };
  }
  return stats;
}

async function atualizarStats(patch) {
  const atual = await getStats();
  const novo = { ...atual, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.stats]: novo });
  return novo;
}

async function getPendentes() {
  const { [STORAGE_KEYS.pendentes]: pendentes } = await chrome.storage.local.get(STORAGE_KEYS.pendentes);
  return pendentes || {};
}

async function salvarPendentes(pendentes) {
  await chrome.storage.local.set({ [STORAGE_KEYS.pendentes]: pendentes });
}

async function marcarPendente(payload, motivo) {
  if (!payload?.id) return; // sem id não há como indexar/retentar depois
  const pendentes = await getPendentes();
  const atual = pendentes[payload.id];
  pendentes[payload.id] = {
    payload,
    tentativas: (atual?.tentativas ?? 0) + 1,
    primeiraFalhaEm: atual?.primeiraFalhaEm ?? new Date().toISOString(),
    ultimaTentativaEm: new Date().toISOString(),
    ultimoMotivo: motivo,
  };
  await salvarPendentes(pendentes);
}

async function removerPendente(uuid) {
  const pendentes = await getPendentes();
  if (pendentes[uuid]) {
    delete pendentes[uuid];
    await salvarPendentes(pendentes);
  }
}

async function garantirAlarmeRetentativa() {
  const existente = await chrome.alarms.get(ALARME_RETENTATIVA);
  if (!existente) {
    chrome.alarms.create(ALARME_RETENTATIVA, { periodInMinutes: INTERVALO_RETENTATIVA_MINUTOS });
  }
}

// Faz UMA tentativa de envio, sem decidir nada sobre pendência/stats —
// isso fica a cargo de enviarParaIngest (chamada tanto pela captura ao
// vivo quanto pela retentativa periódica, nunca duplicada entre as duas).
//
// Sucesso exige os DOIS sinais, nunca só um: status HTTP 2xx (resposta.ok)
// E o corpo JSON sem `ok: false`. Achado real 2026-10-19: o
// ingest-mi-order passou a devolver status 207 pra sincronização
// parcial — mas 207 está dentro do intervalo 200-299, então
// `Response.ok` (spec do fetch: `status >= 200 && status <= 299`) é
// `true` pra 207 também. Confiar só em resposta.ok teria registrado
// sucesso indevido numa falha real. Por isso o ingest-mi-order foi
// corrigido pra usar 422 (fora de 2xx) nesse caso — mas esta função NUNCA
// depende só disso: lê o corpo e trata `ok: false` como falha mesmo que,
// por qualquer motivo futuro, o status HTTP volte a ser 2xx por engano.
// Corpo ausente/não-JSON/sem o campo `ok` NUNCA é tratado como falha só
// por isso (ex.: token inválido pode devolver um corpo diferente) — só o
// campo `ok` explicitamente `false` conta.
async function tentarEnviar(payload, config) {
  try {
    const resposta = await fetch(config.ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(payload),
    });

    const corpoTexto = await resposta.text();
    let corpoJson = null;
    try {
      corpoJson = JSON.parse(corpoTexto);
    } catch {
      // corpo não é JSON — segue só com resposta.ok, nunca trata como
      // falha por não conseguir parsear.
    }

    const corpoIndicaFalha = corpoJson && corpoJson.ok === false;
    if (resposta.ok && !corpoIndicaFalha) {
      return { enviado: true, corpo: corpoJson };
    }

    console.error('[VERYS Capture Agent] ingest-mi-order recusou ou sincronizou parcialmente o pedido:', resposta.status, corpoTexto);
    return { enviado: false, motivo: `http_${resposta.status}` };
  } catch (err) {
    console.error('[VERYS Capture Agent] Falha de rede ao enviar pedido observado:', err);
    return { enviado: false, motivo: 'erro_rede' };
  }
}

async function enviarParaIngest(payload) {
  const config = await getConfig();
  if (!config?.ingestUrl || !config?.token) {
    console.warn('[VERYS Capture Agent] Configuração ausente — pedido observado, mas não enviado. Configure em Opções.');
    return;
  }

  const resultado = await tentarEnviar(payload, config);
  if (resultado.enviado) {
    const stats = await getStats();
    await atualizarStats({ pedidosHoje: stats.pedidosHoje + 1, enviados: stats.enviados + 1, ultimoEnvioEm: new Date().toISOString() });
    await removerPendente(payload.id);
    return;
  }

  const stats = await getStats();
  await atualizarStats({ falhas: stats.falhas + 1 });
  // Nunca registra sucesso indevido e nunca descarta o pedido — fica
  // pendente até uma retentativa confirmar sucesso de verdade (ou até
  // alguém limpar manualmente, se um dia existir essa tela).
  await marcarPendente(payload, resultado.motivo);
  await garantirAlarmeRetentativa();
}

// Reprocessa tudo que está pendente — chamada pelo alarme periódico e ao
// (re)iniciar o service worker. Reaproveita enviarParaIngest (mesma
// função da captura ao vivo): sucesso remove da fila, falha atualiza
// tentativas/motivo e mantém pendente. ingest-mi-order já é idempotente
// por mi_pedido_uuid — reenviar o mesmo payload nunca duplica pedido nem
// movimentação de caixa, mesmo que uma captura ao vivo do mesmo pedido
// aconteça quase ao mesmo tempo que uma retentativa dele.
async function reprocessarPendentes() {
  const pendentes = await getPendentes();
  const uuids = Object.keys(pendentes);
  if (uuids.length === 0) return;
  for (const uuid of uuids) {
    await enviarParaIngest(pendentes[uuid].payload);
  }
}

// ---------------------------------------------------------------------------
// v1.7.0 — Sinal de funcionamento
// ---------------------------------------------------------------------------
// A cada 2 minutos a extensão diz ao VERYS, sem nenhum dado de cliente:
//   * que está viva (o próprio sinal);
//   * se há aba do painel do MI aberta e se ela está na tela de login;
//   * o horário da última resposta do painel com sessão válida e da última
//     falha de sessão (401/403/redirecionamento ao login);
//   * a fila de reenvio (quantos pedidos ainda não confirmados e desde quando);
//   * os ids dos pedidos vistos nas últimas 24 h, para o VERYS conferir que
//     cada um chegou (pedido capturado e pedido de produção).
// Ausência de pedido novo NÃO é falha (antes da abertura não há pedido): a
// prova de funcionamento é a sessão válida do painel, não o fluxo de pedidos.

async function obterAgenteId() {
  return emSerie(async () => {
    let id = await lerChave(STORAGE_KEYS.agente, null);
    if (!id) {
      id = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `ag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      await chrome.storage.local.set({ [STORAGE_KEYS.agente]: id });
    }
    return id;
  });
}

function painelVazio() {
  return { abas: {}, ultimaRespostaOkEm: null, ultimaFalhaSessaoEm: null, respostasOk: [] };
}

function maisRecente(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

async function registrarSinalPainel(tabId, estado) {
  if (!estado || typeof estado !== 'object') return;
  await emSerie(async () => {
    const painel = await lerChave(STORAGE_KEYS.painel, painelVazio());
    const agora = new Date().toISOString();
    painel.ultimaRespostaOkEm = maisRecente(painel.ultimaRespostaOkEm, typeof estado.ultimaRespostaOkEm === 'string' ? estado.ultimaRespostaOkEm : null);
    painel.ultimaFalhaSessaoEm = maisRecente(painel.ultimaFalhaSessaoEm, typeof estado.ultimaFalhaSessaoEm === 'string' ? estado.ultimaFalhaSessaoEm : null);
    const n = Number.isInteger(estado.respostasOk) && estado.respostasOk > 0 ? estado.respostasOk : 0;
    const limite = Date.now() - JANELA_RESPOSTAS_MS;
    painel.respostasOk = (painel.respostasOk || []).filter((r) => Date.parse(r.em) >= limite);
    if (n > 0) painel.respostasOk.push({ em: agora, n });
    if (tabId != null) {
      painel.abas[tabId] = { ...(painel.abas[tabId] || { paginaLogin: false }), vistoEm: agora };
    }
    // v1.7.1: estrutura das respostas (só rota mascarada e nomes de campos).
    // Fica a versão mais recente de cada rota, no máximo 40.
    if (Array.isArray(estado.rotas)) {
      painel.rotas = painel.rotas || {};
      for (const r of estado.rotas) {
        if (!r || typeof r.rota !== 'string' || typeof r.forma !== 'string') continue;
        if (!painel.rotas[r.rota] && Object.keys(painel.rotas).length >= 40) continue;
        painel.rotas[r.rota] = { rota: r.rota, vezes: Number(r.vezes) || 0, status: Number(r.status) || 0, ultimaEm: typeof r.ultimaEm === 'string' ? r.ultimaEm : null, forma: r.forma.slice(0, 4000) };
      }
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.painel]: painel });
  });
}

async function registrarPresencaPainel(tabId, paginaLogin) {
  if (tabId == null) return;
  await emSerie(async () => {
    const painel = await lerChave(STORAGE_KEYS.painel, painelVazio());
    const agora = Date.now();
    for (const [id, aba] of Object.entries(painel.abas)) {
      if (agora - Date.parse(aba.vistoEm) > 60 * 60 * 1000) delete painel.abas[id];
    }
    painel.abas[tabId] = { vistoEm: new Date(agora).toISOString(), paginaLogin: !!paginaLogin };
    await chrome.storage.local.set({ [STORAGE_KEYS.painel]: painel });
  });
}

// Marca do pedido como o VERYS a identifica (ingest-mi-order: merchant.name,
// ex.: "hiperchefpizza") — só o identificador da marca, nunca dado de cliente.
// Permite ao VERYS atribuir à loja um pedido visto que ainda não chegou lá.
function marcaDoPayload(payload) {
  const nome = payload?.merchant?.name;
  return typeof nome === 'string' && nome.trim() ? nome : null;
}

async function registrarObservado(payload) {
  const idPedido = payload?.id;
  if (typeof idPedido !== 'string' || !idPedido) return;
  await emSerie(async () => {
    const observados = await lerChave(STORAGE_KEYS.observados, {});
    observados[idPedido] = { vistoEm: new Date().toISOString(), marca: marcaDoPayload(payload) ?? observados[idPedido]?.marca ?? null };
    await chrome.storage.local.set({ [STORAGE_KEYS.observados]: podarObservados(observados, Date.now()) });
  });
}

// { [id]: { vistoEm, marca } } das últimas 24 h, mais recentes primeiro.
function podarObservados(observados, agoraMs) {
  const limite = agoraMs - JANELA_OBSERVADOS_MS;
  const vivos = Object.entries(observados)
    .filter(([, o]) => o && typeof o.vistoEm === 'string' && Date.parse(o.vistoEm) >= limite)
    .sort((a, b) => (a[1].vistoEm < b[1].vistoEm ? 1 : -1))
    .slice(0, MAX_OBSERVADOS);
  return Object.fromEntries(vivos);
}

// Monta o sinal a partir do que está guardado (função sem rede).
async function montarSinal(agoraMs) {
  const [agenteId, painel, observadosBrutos, pendentes] = await Promise.all([
    obterAgenteId(),
    lerChave(STORAGE_KEYS.painel, painelVazio()),
    lerChave(STORAGE_KEYS.observados, {}),
    getPendentes(),
  ]);
  const abasVivas = Object.values(painel.abas || {}).filter((a) => agoraMs - Date.parse(a.vistoEm) <= ABA_PRESENTE_MS);
  const limiteRespostas = agoraMs - JANELA_RESPOSTAS_MS;
  const observados = podarObservados(observadosBrutos, agoraMs);
  const pend = Object.values(pendentes);
  const versao = typeof chrome.runtime.getManifest === 'function' ? chrome.runtime.getManifest().version : null;
  return {
    tipo: 'sinal_captura',
    versaoSinal: 1,
    agenteId,
    versao,
    geradoEm: new Date(agoraMs).toISOString(),
    painel: {
      abasAbertas: abasVivas.length,
      paginaLogin: abasVivas.some((a) => a.paginaLogin),
      ultimaRespostaOkEm: painel.ultimaRespostaOkEm ?? null,
      ultimaFalhaSessaoEm: painel.ultimaFalhaSessaoEm ?? null,
      respostasOk30min: (painel.respostasOk || []).filter((r) => Date.parse(r.em) >= limiteRespostas).reduce((s, r) => s + r.n, 0),
    },
    fila: {
      pendentes: pend.length,
      maisAntigaEm: pend.reduce((min, p) => (!min || p.primeiraFalhaEm < min ? p.primeiraFalhaEm : min), null),
      // Só id e marca de cada pedido esperando reenvio (para o VERYS saber
      // de qual loja é) — nunca o pedido em si.
      itens: Object.entries(pendentes).slice(0, MAX_OBSERVADOS).map(([id, p]) => ({ id, marca: marcaDoPayload(p.payload) })),
    },
    pedidos: {
      ultimoVistoEm: Object.values(observados).reduce((max, o) => (!max || o.vistoEm > max ? o.vistoEm : max), null),
      observados: Object.entries(observados).map(([id, o]) => ({ id, vistoEm: o.vistoEm, marca: o.marca ?? null })),
    },
    // v1.7.1: estrutura das respostas do painel (sem valores) — base para
    // ler automaticamente o que o painel recebe sozinho.
    diagnostico: {
      rotas: Object.values(painel.rotas || {}).sort((a, b) => b.vezes - a.vezes).slice(0, 40),
    },
  };
}

// O VERYS responde ao sinal com a situação da captura que ELE conferiu
// (painel, sessão, fila e pedidos registrados/atualizados, por loja). É isso
// que o popup mostra como "sincronização comprovada" — nunca uma conclusão
// tirada só do lado da extensão.
async function enviarSinal() {
  const config = await getConfig();
  if (!config?.ingestUrl || !config?.token) return;
  // Momento do ENVIO: a autorização de consultor conta a partir daqui (nunca
  // da chegada da resposta) — assim ela expira antes, em tempo real, do
  // instante em que o VERYS registrou o sinal + 3,5 min, que é o que o VERYS
  // usa para calcular a espera de quem assume. Independe do relógio local.
  const enviadoEm = Date.now();
  const sinal = await montarSinal(enviadoEm);
  const resultado = await tentarEnviar(sinal, config);
  const situacao = resultado.enviado && resultado.corpo && typeof resultado.corpo.situacao === 'object' ? resultado.corpo.situacao : null;
  if (resultado.enviado && Array.isArray(resultado.corpo?.paraConferir)) {
    await registrarParaConferir(resultado.corpo.paraConferir);
    agendarRodada();
  }
  // v1.8.3: o VERYS indica UM agente consultor (os outros só capturam o que o
  // painel mostra). A autorização vale CONFIRMACAO_CONSULTOR_MS (3,5 min) a
  // partir do envio, menos que os 4 min que o VERYS espera para passar a vez:
  // quem perde contato para de consultar ANTES de o outro começar — nunca dois
  // juntos. Sem resposta, ou resposta sem `consultor` (VERYS antigo, falha de
  // leitura), nada é renovado: a autorização expira e o agente aguarda nova
  // confirmação, mesmo sozinho.
  if (resultado.enviado && resultado.corpo && typeof resultado.corpo === 'object') {
    const { consultor, agentesAtivos } = resultado.corpo;
    if (typeof consultor === 'boolean' || (Number.isInteger(agentesAtivos) && agentesAtivos > 0)) {
      await emSerie(async () => {
        const s = await lerSync();
        const agora = Date.now();
        if (typeof consultor === 'boolean') {
          const jaEraConsultor = s.consultor === true && s.consultorAte && Date.parse(s.consultorAte) > agora;
          if (consultor && !jaEraConsultor) {
            // Passou a ser consultor: espera a confirmação de quem consultava
            // antes expirar (aguardarMs do VERYS) — troca sem sobreposição.
            const aguardar = Number.isFinite(resultado.corpo.aguardarMs) ? Math.min(Math.max(resultado.corpo.aguardarMs, 0), CONFIRMACAO_CONSULTOR_MS) : 0;
            s.consultarApos = new Date(agora + aguardar).toISOString();
          }
          if (!consultor) s.consultarApos = null;
          s.consultor = consultor;
          s.consultorAte = new Date(enviadoEm + CONFIRMACAO_CONSULTOR_MS).toISOString();
        }
        if (Number.isInteger(agentesAtivos) && agentesAtivos > 0) {
          s.agentesAtivos = agentesAtivos;
          s.agentesAtivosAte = new Date(agora + MEMORIA_AGENTES_MS).toISOString();
        }
        await chrome.storage.local.set({ [STORAGE_KEYS.sync]: s });
      });
    }
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.ultimoSinal]: { em: new Date().toISOString(), ok: resultado.enviado, motivo: resultado.motivo ?? null, situacao },
  });
}

// ---------------------------------------------------------------------------
// v1.8.0 — Consulta automática do detalhe (sincronização sem abrir o pedido)
// ---------------------------------------------------------------------------
// Achado de 20/11/2026: com o painel aberto e sem interação, nenhum pedido
// novo nem mudança (status, motoboy, pagamento) chegava ao VERYS — só o
// DETALHE traz o pedido completo, e ele só era carregado quando alguém abria
// o pedido. Agora o service worker pede ao painel (aba logada) a consulta de
// LEITURA do detalhe dos pedidos em andamento, com frequência controlada:
//   * pedido novo na lista, ou que mudou na lista → consulta já;
//   * pedido em andamento sem consulta há REFRESH_MIN → consulta de novo
//     (motoboy/pagamento podem mudar sem a lista mudar);
//   * entregue/cancelado já consultado → para de consultar;
//   * no máximo MAX_POR_RODADA por minuto (o painel espaça 2,5 s entre elas);
//   * 401/403 (sessão) → pausa 10 min; 429/5xx → pausa 5 min; falha de um
//     pedido → espera 2^n min (até 16) para tentar ele de novo.
// Nunca altera pedido: só GET no endereço de detalhe que o próprio painel usa.
const ALARME_CONSULTA = 'verys_mi_consulta';
const INTERVALO_CONSULTA_MINUTOS = 1;
const MAX_POR_RODADA = 6;
const REFRESH_MIN = 4;
const JANELA_ANDAMENTO_MS = 12 * 60 * 60 * 1000;
const JANELA_REFRESH_MS = 6 * 60 * 60 * 1000; // = pedido_em_andamento_horas da jornada
const PAUSA_SESSAO_MS = 10 * 60 * 1000;
const PAUSA_LIMITE_MS = 5 * 60 * 1000; // 429
const PAUSA_SERVIDOR_MS = 2 * 60 * 1000; // 5xx
const PAUSA_SEM_CONEXAO_MS = 60 * 1000; // erro de rede: tenta de novo logo
const MAX_PEDIDOS_SYNC = 400;
const MAX_INCERTOS_POR_RODADA = 2;
// Pedidos que o VERYS pede para conferir (em andamento lá, sem sincronizar):
// consultados mesmo fora das janelas acima — é a recuperação depois de queda.
const JANELA_CONFERIR_MS = 72 * 60 * 60 * 1000;
const RECONFERIR_MS = 15 * 60 * 1000;
const MAX_PARA_CONFERIR = 100;
// Consultor único (v1.8.3): confirmação vale 3,5 min (< 4 min do VERYS para
// passar a vez); número de agentes ativos lembrado por 30 min.
const CONFIRMACAO_CONSULTOR_MS = 3.5 * 60 * 1000;
const MEMORIA_AGENTES_MS = 30 * 60 * 1000;

// Pode consultar o MI agora? Só com autorização de consultor VÁLIDA, em
// qualquer caso (sozinho ou com outros computadores):
//   * 'outro_consultor'         → VERYS disse "não é você" (recente);
//   * 'aguardando_confirmacao'  → nunca autorizado, ou a autorização expirou
//                                  (sem resposta do VERYS): espera o próximo sinal;
//   * 'aguardando_troca'        → autorizado, mas a autorização do consultor
//                                  anterior ainda pode estar valendo;
//   * 'ok'                      → consulta.
// Sem consulta, a captura do que o painel mostra continua; o que ficar parado
// é recuperado pela lista "para conferir" quando a autorização voltar.
function situacaoConsultor(sync, agoraMs) {
  const valida = !!sync.consultorAte && Date.parse(sync.consultorAte) > agoraMs;
  if (!valida) return 'aguardando_confirmacao';
  if (sync.consultor !== true) return 'outro_consultor';
  if (sync.consultarApos && Date.parse(sync.consultarApos) > agoraMs) return 'aguardando_troca';
  return 'ok';
}

function podeConsultarAgora(sync, agoraMs) {
  return situacaoConsultor(sync, agoraMs) === 'ok';
}

function syncVazio() {
  return { modelo: null, pausaAte: null, pausaMotivo: null, pedidos: {}, consultas: [] };
}

const idValido = (id) => typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);

function podarSync(sync, agoraMs) {
  const limite = agoraMs - JANELA_ANDAMENTO_MS;
  const recente = (p) => [p.listaEm, p.detalheEm, p.criadoEm].some((t) => t && Date.parse(t) >= limite)
    || (p.conferirEm && Date.parse(p.conferirEm) >= agoraMs - JANELA_CONFERIR_MS);
  const vivos = Object.entries(sync.pedidos || {})
    .filter(([, p]) => recente(p))
    .sort((a, b) => ((a[1].listaEm || a[1].detalheEm || '') < (b[1].listaEm || b[1].detalheEm || '') ? 1 : -1))
    .slice(0, MAX_PEDIDOS_SYNC);
  sync.pedidos = Object.fromEntries(vivos);
  sync.consultas = (sync.consultas || []).filter((c) => Date.parse(c.em) >= agoraMs - JANELA_RESPOSTAS_MS).slice(-200);
  return sync;
}

// Função pura: quais pedidos consultar agora (mais urgentes primeiro).
function escolherConsultas(sync, agoraMs) {
  if (sync.pausaAte && Date.parse(sync.pausaAte) > agoraMs) return [];
  const limite = agoraMs - JANELA_ANDAMENTO_MS;
  const candidatos = [];
  for (const [id, p] of Object.entries(sync.pedidos || {})) {
    if (p.final) continue;
    const espera = p.falhas > 0 ? Math.min(2 ** p.falhas, 16) * 60 * 1000 : 0;
    if (p.buscaEm && agoraMs - Date.parse(p.buscaEm) < Math.max(espera, 60 * 1000)) continue;
    // Pedido que o VERYS pediu para conferir e ainda não foi consultado depois
    // do pedido: vai na frente, sem limite de idade.
    if (p.conferirEm && (!p.detalheEm || p.detalheEm < p.conferirEm)) {
      candidatos.push({ id, codigo: p.codigo ?? null, prioridade: 0, ref: p.conferirEm, incerto: false });
      continue;
    }
    if (p.criadoEm && Date.parse(p.criadoEm) < limite) continue;
    const semDetalhe = !p.detalheEm;
    const mudou = p.mudouEm && (!p.detalheEm || p.detalheEm < p.mudouEm);
    const velho = p.detalheEm && agoraMs - Date.parse(p.detalheEm) >= REFRESH_MIN * 60 * 1000
      && (!p.criadoEm || Date.parse(p.criadoEm) >= agoraMs - JANELA_REFRESH_MS);
    if (semDetalhe || mudou) candidatos.push({ id, codigo: p.codigo ?? null, prioridade: 0, ref: p.mudouEm || p.listaEm || '', incerto: !!p.incerto });
    else if (velho) candidatos.push({ id, codigo: p.codigo ?? null, prioridade: 1, ref: p.detalheEm, incerto: !!p.incerto });
  }
  // Confirmados antes dos incertos (achados só em HTML/push); no máximo
  // MAX_INCERTOS_POR_RODADA incertos por rodada.
  candidatos.sort((a, b) => a.prioridade - b.prioridade || Number(a.incerto) - Number(b.incerto) || (a.prioridade === 0 ? (a.ref < b.ref ? 1 : -1) : (a.ref < b.ref ? -1 : 1)));
  const escolhidos = [];
  let incertos = 0;
  for (const c of candidatos) {
    if (escolhidos.length >= MAX_POR_RODADA) break;
    if (c.incerto && incertos >= MAX_INCERTOS_POR_RODADA) continue;
    if (c.incerto) incertos += 1;
    escolhidos.push({ id: c.id, codigo: c.codigo });
  }
  return escolhidos;
}

async function lerSync() {
  return lerChave(STORAGE_KEYS.sync, syncVazio());
}

async function registrarLista(itens) {
  if (!Array.isArray(itens)) return;
  await emSerie(async () => {
    const sync = await lerSync();
    const agora = new Date().toISOString();
    for (const it of itens.slice(0, 300)) {
      if (!it || !idValido(it.id)) continue;
      const p = sync.pedidos[it.id] || { falhas: 0, incerto: !!it.incerto };
      if (p.descartado) continue;
      const assinatura = typeof it.assinatura === 'string' ? it.assinatura.slice(0, 32) : null;
      if (!p.listaEm || (assinatura && p.assinatura !== assinatura)) p.mudouEm = agora;
      p.assinatura = assinatura;
      p.listaEm = agora;
      if (typeof it.codigo === 'string') p.codigo = it.codigo.slice(0, 32);
      if (typeof it.marca === 'string') p.marca = it.marca.slice(0, 120);
      if (typeof it.criadoEm === 'string' && !p.criadoEm) p.criadoEm = it.criadoEm.slice(0, 40);
      sync.pedidos[it.id] = p;
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.sync]: podarSync(sync, Date.now()) });
  });
}

// Pedido completo recebido (do painel ou da consulta): conta como detalhe.
async function registrarDetalhe(payload) {
  if (!payload || !idValido(payload.id)) return;
  await emSerie(async () => {
    const sync = await lerSync();
    const p = sync.pedidos[payload.id] || { falhas: 0 };
    p.detalheEm = new Date().toISOString();
    p.falhas = 0;
    p.incerto = false; // detalhe de pedido confirmado
    if (typeof payload.displayId === 'string' || typeof payload.displayId === 'number') p.codigo = String(payload.displayId).slice(0, 32);
    if (typeof payload.createdAt === 'string') p.criadoEm = payload.createdAt.slice(0, 40);
    const marca = marcaDoPayload(payload);
    if (marca) p.marca = marca;
    const entregue = Array.isArray(payload.statusHistory) && payload.statusHistory.some((h) => h && h.status === 'Entregue');
    p.final = !!payload.cancelled || entregue;
    sync.pedidos[payload.id] = p;
    await chrome.storage.local.set({ [STORAGE_KEYS.sync]: podarSync(sync, Date.now()) });
  });
}

// Lista que o VERYS devolve na resposta do sinal: pedidos em andamento lá sem
// sincronização recente (ex.: os que ficaram parados numa queda). Só ids do MI.
async function registrarParaConferir(lista) {
  if (!Array.isArray(lista)) return;
  await emSerie(async () => {
    const sync = await lerSync();
    const agoraMs = Date.now();
    const agora = new Date(agoraMs).toISOString();
    // Lista COMPLETA (abaixo do teto do VERYS): o que ficou de fora já foi
    // sincronizado (por este ou por outro computador) — sai da conferência.
    // Achado no teste com dois computadores: o que assumiu re-consultava os
    // pedidos que o outro já tinha recuperado.
    if (lista.length < MAX_PARA_CONFERIR) {
      const naLista = new Set(lista.map((item) => (typeof item === 'string' ? item : item?.id)));
      for (const [id, p] of Object.entries(sync.pedidos || {})) {
        if (p.conferirEm && !naLista.has(id)) {
          p.conferirEm = null;
          // Entrou só pela lista do VERYS (nunca visto no painel): resolvido.
          if (!p.detalheEm && !p.listaEm) p.final = true;
        }
      }
    }
    for (const item of lista.slice(0, MAX_PARA_CONFERIR)) {
      const id = typeof item === 'string' ? item : item?.id;
      if (!idValido(id)) continue;
      const p = sync.pedidos[id] || { falhas: 0 };
      if (p.descartado) continue;
      const jaConferido = p.detalheEm && (!p.conferirEm || p.detalheEm >= p.conferirEm);
      if (!p.conferirEm || (jaConferido && agoraMs - Date.parse(p.detalheEm) >= RECONFERIR_MS)) {
        p.conferirEm = agora;
        p.final = false;
      }
      p.incerto = false;
      if (typeof item?.marca === 'string') p.marca = item.marca.slice(0, 120);
      sync.pedidos[id] = p;
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.sync]: podarSync(sync, agoraMs) });
  });
}

async function registrarModelo(modelo) {
  if (!modelo || typeof modelo.url !== 'string' || !['uuid', 'code'].includes(modelo.campo)) return;
  let u;
  try { u = new URL(modelo.url.split('{id}').join('x')); } catch { return; }
  const host = u.hostname;
  if (!(host === 'menuintegrado.com.br' || host.endsWith('.menuintegrado.com.br')) || !modelo.url.includes('{id}')) return;
  await emSerie(async () => {
    const sync = await lerSync();
    // Modelo padrão (montado da conta do painel) nunca substitui um modelo
    // aprendido de um detalhe real.
    if (modelo.padrao && sync.modelo && !sync.modelo.padrao) return;
    sync.modelo = { url: modelo.url.slice(0, 300), campo: modelo.campo, padrao: !!modelo.padrao, aprendidoEm: new Date().toISOString() };
    await chrome.storage.local.set({ [STORAGE_KEYS.sync]: sync });
  });
}

async function registrarResultadoConsulta(msg) {
  if (!msg || !idValido(msg.id)) return;
  await emSerie(async () => {
    const sync = await lerSync();
    const agoraMs = Date.now();
    const agora = new Date(agoraMs).toISOString();
    const status = Number(msg.status) || 0;
    const ok = !!msg.reconhecido;
    const p = sync.pedidos[msg.id] || { falhas: 0 };
    p.buscaEm = agora;
    // Falha atribuída AO PEDIDO só quando o MI respondeu e não deu para ler
    // (404, formato). Sessão, limite, servidor e rede são pausa geral: depois
    // de uma queda, todos voltam juntos, sem espera acumulada por pedido.
    const geral = msg.motivo === 'sem_modelo' || msg.motivo === 'erro_rede' || status === 401 || status === 403 || status === 429 || status >= 500;
    if (!ok && !geral) p.falhas = Math.min((p.falhas || 0) + 1, 4);
    // Id achado só em HTML/push (incerto) cuja consulta não trouxe pedido: não
    // é pedido — descartado, nunca mais consultado.
    if (!ok && !geral && p.incerto) { p.final = true; p.descartado = true; }
    if (!ok && geral && msg.motivo !== 'sem_modelo') p.buscaEm = null;
    sync.pedidos[msg.id] = p;
    if (status === 401 || status === 403) {
      sync.pausaAte = new Date(agoraMs + PAUSA_SESSAO_MS).toISOString();
      sync.pausaMotivo = 'sessao_mi';
    } else if (status === 429 || status >= 500) {
      sync.pausaAte = new Date(agoraMs + (status === 429 ? PAUSA_LIMITE_MS : PAUSA_SERVIDOR_MS)).toISOString();
      sync.pausaMotivo = `mi_http_${status}`;
    } else if (msg.motivo === 'erro_rede') {
      sync.pausaAte = new Date(agoraMs + PAUSA_SEM_CONEXAO_MS).toISOString();
      sync.pausaMotivo = 'sem_conexao';
    }
    sync.consultas = [...(sync.consultas || []), { em: agora, ok, motivo: ok ? null : (typeof msg.motivo === 'string' ? msg.motivo.slice(0, 40) : 'erro') }];
    await chrome.storage.local.set({ [STORAGE_KEYS.sync]: podarSync(sync, agoraMs) });
  });
}

// Aba do painel para fazer a consulta: a vista mais recentemente, fora do login.
function escolherAba(painel, agoraMs) {
  const abas = Object.entries(painel.abas || {})
    .filter(([, a]) => !a.paginaLogin && agoraMs - Date.parse(a.vistoEm) <= ABA_PRESENTE_MS)
    .sort((a, b) => (a[1].vistoEm < b[1].vistoEm ? 1 : -1));
  return abas.length ? Number(abas[0][0]) : null;
}

let rodadaEmAndamento = false;
async function rodadaDeConsulta() {
  if (rodadaEmAndamento || !chrome.tabs?.sendMessage) return;
  rodadaEmAndamento = true;
  try {
    const agoraMs = Date.now();
    const [sync, painel] = await Promise.all([lerSync(), lerChave(STORAGE_KEYS.painel, painelVazio())]);
    // Limite GLOBAL: no máximo MAX_POR_RODADA consultas em qualquer janela de
    // 60 s, somando as rodadas do alarme e as disparadas pela lista (achado no
    // teste de 21/11: só o limite por rodada deixava passar 17 num minuto).
    if (!podeConsultarAgora(sync, agoraMs)) return;
    const pedidasNoMinuto =(sync.pedidasEm || []).filter((em) => agoraMs - Date.parse(em) < 60 * 1000).length;
    const vagas = MAX_POR_RODADA - pedidasNoMinuto;
    if (vagas <= 0) {
      // Achado no teste de 21/11: o alarme de 1 min caía segundos ANTES de o
      // lote anterior sair da janela de 60 s, a rodada era pulada e o ritmo
      // real ficava ~3/min. Se a vaga abre em até 30 s, reagenda para ela.
      const espera = msAteProximaVaga(sync, agoraMs);
      if (espera !== null && espera <= 30 * 1000) agendarRodada(espera + 500);
      return;
    }
    const pedidos = escolherConsultas(sync, agoraMs).slice(0, vagas);
    if (pedidos.length === 0) return;
    const aba = escolherAba(painel, agoraMs);
    if (aba == null || Number.isNaN(aba)) return;
    // Marca como "em consulta" antes de pedir, para a próxima rodada não
    // repetir o mesmo pedido se a resposta demorar.
    await emSerie(async () => {
      const s = await lerSync();
      const em = new Date(agoraMs).toISOString();
      for (const { id } of pedidos) if (s.pedidos[id]) s.pedidos[id].buscaEm = em;
      s.pedidasEm = [...(s.pedidasEm || []).filter((x) => agoraMs - Date.parse(x) < 60 * 1000), ...pedidos.map(() => em)];
      await chrome.storage.local.set({ [STORAGE_KEYS.sync]: s });
    });
    await chrome.tabs.sendMessage(aba, { type: 'buscar_detalhes', pedidos, modelo: sync.modelo ?? null }).catch(() => {});
  } finally {
    rodadaEmAndamento = false;
  }
}

let rodadaAgendada = null;
function agendarRodada(atrasoMs = 3000) {
  if (rodadaAgendada) return;
  rodadaAgendada = setTimeout(() => { rodadaAgendada = null; rodadaDeConsulta(); }, atrasoMs);
}

// Quanto falta para a consulta mais antiga da janela de 60 s sair dela (e abrir
// uma vaga). null = já há vaga ou nada registrado.
function msAteProximaVaga(sync, agoraMs) {
  const recentes = (sync.pedidasEm || []).map((em) => Date.parse(em)).filter((ms) => agoraMs - ms < 60 * 1000).sort((a, b) => a - b);
  if (recentes.length < MAX_POR_RODADA) return null;
  return Math.max(0, recentes[recentes.length - MAX_POR_RODADA] + 60 * 1000 - agoraMs);
}

// Ao iniciar: pedidos já vistos (observados, até 12 h) entram no controle da
// consulta, para que os que ficaram parados no VERYS antes da v1.8.0 — ou que
// já saíram da lista aberta do MI — sejam conferidos até o status final.
async function importarObservados() {
  await emSerie(async () => {
    const [sync, observados] = await Promise.all([lerSync(), lerChave(STORAGE_KEYS.observados, {})]);
    const limite = Date.now() - JANELA_ANDAMENTO_MS;
    let novos = 0;
    for (const [id, o] of Object.entries(observados)) {
      if (!idValido(id) || sync.pedidos[id] || !o || Date.parse(o.vistoEm) < limite) continue;
      sync.pedidos[id] = { falhas: 0, detalheEm: o.vistoEm, marca: o.marca ?? null };
      novos += 1;
    }
    if (novos > 0) await chrome.storage.local.set({ [STORAGE_KEYS.sync]: podarSync(sync, Date.now()) });
  });
}

async function garantirAlarmeConsulta() {
  const existente = await chrome.alarms.get(ALARME_CONSULTA);
  if (!existente) {
    chrome.alarms.create(ALARME_CONSULTA, { periodInMinutes: INTERVALO_CONSULTA_MINUTOS });
  }
}

// Resumo para o sinal/popup (sem dado de cliente).
function resumoConsulta(sync, agoraMs) {
  const consultas = (sync.consultas || []).filter((c) => Date.parse(c.em) >= agoraMs - JANELA_RESPOSTAS_MS);
  const andamento = Object.values(sync.pedidos || {}).filter((p) => !p.final && !p.incerto && (!p.criadoEm || Date.parse(p.criadoEm) >= agoraMs - JANELA_ANDAMENTO_MS));
  const ultimaOk = consultas.filter((c) => c.ok).reduce((m, c) => (!m || c.em > m ? c.em : m), null);
  const pausada = sync.pausaAte && Date.parse(sync.pausaAte) > agoraMs;
  return {
    situacaoConsultor: situacaoConsultor(sync, agoraMs),
    outroComputadorConsulta: situacaoConsultor(sync, agoraMs) === 'outro_consultor',
    modeloAprendido: !!sync.modelo,
    pausadaAte: pausada ? sync.pausaAte : null,
    pausaMotivo: pausada ? sync.pausaMotivo : null,
    consultasOk30min: consultas.filter((c) => c.ok).length,
    consultasFalha30min: consultas.filter((c) => !c.ok).length,
    ultimaConsultaOkEm: ultimaOk,
    pedidosEmAndamento: andamento.length,
    pedidosAguardandoDetalhe: andamento.filter((p) => !p.incerto).filter((p) => !p.detalheEm || (p.mudouEm && p.detalheEm < p.mudouEm)).length,
  };
}

async function garantirAlarmeSinal() {
  const existente = await chrome.alarms.get(ALARME_SINAL);
  if (!existente) {
    chrome.alarms.create(ALARME_SINAL, { periodInMinutes: INTERVALO_SINAL_MINUTOS });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARME_RETENTATIVA) {
    reprocessarPendentes();
  }
  if (alarm.name === ALARME_SINAL) {
    enviarSinal();
  }
  if (alarm.name === ALARME_CONSULTA) {
    rodadaDeConsulta();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'pedido_observado') {
    registrarObservado(message.payload)
      .then(() => registrarDetalhe(message.payload))
      .then(() => enviarParaIngest(message.payload))
      .then(() => sendResponse({ ok: true }));
    return true; // resposta assíncrona
  }

  if (message?.type === 'sinal_painel') {
    registrarSinalPainel(sender?.tab?.id ?? null, message.estado).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === 'painel_presente') {
    registrarPresencaPainel(sender?.tab?.id ?? null, message.paginaLogin).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === 'lista_pedidos') {
    registrarLista(message.itens).then(() => { agendarRodada(); sendResponse({ ok: true }); });
    return true;
  }

  if (message?.type === 'modelo_detalhe') {
    registrarModelo(message.modelo).then(() => { agendarRodada(); sendResponse({ ok: true }); });
    return true;
  }

  if (message?.type === 'detalhe_resultado') {
    registrarResultadoConsulta(message).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === 'obter_stats') {
    Promise.all([getStats(), getPendentes(), montarSinal(Date.now()), lerChave(STORAGE_KEYS.ultimoSinal, null), lerSync()])
      .then(([stats, pendentes, sinal, ultimoSinal, sync]) => {
        sendResponse({ ...stats, pendentes: Object.keys(pendentes).length, painel: sinal.painel, ultimoSinal, consulta: resumoConsulta(sync, Date.now()) });
      });
    return true;
  }

  return false;
});

// Ao (re)iniciar o service worker (inclusive depois de reinício do
// navegador, já que chrome.storage.local persiste) — garante os alarmes e
// tenta reprocessar qualquer pendência que tenha sobrado de antes.
(async () => {
  await garantirAlarmeSinal();
  await garantirAlarmeConsulta();
  await importarObservados();
  // v1.8.3: sinal logo ao iniciar (não só depois de 2 min) — com outro
  // computador na loja, a decisão de consultor chega em segundos.
  enviarSinal().catch(() => {});
  const pendentes = await getPendentes();
  if (Object.keys(pendentes).length > 0) {
    await garantirAlarmeRetentativa();
    await reprocessarPendentes();
  }
})();
