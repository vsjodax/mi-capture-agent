// Roda no MAIN world da página do Menu Integrado (não no isolated world de
// extensão) — só assim consegue enxergar o MESMO window.fetch/XHR que o
// próprio Menu Integrado usa para conversar com o backend dele. NUNCA
// modifica o comportamento da chamada (sempre repassa a resposta original
// intacta para quem pediu) — só observa, em paralelo, o que já ia
// acontecer de qualquer forma. Nunca dispara nenhuma requisição nova,
// nunca clica em nada, nunca envia nada como se fosse o usuário.
//
// Duas formas reais de pedido confirmadas contra tráfego real:
//
// 1) Objeto plano (ou array deles), calibrado em 2026-07-25:
//    { id, displayId, createdAt, salesChannel, merchant: {id, name},
//      customer: {id, name, phone: {number}}, items: [...], total: {...} }
//
// 2) Tela de detalhe do pedido (calibrado em 2026-07-27): a resposta é só
//    { detailsHTML: "<div>...</div>" } — um HTML pronto pra exibir, SEM
//    dado estruturado direto. Mas escondido dentro desse HTML existe um
//    componente React (data-name="CompleteOrder") cujo atributo
//    data-attributes carrega o pedido INTEIRO como JSON (cliente,
//    telefone, endereço completo, itens, pagamentos, motoboy, cupom) —
//    é de lá que os dados são extraídos abaixo, normalizados pro mesmo
//    formato do caso (1) antes de notificar.
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

  // Extrai o bloco de dados estruturados escondido dentro do detailsHTML.
  // O valor do atributo vem com entities HTML (&quot; no lugar de ") em
  // vez de aspas literais, por isso o decode manual antes do JSON.parse.
  function extrairOrderDoDetailsHTML(html) {
    const match = html.match(/data-name="CompleteOrder"\s+data-attributes="([^"]*)"/);
    if (!match) return null;
    const decodificado = match[1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    try {
      const parsed = JSON.parse(decodificado);
      return parsed && parsed.order ? parsed.order : null;
    } catch {
      return null;
    }
  }

  // merchant.name usa rootResource.slug (ex.: "hiperchefpizza") em vez de
  // um nome de exibição — é um identificador estável, sem variação de
  // digitação, e é o que fica configurado em mi_marcas_lojas no VERYS.
  function normalizarPedido(order) {
    return {
      id: order.uuid,
      displayId: order.code,
      createdAt: order.createdAt,
      salesChannel: order.channel,
      merchant: { id: order.rootResource?.slug ?? '', name: order.rootResource?.slug ?? '' },
      customer: {
        id: order.customer?.uuid ?? '',
        name: order.customer?.name ?? '',
        phone: { number: order.mobilePhone ?? '' },
      },
      items: order.items ?? [],
      total: { subTotal: order.subtotal, orderAmount: order.total },
    };
  }

  function tentarExtrairEEmitir(_url, texto) {
    try {
      const json = JSON.parse(texto);
      if (Array.isArray(json)) {
        json.filter(pareceUmPedido).forEach(notificar);
        return;
      }
      if (pareceUmPedido(json)) {
        notificar(json);
        return;
      }
      if (json && typeof json.detailsHTML === 'string') {
        const order = extrairOrderDoDetailsHTML(json.detailsHTML);
        if (order) notificar(normalizarPedido(order));
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
