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

  function tentarExtrairEEmitir(texto) {
    try {
      const json = JSON.parse(texto);
      if (Array.isArray(json)) {
        json.filter(pareceUmPedido).forEach(notificar);
      } else if (pareceUmPedido(json)) {
        notificar(json);
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
      resposta
        .clone()
        .text()
        .then(tentarExtrairEEmitir)
        .catch(() => {});
    } catch {
      // Nunca deixa a observação quebrar a chamada real do Menu Integrado.
    }
    return resposta;
  };

  // --- XMLHttpRequest ---
  const xhrOpenOriginal = XMLHttpRequest.prototype.open;
  const xhrSendOriginal = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (...args) {
    return xhrOpenOriginal.apply(this, args);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (typeof this.responseText === 'string') tentarExtrairEEmitir(this.responseText);
      } catch {
        // Idem — nunca interfere na requisição real.
      }
    });
    return xhrSendOriginal.apply(this, args);
  };
})();
