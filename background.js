// Service worker (Manifest V3) — único lugar que fala com o backend do
// VERYS Connect. Nunca fala com o Menu Integrado além de observar o que a
// própria aba já fez (via content-script.js/page-hook.js).

const STORAGE_KEYS = {
  config: 'verys_mi_config', // { miUrlPattern, ingestUrl, token }
  stats: 'verys_mi_stats', // { pedidosHoje, enviados, falhas, ultimoEnvioEm, diaReferencia }
};

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

async function enviarParaIngest(payload) {
  const config = await getConfig();
  if (!config?.ingestUrl || !config?.token) {
    console.warn('[VERYS Capture Agent] Configuração ausente — pedido observado, mas não enviado. Configure em Opções.');
    return;
  }

  try {
    const resposta = await fetch(config.ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(payload),
    });

    if (resposta.ok) {
      const stats = await getStats();
      await atualizarStats({ pedidosHoje: stats.pedidosHoje + 1, enviados: stats.enviados + 1, ultimoEnvioEm: new Date().toISOString() });
    } else {
      const stats = await getStats();
      await atualizarStats({ falhas: stats.falhas + 1 });
      console.error('[VERYS Capture Agent] ingest-mi-order recusou o pedido:', resposta.status, await resposta.text());
    }
  } catch (err) {
    const stats = await getStats();
    await atualizarStats({ falhas: stats.falhas + 1 });
    console.error('[VERYS Capture Agent] Falha de rede ao enviar pedido observado:', err);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'pedido_observado') {
    enviarParaIngest(message.payload).then(() => sendResponse({ ok: true }));
    return true; // resposta assíncrona
  }

  if (message?.type === 'obter_stats') {
    getStats().then((stats) => sendResponse(stats));
    return true;
  }

  return false;
});
