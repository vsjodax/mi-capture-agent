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

  // Modo debug temporário (v1.0.2, calibração em andamento) — imprime no
  // console NORMAL da página (não no do service worker) as chaves de toda
  // resposta JSON "candidata" (objeto com mais de 3 chaves, ou array não
  // vazio de objetos) que a heurística NÃO reconheceu como pedido. Só
  // assim dá pra achar o formato real de uma tela nova sem precisar caçar
  // manualmente na aba Rede do DevTools. Remover depois que o formato de
  // todos os canais (iFood/site/WhatsApp) estiver confirmado.
  function logDebugCandidato(json) {
    try {
      if (Array.isArray(json)) {
        if (json.length === 0) return;
        const primeiro = json[0];
        if (primeiro && typeof primeiro === 'object' && !Array.isArray(primeiro)) {
          console.log('%c[VERYS DEBUG] array não reconhecido, chaves do 1º item:', 'color:#f59e0b;font-weight:bold', Object.keys(primeiro), primeiro);
        }
        return;
      }
      if (json && typeof json === 'object' && Object.keys(json).length > 3) {
        console.log('%c[VERYS DEBUG] objeto não reconhecido, chaves:', 'color:#f59e0b;font-weight:bold', Object.keys(json), json);
      }
    } catch {
      // Nunca deixa o log de debug quebrar nada.
    }
  }

  function tentarExtrairEEmitir(texto) {
    try {
      const json = JSON.parse(texto);
      if (Array.isArray(json)) {
        const reconhecidos = json.filter(pareceUmPedido);
        if (reconhecidos.length > 0) {
          reconhecidos.forEach(notificar);
        } else {
          logDebugCandidato(json);
        }
      } else if (pareceUmPedido(json)) {
        notificar(json);
      } else {
        logDebugCandidato(json);
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
