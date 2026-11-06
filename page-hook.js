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
  //
  // `order.code` é o código INTERNO do Menu Integrado (o "#537420" que
  // aparece no canto do card) — usado como displayId/id_externo (dedup),
  // NUNCA como o código exibido ao operador. O "Código iFood" real (ex.:
  // "9389", o número que o operador confere contra o app do iFood) só
  // aparece na tela de detalhe, como TEXTO puro renderizado (não é campo
  // do JSON do pedido) — extraído à parte por extrairCodigoIfood, calibrado
  // em 2026-07-29 contra tráfego real.
  // Forma de pagamento — vem em order.payments[0] (calibrado contra
  // tráfego real em 2026-07-29): provider.sku "marketplace" = já pago no
  // app do iFood; "delivery" = a receber na entrega (dinheiro/maquininha).
  // Só a tela de detalhe traz isso (lista não tem `payments`).
  //
  // isPrepaid só funciona pro canal iFood (provider.sku é um conceito de
  // marketplace) — pedido de site/platform sempre volta isPrepaid=false,
  // mesmo pago online no checkout (achado real 2026-08-10, confirmado
  // contra ~25 pedidos reais de site: isPrepaid=false em 100% deles,
  // independente da forma). `order.missingPayment` (chave solta no
  // objeto raiz, achada via _debugMotoboy.todasAsChaves) é candidato a
  // sinal universal de pagamento pendente/feito, mas AINDA NÃO
  // CALIBRADO contra valor real — só captura por enquanto, não decide
  // nada ainda. Não remover até confirmar o valor real contra um
  // pedido de site conhecidamente pago (Pix) e um conhecidamente "na
  // entrega", e então usar pra status_pagamento do canal site também.
  function normalizarPagamento(order) {
    const pagamento = order.payments?.[0];
    if (!pagamento) return undefined;
    return {
      methodLabel: pagamento.methodLabel ?? null,
      isPrepaid: pagamento.provider?.sku === 'marketplace',
      needsChange: !!pagamento.needsChange,
      changeFor: pagamento.changeFor ?? null,
      missingPayment: typeof order.missingPayment === 'boolean' ? order.missingPayment : null,
    };
  }

  // Endereço de entrega — campos estruturados no objeto raiz do pedido
  // (street/number/complement/neighborhood/reference), confirmado contra
  // tráfego real em 2026-07-29. Só a tela de detalhe traz isso (lista não
  // tem esses campos) — pedidos capturados só pela lista ficam sem
  // endereço até serem abertos na tela de detalhe (mesma limitação já
  // conhecida do Código iFood/forma de pagamento).
  function normalizarEndereco(order) {
    const temAlgo = order.street || order.neighborhood || order.address;
    if (!temAlgo) return undefined;
    return {
      rua: order.street ?? null,
      numero: order.number ?? null,
      complemento: order.complement ?? null,
      bairro: order.neighborhood ?? null,
      referencia: order.reference ?? null,
      cidade: order.city ?? null,
    };
  }

  // Motoboy — order.motoboy identificado em 2026-08-10 contra um pedido
  // real (Poliana, #238097): {name, mobilePhone, uuid, cost, ...}, com
  // mobilePhone batendo exatamente com o telefone do mesmo entregador
  // (Valmir Silva) visto em outro pedido no mesmo dia. Nome do motoboy
  // no MI é o mesmo cadastrado no VERYS (entregadores.nome) — dá pra
  // gravar direto em pedidos.motoboy_nome sem mapeamento extra.
  // Ainda calibrado contra só 1 pedido real — mantém capturarDebugMotoboy
  // ativo mais uma rodada como rede de segurança até confirmar contra
  // mais alguns pedidos com motoboy atribuído.
  function normalizarMotoboy(order) {
    const m = order.motoboy;
    if (!m || typeof m !== 'object') return undefined;
    return {
      nome: m.name ?? null,
      telefone: m.mobilePhone ?? null,
      uuid: m.uuid ?? null,
      custo: typeof m.cost === 'number' ? m.cost : null,
    };
  }

  // DIAGNÓSTICO TEMPORÁRIO — mantido como rede de segurança enquanto
  // normalizarMotoboy() é confirmado contra mais pedidos reais (captura
  // passa pelo ingest-mi-order sem mudança nenhuma, já que ele grava
  // mi_pedidos_capturados.payload_bruto inteiro — dá pra consultar
  // direto no banco). REMOVER quando normalizarMotoboy() estiver
  // confirmado contra tráfego real o suficiente.
  function capturarDebugMotoboy(order) {
    const candidatos = {};
    const padraoMotoboy = /moto|driver|courier|entreg|delivery.?(person|man)/i;
    Object.keys(order).forEach((chave) => {
      if (padraoMotoboy.test(chave)) candidatos[chave] = order[chave];
    });
    return { todasAsChaves: Object.keys(order), candidatos };
  }

  // DIAGNÓSTICO TEMPORÁRIO (investigação 2026-11-05) — mesmo padrão e
  // mesmo motivo de capturarDebugMotoboy: dá pra consultar o resultado
  // direto em mi_pedidos_capturados.payload_bruto, sem precisar publicar
  // nada. Objetivo: achar qual propriedade do pedido real do MI distingue
  // Balcão/Telefone/WhatsApp/Site/marketplace e Delivery/Retirar no local
  // -- salesChannel sozinho (testado contra tráfego real em 2026-11-05)
  // não distingue (Balcão e retirada-iFood usam o mesmo valor 'counter'),
  // e deliveryMethod/tableName vieram null mesmo num pedido de teste criado
  // explicitamente como Balcão + Retirar no local.
  //
  // `valoresReais`: só campos confirmadamente estruturados (enum curto de
  // catálogo interno do MI ou booleano) -- nunca texto digitado por
  // cliente/operador, nunca dado de pagamento. `channel` é o MESMO valor
  // que já vira `salesChannel` abaixo (duplicado aqui só pra manter os dois
  // nomes pedidos lado a lado no diagnóstico, sem mudar o que é enviado).
  //
  // `estruturaSomente`: campos candidatos que SÃO potencialmente texto
  // livre/dado sensível (observação do operador, referência de endereço,
  // dado de cartão, descrição livre) -- nunca grava o conteúdo, só se a
  // chave existe e qual o `typeof` do valor. Suficiente pra saber se vale
  // a pena investigar mais, sem guardar informação pessoal/financeira.
  //
  // REMOVER este bloco (e o campo _debugCanalModalidade abaixo) depois que
  // o mapeamento real de canal/modalidade estiver decidido e implementado.
  function capturarDebugCanalModalidade(order) {
    const valoresReais = {
      channel: order.channel ?? null,
      productChannel: order.productChannel ?? null,
      canUpdateSchedule: typeof order.canUpdateSchedule === 'boolean' ? order.canUpdateSchedule : null,
      needsCutlery: typeof order.needsCutlery === 'boolean' ? order.needsCutlery : null,
      onTrust: typeof order.onTrust === 'boolean' ? order.onTrust : null,
    };
    const estruturaSomente = {};
    ['observations', 'reference', 'card', 'description'].forEach((chave) => {
      const valor = order[chave];
      const ausente = valor === undefined || valor === null;
      estruturaSomente[chave] = { presente: !ausente, tipo: ausente ? null : typeof valor };
    });
    return { valoresReais, estruturaSomente };
  }

  function normalizarPedido(order) {
    return {
      id: order.uuid,
      displayId: order.code,
      createdAt: order.createdAt,
      salesChannel: order.channel,
      // Canal do produto ('internal' = manual/Balcão-Telefone, 'marketplace'
      // = iFood/99Food/etc.) -- mapeamento decidido em 2026-11-05, promovido
      // pra nível raiz (mesmo padrão de deliveryMethod/tableName acima) pra
      // ingest-mi-order poder ler payload.productChannel direto. Continua
      // também em _debugCanalModalidade.valoresReais.productChannel (não
      // duplicar lógica, só o valor).
      productChannel: order.productChannel ?? null,
      merchant: { id: order.rootResource?.slug ?? '', name: order.rootResource?.slug ?? '' },
      customer: {
        id: order.customer?.uuid ?? '',
        name: order.customer?.name ?? '',
        phone: { number: order.mobilePhone ?? '' },
      },
      items: order.items ?? [],
      total: { subTotal: order.subtotal, orderAmount: order.total },
      payment: normalizarPagamento(order),
      address: normalizarEndereco(order),
      motoboy: normalizarMotoboy(order),
      // Pedido cancelado nunca chega a "Entregue" no histórico — sinal
      // direto do campo booleano do próprio pedido (sempre presente),
      // pra nunca depender só da tabela de histórico pra saber disso.
      cancelled: !!order.cancelled,
      // Modalidade de entrega (Delivery/Retirar no local/Servir na mesa) e
      // nome/número da mesa — chaves confirmadas presentes no objeto real
      // via _debugMotoboy.todasAsChaves (achado 2026-11-05), nunca extraídas
      // até agora. AINDA NÃO CALIBRADO contra tráfego real (não sabemos o
      // formato exato dos valores de deliveryMethod) — só captura por
      // enquanto, mesmo padrão de order.missingPayment acima: nunca decide
      // nada no Verys ainda, só observa. `?? null` em vez de omitir a chave
      // porque a tela de lista (que não passa por normalizarPedido) nunca
      // teve esses campos mesmo — aqui é só a tela de detalhe, onde a
      // ausência é tão informativa quanto a presença.
      deliveryMethod: order.deliveryMethod ?? null,
      tableName: order.tableName ?? null,
      _debugMotoboy: capturarDebugMotoboy(order),
      _debugCanalModalidade: capturarDebugCanalModalidade(order),
    };
  }

  // Código de ramal/extensão da ligação mascarada do iFood (número 0800
  // temporário + código pra transferir até o cliente real) — NÃO
  // CALIBRADO CONTRA TRÁFEGO REAL AINDA (diferente de todo o resto deste
  // arquivo). Melhor esforço: mesma técnica de extrairCodigoIfood (rótulo
  // + valor em <td class="pl-2">), testando alguns rótulos plausíveis.
  // Se o formato real do Menu Integrado for diferente, isto não vai achar
  // nada (undefined, nunca inventa um código) — precisa validar contra
  // pedido iFood real e ajustar os rótulos/regex abaixo.
  const ROTULOS_RAMAL = ['Ramal', 'Extensão', 'Código de acesso', 'Código de transferência'];

  function extrairRamalIfood(html) {
    for (const rotulo of ROTULOS_RAMAL) {
      const idx = html.indexOf(rotulo);
      if (idx < 0) continue;
      const trecho = html.slice(idx, idx + 400);
      const match = trecho.match(/<td class="pl-2">\s*([^<]+?)\s*<\/td>/);
      if (match) return match[1].trim();
    }
    return undefined;
  }

  // "Código iFood" vem como texto puro dentro de uma linha de tabela tipo:
  // <small>Código iFood</small></td><td class="pl-2">9389</td> — nunca
  // como campo JSON. Só existe pra pedidos do canal iFood (undefined pros
  // demais, o que é esperado). Usado só para EXIBIÇÃO (pedidos.codigo_ifood)
  // — nunca para identificar/deduplicar o pedido (isso continua sendo
  // displayId/order.code, estável entre a tela de lista e a de detalhe).
  function extrairCodigoIfood(html) {
    const idx = html.indexOf('Código iFood');
    if (idx < 0) return undefined;
    const trecho = html.slice(idx, idx + 400);
    const match = trecho.match(/<td class="pl-2">\s*([^<]+?)\s*<\/td>/);
    return match ? match[1].trim() : undefined;
  }

  // Histórico de status — mesma estrutura de tabela do Código iFood, texto
  // puro na tela de detalhe: linhas <small>Rótulo</small>...<td class="pl-2">
  // valor</td>. "Entrega prevista" é uma previsão, não um evento real —
  // tratada à parte (previsaoEntrega), nunca misturada no histórico.
  //
  // Formato do valor MUDOU (achado real em 2026-08-02, via captura de
  // diagnóstico contra tráfego real — regressão que começou por volta de
  // 2026-07-30): calibração original (2026-07-29) esperava "DD/MM HH:mm";
  // o Menu Integrado passou a mandar só "HH:mm" (sem data nenhuma), o que
  // fazia construirDataHistorico devolver null pra TODA linha, esvaziando
  // o histórico inteiro silenciosamente. Mantém suporte aos dois formatos
  // (nunca se sabe se volta) — "HH:mm" reconstrói a data a partir do dia
  // de criação do pedido (dataAncora), avançando 1 dia toda vez que um
  // horário aparece "voltando no tempo" em relação ao evento anterior
  // (sinal de virada de meia-noite entre uma etapa e outra).
  const ROTULOS_HISTORICO = ['Recebido', 'Produzindo', 'Produzido', 'Despachado', 'Enviado', 'Entregue'];

  function parseHoraOuDataHora(str) {
    // Pedido de dia anterior ao atual vem com ano de 4 dígitos
    // ("30/11/2025 22:32") — achado real 2026-08-04, pedido #931065 vinha
    // com essa data e a extração inteira falhava silenciosamente (nenhum
    // dos dois formatos abaixo batia, historico.length ficava 0). Checar
    // este formato ANTES do "DD/MM HH:MM" sem ano, senão o regex sem ano
    // casaria só um pedaço errado da string.
    const comDataEAno = str.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
    if (comDataEAno) {
      const [, dia, mes, ano, hora, minuto] = comDataEAno;
      return { temData: true, temAno: true, dia: Number(dia), mes: Number(mes) - 1, ano: Number(ano), hora: Number(hora), minuto: Number(minuto) };
    }
    const comData = str.match(/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
    if (comData) {
      const [, dia, mes, hora, minuto] = comData;
      return { temData: true, temAno: false, dia: Number(dia), mes: Number(mes) - 1, hora: Number(hora), minuto: Number(minuto) };
    }
    const soHora = str.match(/^(\d{2}):(\d{2})$/);
    if (soHora) {
      const [, hora, minuto] = soHora;
      return { temData: false, hora: Number(hora), minuto: Number(minuto) };
    }
    return null;
  }

  function extrairHistoricoStatus(html, dataAncora) {
    const historico = [];
    let previsaoEntrega = null;
    const linhaRegex = /<small>([^<]+)<\/small>\s*<\/td>\s*<td class="pl-2">\s*([^<]+?)\s*<\/td>/g;
    let match;

    let diaCorrente = new Date(dataAncora.getFullYear(), dataAncora.getMonth(), dataAncora.getDate());
    let horaMinutoAnterior = null;

    while ((match = linhaRegex.exec(html)) !== null) {
      const rotulo = match[1].trim();
      const valor = match[2].trim();
      const ehEventoSequencial = ROTULOS_HISTORICO.includes(rotulo);
      const ehPrevisao = rotulo === 'Entrega prevista';
      if (!ehEventoSequencial && !ehPrevisao) continue;

      const parsed = parseHoraOuDataHora(valor);
      if (!parsed) continue;

      let dataEvento;
      if (parsed.temData) {
        // Ano explícito no HTML (pedido de dia anterior) é sempre mais
        // confiável que o ano de dataAncora — usa direto, sem depender de
        // heurística de virada de ano/mês.
        const ano = parsed.temAno ? parsed.ano : dataAncora.getFullYear();
        dataEvento = new Date(ano, parsed.mes, parsed.dia, parsed.hora, parsed.minuto);
      } else if (ehEventoSequencial) {
        // Só eventos sequenciais reais avançam o dia corrente. "Entrega
        // prevista" é uma ESTIMATIVA (calculada na criação do pedido) —
        // pode ter horário menor que "Enviado" se o pedido atrasou, o que
        // não significa virada de dia nenhuma (achado real 2026-08-02:
        // isso fazia "Entregue" pular um dia inteiro por engano).
        const horaMinutoAtual = parsed.hora * 60 + parsed.minuto;
        if (horaMinutoAnterior !== null && horaMinutoAtual < horaMinutoAnterior) {
          diaCorrente = new Date(diaCorrente.getFullYear(), diaCorrente.getMonth(), diaCorrente.getDate() + 1);
        }
        horaMinutoAnterior = horaMinutoAtual;
        dataEvento = new Date(diaCorrente.getFullYear(), diaCorrente.getMonth(), diaCorrente.getDate(), parsed.hora, parsed.minuto);
      } else {
        // Entrega prevista: usa o dia corrente já resolvido pelos eventos
        // sequenciais até aqui, sem alterar o rastreador de virada de dia.
        dataEvento = new Date(diaCorrente.getFullYear(), diaCorrente.getMonth(), diaCorrente.getDate(), parsed.hora, parsed.minuto);
      }

      if (isNaN(dataEvento.getTime())) continue;
      const iso = dataEvento.toISOString();

      if (ehEventoSequencial) {
        historico.push({ status: rotulo, timestamp: iso });
      } else if (rotulo === 'Entrega prevista') {
        previsaoEntrega = iso;
      }
    }
    return { historico, previsaoEntrega };
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
        if (order) {
          const pedido = normalizarPedido(order);
          const codigoIfood = extrairCodigoIfood(json.detailsHTML);
          if (codigoIfood) pedido.ifoodCode = codigoIfood;
          const ramal = extrairRamalIfood(json.detailsHTML);
          if (ramal) pedido.customer.phone.extension = ramal;
          const dataAncora = order.createdAt ? new Date(order.createdAt) : new Date();
          const { historico, previsaoEntrega } = extrairHistoricoStatus(json.detailsHTML, dataAncora);
          if (historico.length > 0) pedido.statusHistory = historico;
          if (previsaoEntrega) pedido.previsaoEntrega = previsaoEntrega;
          notificar(pedido);
        }
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
