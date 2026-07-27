// Roda no MAIN world da página do Menu Integrado (não no isolated world de
// extensão) — só assim consegue enxergar o MESMO window.fetch/XHR que o
// próprio Menu Integrado usa para conversar com o backend dele. NUNCA
// modifica o comportamento da chamada (sempre repassa a resposta original
// intacta para quem pediu) — só observa, em paralelo, o que já ia
// acontecer de qualquer forma. Nunca dispara nenhuma requisição nova,
// nunca clica em nada, nunca envia nada como se fosse o usuário.
//
// Heurística de reconhecimento de "isso parece um pedido" — calibrada em
// 2026-07-25 contra tráfego REAL (payloads de pedido do iFood via Menu
// Integrado, confirmados pelo usuário). Formato real do objeto de pedido:
// { id, displayId, createdAt, salesChannel, merchant: {id, name},
//   customer: {id, name, phone: {number}}, items: [...], total: {...} }
// — bem diferente da suposição inicial (uuid/customer_phone soltos); não
// existe wrapper {event, order}, o pedido É o objeto raiz. A própria
// resposta pode ser um pedido único (tela de detalhe) ou um array de
// pedidos (tela de lista) — os dois casos são tratados abaixo.
(() => {
  const CHANNEL = 'verys-mi-capture';

  // PAINEL DE DIAGNÓSTICO TEMPORÁRIO (remover depois de confirmar o
  // formato real) — mostra direto na página, sem precisar abrir DevTools:
  // quantas respostas JSON foram vistas, quantas foram reconhecidas como
  // pedido, e um resumo das últimas não reconhecidas.
  let totalVistos = 0;
  let totalReconhecidos = 0;
  const ultimasNaoReconhecidas = [];
  let painelEl = null;

  function montarPainel() {
    try {
      painelEl = document.createElement('div');
      painelEl.style.cssText =
        'position:fixed;top:0;right:0;z-index:999999;background:#111;color:#0f0;font:11px monospace;padding:8px;max-width:420px;max-height:260px;overflow:auto;border:2px solid #e6007e;white-space:pre-wrap;';
      painelEl.textContent = 'VERYS DEBUG — aguardando respostas...';
      (document.body || document.documentElement).appendChild(painelEl);
    } catch {
      // Nunca deixa o diagnóstico quebrar nada.
    }
  }

  function atualizarPainel() {
    if (!painelEl) return;
    try {
      const linhas = [`VERYS DEBUG — vistos: ${totalVistos} | reconhecidos: ${totalReconhecidos}`, '--- últimas não reconhecidas ---'];
      ultimasNaoReconhecidas.forEach((item) => linhas.push(item));
      painelEl.textContent = linhas.join('\n');
    } catch {
      // idem
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', montarPainel);
  } else {
    montarPainel();
  }

  function pareceUmPedido(obj) {
    if (!obj || typeof obj !== 'object') return false;
    return typeof obj.id === 'string'
      && obj.customer && typeof obj.customer === 'object'
      && obj.merchant && typeof obj.merchant === 'object';
  }

  function notificar(pedido) {
    window.postMessage({ channel: CHANNEL, payload: pedido }, '*');
  }

  // Modo debug temporário (v1.0.3, calibração em andamento) — imprime no
  // console NORMAL da página (não no do service worker) toda resposta JSON
  // que a heurística NÃO reconheceu como pedido, junto com a URL de onde
  // veio. Deliberadamente pouco filtrado (até objetos de 1 chave só, ex.:
  // {"detailsHTML": "..."}) — a v1.0.2 filtrava demais (só >3 chaves) e
  // escondeu justamente o formato real, que é bem enxuto. Remover depois
  // que o formato de todos os canais (iFood/site/WhatsApp) estiver
  // confirmado.
  // Imprime como TEXTO PURO (não como objeto inspecionável) — assim dá pra
  // copiar clicando com o botão direito na linha → "Copy message", sem
  // precisar expandir nada na árvore do console (difícil para quem não usa
  // DevTools no dia a dia).
  function logDebugCandidato(url, json) {
    try {
      if (Array.isArray(json) && json.length === 0) return;
      if (!Array.isArray(json) && (!json || typeof json !== 'object' || Object.keys(json).length === 0)) return;
      const texto = JSON.stringify(json);
      console.log('[VERYS DEBUG] ' + url + ' => ' + texto);

      // detailsHTML é o dado que estamos calibrando agora — mostra
      // completo (sem corte) pra dar pra extrair cliente/telefone/itens
      // de dentro do HTML. Qualquer outra coisa continua cortada, só
      // pra não lotar o painel com ruído (ex.: payment_methods).
      const limite = (!Array.isArray(json) && json && typeof json.detailsHTML === 'string') ? 4000 : 200;
      const resumo = `${url.slice(-60)} => ${texto.slice(0, limite)}`;
      ultimasNaoReconhecidas.unshift(resumo);
      if (ultimasNaoReconhecidas.length > 3) ultimasNaoReconhecidas.pop();
      atualizarPainel();
    } catch {
      // Nunca deixa o log de debug quebrar nada.
    }
  }

  function tentarExtrairEEmitir(url, texto) {
    try {
      const json = JSON.parse(texto);
      totalVistos += 1;
      if (Array.isArray(json)) {
        const reconhecidos = json.filter(pareceUmPedido);
        if (reconhecidos.length > 0) {
          totalReconhecidos += reconhecidos.length;
          atualizarPainel();
          reconhecidos.forEach(notificar);
        } else {
          logDebugCandidato(url, json);
        }
      } else if (pareceUmPedido(json)) {
        totalReconhecidos += 1;
        atualizarPainel();
        notificar(json);
      } else {
        logDebugCandidato(url, json);
      }
    } catch {
      // Resposta não é JSON (HTML, imagem, etc.) — ignora silenciosamente,
      // nunca é um erro real.
    }
  }

  // --- fetch ---
  const fetchOriginal = window.fetch;
  window.fetch = async function (...args) {
    const resposta = await fetchOriginal.apply(this, args);
    try {
      const url = (args[0] && args[0].url) || String(args[0] || '');
      resposta
        .clone()
        .text()
        .then((texto) => tentarExtrairEEmitir(url, texto))
        .catch(() => {});
    } catch {
      // Nunca deixa a observação quebrar a chamada real do Menu Integrado.
    }
    return resposta;
  };

  // --- XMLHttpRequest ---
  const xhrOpenOriginal = XMLHttpRequest.prototype.open;
  const xhrSendOriginal = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (_method, url, ...resto) {
    this._verysUrl = url;
    return xhrOpenOriginal.apply(this, [_method, url, ...resto]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (typeof this.responseText === 'string') tentarExtrairEEmitir(this._verysUrl || '', this.responseText);
      } catch {
        // Idem — nunca interfere na requisição real.
      }
    });
    return xhrSendOriginal.apply(this, args);
  };
})();
