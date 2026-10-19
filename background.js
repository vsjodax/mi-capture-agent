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
};

const ALARME_RETENTATIVA = 'verys_mi_retry_pendentes';
const INTERVALO_RETENTATIVA_MINUTOS = 5;

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
      return { enviado: true };
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARME_RETENTATIVA) {
    reprocessarPendentes();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'pedido_observado') {
    enviarParaIngest(message.payload).then(() => sendResponse({ ok: true }));
    return true; // resposta assíncrona
  }

  if (message?.type === 'obter_stats') {
    Promise.all([getStats(), getPendentes()]).then(([stats, pendentes]) => {
      sendResponse({ ...stats, pendentes: Object.keys(pendentes).length });
    });
    return true;
  }

  return false;
});

// Ao (re)iniciar o service worker (inclusive depois de reinício do
// navegador, já que chrome.storage.local persiste) — garante o alarme e
// tenta reprocessar qualquer pendência que tenha sobrado de antes.
(async () => {
  const pendentes = await getPendentes();
  if (Object.keys(pendentes).length > 0) {
    await garantirAlarmeRetentativa();
    await reprocessarPendentes();
  }
})();
