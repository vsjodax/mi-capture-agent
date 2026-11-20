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
  };
}

// O VERYS responde ao sinal com a situação da captura que ELE conferiu
// (painel, sessão, fila e pedidos registrados/atualizados, por loja). É isso
// que o popup mostra como "sincronização comprovada" — nunca uma conclusão
// tirada só do lado da extensão.
async function enviarSinal() {
  const config = await getConfig();
  if (!config?.ingestUrl || !config?.token) return;
  const sinal = await montarSinal(Date.now());
  const resultado = await tentarEnviar(sinal, config);
  const situacao = resultado.enviado && resultado.corpo && typeof resultado.corpo.situacao === 'object' ? resultado.corpo.situacao : null;
  await chrome.storage.local.set({
    [STORAGE_KEYS.ultimoSinal]: { em: new Date().toISOString(), ok: resultado.enviado, motivo: resultado.motivo ?? null, situacao },
  });
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
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'pedido_observado') {
    registrarObservado(message.payload)
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

  if (message?.type === 'obter_stats') {
    Promise.all([getStats(), getPendentes(), montarSinal(Date.now()), lerChave(STORAGE_KEYS.ultimoSinal, null)])
      .then(([stats, pendentes, sinal, ultimoSinal]) => {
        sendResponse({ ...stats, pendentes: Object.keys(pendentes).length, painel: sinal.painel, ultimoSinal });
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
  const pendentes = await getPendentes();
  if (Object.keys(pendentes).length > 0) {
    await garantirAlarmeRetentativa();
    await reprocessarPendentes();
  }
})();
