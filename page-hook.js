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
  function logDebugCandidato(url, json) {
    try {
      if (Array.isArray(json)) {
        if (json.length === 0) return;
        console.log('%c[VERYS DEBUG] array (' + json.length + ' itens) — ' + url, 'color:#f59e0b;font-weight:bold', json);
        return;
      }
      if (json && typeof json === 'object' && Object.keys(json).length > 0) {
        console.log('%c[VERYS DEBUG] objeto, chaves ' + JSON.stringify(Object.keys(json)) + ' — ' + url, 'color:#f59e0b;font-weight:bold', json);
      }
    } catch {
      // Nunca deixa o log de debug quebrar nada.
    }
  }

  function tentarExtrairEEmitir(url, texto) {
    try {
      const json = JSON.parse(texto);
      if (Array.isArray(json)) {
        const reconhecidos = json.filter(pareceUmPedido);
        if (reconhecidos.length > 0) {
          reconhecidos.forEach(notificar);
        } else {
          logDebugCandidato(url, json);
        }
      } else if (pareceUmPedido(json)) {
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
