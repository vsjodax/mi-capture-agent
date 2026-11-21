// Roda no MAIN world da página do Menu Integrado (não no isolated world de
// extensão) — só assim consegue enxergar o MESMO window.fetch/XHR que o
// próprio Menu Integrado usa para conversar com o backend dele. NUNCA
// modifica o comportamento da chamada (sempre repassa a resposta original
// intacta para quem pediu) — só observa, em paralelo, o que já ia
// acontecer de qualquer forma. Nunca clica em nada, nunca altera pedido.
//
// Única exceção, v1.8.0 (autorizada em 20/11/2026): CONSULTA DE LEITURA do
// detalhe do pedido, a pedido do service worker (que controla a frequência),
// usando a sessão já aberta do painel. Só GET, só no MESMO endereço de
// detalhe que o próprio painel usa (aprendido de uma resposta real dele),
// com os cabeçalhos que o painel mandou — guardados só na memória desta
// página, nunca enviados à extensão nem ao VERYS. Motivo: sem alguém abrir o
// pedido, nenhuma mudança (status, motoboy, pagamento) chegava ao VERYS.
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
  function decodificarAtributo(valor) {
    return valor
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  function extrairOrderDoDetailsHTML(html) {
    const match = html.match(/data-name="CompleteOrder"\s+data-attributes="([^"]*)"/);
    if (!match) return null;
    const decodificado = decodificarAtributo(match[1]);
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

  // Código do cupom aplicado no pedido — `order.couponCode`, chave
  // confirmada presente em 100% dos pedidos reais (2.713 em 30 dias, via
  // _debugMotoboy.todasAsChaves, levantamento 2026-11-19). O VALOR nunca foi
  // observado (payload_bruto só guarda os nomes das chaves), então só aceita
  // texto não vazio: qualquer outro formato (null, número, objeto) vira null,
  // nunca um valor inventado. Alimenta pedidos.cupom_codigo no VERYS
  // (ingest-mi-order) para a atribuição "cupom comprovado" da jornada do CRM.
  // `order.coupon` (objeto, só em alguns pedidos) e `couponDiscount` ficam de
  // fora até o formato real ser conferido.
  function normalizarCupom(order) {
    const codigo = typeof order.couponCode === 'string' ? order.couponCode.trim() : '';
    return codigo ? codigo : null;
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
      couponCode: normalizarCupom(order),
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

  // Devolve true quando reconheceu e emitiu um pedido completo (detalhe).
  // `origem` ('painel' = resposta que o painel pediu; 'consulta' = consulta
  // automática da v1.8.0) vai no payload só para medir a cobertura.
  function tentarExtrairEEmitir(url, texto, origem = 'painel') {
    try {
      const json = JSON.parse(texto);
      if (Array.isArray(json)) {
        json.filter(pareceUmPedido).forEach(notificar);
        emitirResumosDaLista(json);
        return false;
      }
      if (pareceUmPedido(json)) {
        notificar(json);
        return false;
      }
      if (json && typeof json.detailsHTML === 'string') {
        const order = extrairOrderDoDetailsHTML(json.detailsHTML);
        if (order) {
          if (origem === 'painel') aprenderModeloDetalhe(url, order);
          const pedido = normalizarPedido(order);
          pedido._origemCaptura = origem;
          const codigoIfood = extrairCodigoIfood(json.detailsHTML);
          if (codigoIfood) pedido.ifoodCode = codigoIfood;
          const ramal = extrairRamalIfood(json.detailsHTML);
          if (ramal) pedido.customer.phone.extension = ramal;
          const dataAncora = order.createdAt ? new Date(order.createdAt) : new Date();
          const { historico, previsaoEntrega } = extrairHistoricoStatus(json.detailsHTML, dataAncora);
          if (historico.length > 0) pedido.statusHistory = historico;
          if (previsaoEntrega) pedido.previsaoEntrega = previsaoEntrega;
          notificar(pedido);
          return true;
        }
        return false;
      }
      emitirResumosDaLista(json);
    } catch {
      // Resposta não é JSON (HTML, imagem, etc.) — ignora silenciosamente,
      // nunca é um erro real.
    }
    return false;
  }

  // --- Lista de pedidos (v1.8.0) ---
  // A lista que o painel atualiza sozinho não traz cliente/pagamento/endereço,
  // mas diz QUAIS pedidos existem e quando mudam. Daqui sai só, por pedido:
  // id, código, marca e uma ASSINATURA (hash) dos campos de andamento — nunca
  // nome, telefone ou endereço. O service worker usa isso para decidir qual
  // detalhe consultar. Reconhecimento genérico (objeto com `uuid` e `code` ou
  // algum campo de status), calibrado pelo diagnóstico da v1.7.1.
  const CHAVE_ANDAMENTO = /status|step|stage|deliveredAt|dispatch|ready|cancel|motoboy|updatedAt|finished|concluded/i;

  function hashTexto(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function resumoDaLista(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (typeof item.uuid !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(item.uuid)) return null;
    const chaves = Object.keys(item).filter((k) => CHAVE_ANDAMENTO.test(k)).sort();
    if (item.code === undefined && chaves.length === 0) return null;
    const assinatura = hashTexto(JSON.stringify(chaves.map((k) => [k, item[k]])));
    const codigo = typeof item.code === 'string' || typeof item.code === 'number' ? String(item.code).slice(0, 32) : null;
    const marca = typeof item.rootResource?.slug === 'string' ? item.rootResource.slug.slice(0, 120) : null;
    return { id: item.uuid, codigo, marca, assinatura, criadoEm: typeof item.createdAt === 'string' ? item.createdAt.slice(0, 40) : null };
  }

  function coletarResumos(v, prof, saida) {
    if (prof < 0 || saida.length >= 300 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const item of v) {
        const r = resumoDaLista(item);
        if (r) saida.push(r);
        else coletarResumos(item, prof - 1, saida);
        if (saida.length >= 300) return;
      }
      return;
    }
    for (const k of Object.keys(v)) coletarResumos(v[k], prof - 1, saida);
  }

  function emitirResumosDaLista(json) {
    try {
      const itens = [];
      coletarResumos(json, 3, itens);
      if (itens.length > 0) window.postMessage({ channel: CHANNEL, tipo: 'lista_pedidos', itens }, '*');
    } catch {
      // Nunca interfere no painel.
    }
  }

  // --- Consulta automática do detalhe (v1.8.0) ---
  // Modelo do endereço de detalhe: aprendido da URL de uma resposta REAL de
  // detalhe que o painel pediu (o id do pedido aparece nela). Fica na memória;
  // para a extensão sai só o modelo SEM parâmetros de consulta que não sejam o
  // próprio id (nunca token/sessão), para sobreviver a um recarregamento.
  const CABECALHO_SEGREDO = /^(cookie|content-length|content-type|host)$/i;
  const cabecalhosDoPainel = new Map(); // origem -> { nome: valor } — só memória desta página
  let modeloDetalhe = null; // { url: 'https://…/{id}…', campo: 'uuid'|'code' }

  function lembrarCabecalhos(url, metodo, cabecalhos) {
    try {
      if (!ehDoMenuIntegrado(url) || String(metodo || 'GET').toUpperCase() !== 'GET' || !cabecalhos) return;
      const copia = {};
      const pares = typeof cabecalhos.forEach === 'function' && !Array.isArray(cabecalhos)
        ? (() => { const p = []; cabecalhos.forEach((v, k) => p.push([k, v])); return p; })()
        : Array.isArray(cabecalhos) ? cabecalhos : Object.entries(cabecalhos);
      for (const [k, v] of pares) if (typeof k === 'string' && typeof v === 'string' && !CABECALHO_SEGREDO.test(k)) copia[k] = v;
      const base = typeof location !== 'undefined' ? location.href : 'https://painel.menuintegrado.com.br/';
      if (Object.keys(copia).length > 0) cabecalhosDoPainel.set(new URL(url, base).origin, copia);
    } catch {
      // Idem.
    }
  }

  function aprenderModeloDetalhe(url, order) {
    try {
      const base = typeof location !== 'undefined' ? location.href : 'https://painel.menuintegrado.com.br/';
      const u = new URL(url, base);
      if (!ehDoMenuIntegrado(u.href)) return;
      const candidatos = [['uuid', order.uuid], ['code', order.code]].filter(([, v]) => (typeof v === 'string' || typeof v === 'number') && String(v).length >= 4);
      for (const [campo, valor] of candidatos) {
        const v = String(valor);
        const segmentos = u.pathname.split('/');
        const noCaminho = segmentos.includes(v);
        const paramsComId = [...u.searchParams.entries()].filter(([, pv]) => pv === v).map(([pk]) => pk);
        if (!noCaminho && paramsComId.length === 0) continue;
        const caminho = segmentos.map((s) => (s === v ? '{id}' : s)).join('/');
        const params = [...u.searchParams.entries()].map(([pk, pv]) => [pk, pv === v ? '{id}' : pv]);
        const consulta = params.map(([pk, pv]) => `${encodeURIComponent(pk)}=${pv === '{id}' ? '{id}' : encodeURIComponent(pv)}`).join('&');
        modeloDetalhe = { url: `${u.origin}${caminho}${consulta ? `?${consulta}` : ''}`, campo };
        // Para guardar fora da página: só se todo parâmetro de consulta for o
        // próprio id (nada de token/sessão em chrome.storage).
        if (params.every(([, pv]) => pv === '{id}')) {
          window.postMessage({ channel: CHANNEL, tipo: 'modelo_detalhe', modelo: modeloDetalhe }, '*');
        }
        return;
      }
    } catch {
      // Idem.
    }
  }

  function urlDoDetalhe(modelo, pedido) {
    const valor = modelo.campo === 'code' ? pedido.codigo : pedido.id;
    if (typeof valor !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(valor)) return null;
    const url = modelo.url.split('{id}').join(encodeURIComponent(valor));
    return ehDoMenuIntegrado(url) ? url : null;
  }

  const ESPACO_ENTRE_CONSULTAS_MS = 2500;
  let consultando = false;

  async function consultarDetalhes(pedidos, modeloGuardado) {
    if (consultando) return;
    consultando = true;
    try {
      for (let i = 0; i < pedidos.length && i < 10; i++) {
        const pedido = pedidos[i];
        const modelo = modeloDetalhe || modeloGuardado;
        const url = modelo && typeof modelo.url === 'string' ? urlDoDetalhe(modelo, pedido) : null;
        if (!url) {
          window.postMessage({ channel: CHANNEL, tipo: 'detalhe_resultado', id: pedido.id, status: 0, reconhecido: false, motivo: 'sem_modelo' }, '*');
          continue;
        }
        if (i > 0) await new Promise((r) => setTimeout(r, ESPACO_ENTRE_CONSULTAS_MS));
        let status = 0;
        let reconhecido = false;
        let motivo = null;
        try {
          const resposta = await fetchOriginal.call(window, url, {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'application/json, text/plain, */*', ...(cabecalhosDoPainel.get(new URL(url).origin) || {}) },
          });
          status = resposta.status;
          registrarRespostaPainel(url, status, resposta.redirected ? resposta.url : null);
          const texto = await resposta.text();
          registrarEstrutura(url, status, texto);
          if (status >= 200 && status <= 299) reconhecido = tentarExtrairEEmitir(url, texto, 'consulta');
          if (!reconhecido) motivo = status >= 200 && status <= 299 ? 'formato_desconhecido' : `http_${status}`;
        } catch {
          motivo = 'erro_rede';
        }
        window.postMessage({ channel: CHANNEL, tipo: 'detalhe_resultado', id: pedido.id, status, reconhecido, motivo }, '*');
        if (status === 401 || status === 403 || status === 429) break; // o service worker pausa
      }
    } finally {
      consultando = false;
    }
  }

  if (typeof window.addEventListener === 'function') window.addEventListener('message', (event) => {
    try {
      if (event.source !== window || !event.data || event.data.channel !== CHANNEL) return;
      if (event.data.tipo !== 'buscar_detalhes' || !Array.isArray(event.data.pedidos)) return;
      const pedidos = event.data.pedidos
        .filter((p) => p && typeof p.id === 'string')
        .map((p) => ({ id: p.id, codigo: typeof p.codigo === 'string' ? p.codigo : null }));
      consultarDetalhes(pedidos, event.data.modelo || null);
    } catch {
      // Idem.
    }
  });

  // --- Sinal do painel (v1.7.0) ---
  // Prova que o painel do MI está aberto e com sessão válida mesmo sem pedido
  // novo (antes da abertura da loja não há pedido, e isso não é falha). Usa só
  // as respostas que o próprio painel já recebe: nunca dispara requisição.
  //   * resposta 2xx de *.menuintegrado.com.br que não caiu em tela de login
  //     = sessão válida naquele instante;
  //   * 401/403, ou resposta que terminou numa URL de login = sessão inválida.
  // Nada do conteúdo da resposta é enviado, só horários e uma contagem.
  const PADRAO_URL_LOGIN = /\/(login|signin|sign-in|entrar|auth)(\/|$|\?)/i;
  const INTERVALO_MIN_SINAL_MS = 30000;
  const estadoPainel = { ultimaRespostaOkEm: null, ultimaFalhaSessaoEm: null, respostasOk: 0 };
  let ultimoEnvioSinalEm = 0;
  let sinalAgendado = false;

  function ehDoMenuIntegrado(url) {
    try {
      const base = typeof location !== 'undefined' ? location.href : 'https://painel.menuintegrado.com.br/';
      const host = new URL(url, base).hostname;
      return host === 'menuintegrado.com.br' || host.endsWith('.menuintegrado.com.br');
    } catch {
      return false;
    }
  }

  // --- Diagnóstico de estrutura (v1.7.1) ---
  // Achado de 20/11/2026: com o painel aberto e sem interação, nenhum pedido
  // novo nem mudança de status chegava ao VERYS — só o DETALHE do pedido
  // (detailsHTML) é reconhecido, e ele só é carregado quando alguém abre o
  // pedido. Para ler o que o painel recebe SOZINHO, primeiro é preciso saber o
  // formato dessas respostas. Aqui guardamos só a ESTRUTURA: rota (ids
  // mascarados, só nomes dos parâmetros) e nomes de campos/tipos. Nunca um
  // valor: textos viram "str", números "num"; chave que pareça dado (número
  // longo, e-mail, id) vira ":k". Componentes embutidos no HTML
  // (data-name/data-attributes) entram só com nome e estrutura.
  const MAX_ROTAS = 40;
  const MAX_FORMA = 4000;
  const SEGMENTO_ID = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{20,}|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/i;
  const CHAVE_DADO = /^\d{3,}$|@|^[0-9a-f-]{16,}$|^\+?\d[\d\s().-]{6,}$/i;
  const estruturas = new Map(); // rota -> { rota, vezes, status, ultimaEm, forma }

  function mascararRota(url) {
    const base = typeof location !== 'undefined' ? location.href : 'https://painel.menuintegrado.com.br/';
    const u = new URL(url, base);
    const caminho = u.pathname.split('/').map((s) => (SEGMENTO_ID.test(s) ? ':id' : s)).join('/');
    const params = [...new Set([...u.searchParams.keys()])].filter((k) => /^[\w.-]{1,40}$/.test(k)).sort().join('&');
    return (caminho + (params ? `?${params}` : '')).slice(0, 200);
  }

  function formaDe(v, prof) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return `[${v.length ? formaDe(v[0], prof) : ''}]`; // array não consome nível
    const t = typeof v;
    if (t === 'object') {
      if (prof <= 0) return '{…}';
      const chaves = Object.keys(v);
      const partes = chaves.slice(0, 40).map((k) => `${CHAVE_DADO.test(k) ? ':k' : k}:${formaDe(v[k], prof - 1)}`);
      return `{${partes.join(',')}${chaves.length > 40 ? ',…' : ''}}`;
    }
    if (t === 'string') return v.includes('data-name="') ? `html${componentesDe(v)}` : 'str';
    if (t === 'number') return 'num';
    if (t === 'boolean') return 'bool';
    return t;
  }

  function componentesDe(html) {
    const re = /data-name="([\w-]{1,60})"\s+data-attributes="([^"]*)"/g;
    const vistos = new Map();
    let m;
    while ((m = re.exec(html)) && vistos.size < 20) {
      if (vistos.has(m[1])) continue;
      let f = '?';
      try { f = formaDe(JSON.parse(decodificarAtributo(m[2])), 4); } catch { /* atributo não-JSON */ }
      vistos.set(m[1], f);
    }
    return `[${[...vistos].map(([nome, f]) => nome + f).join(',')}]`;
  }

  function registrarEstrutura(url, status, texto) {
    try {
      if (!ehDoMenuIntegrado(url) || typeof texto !== 'string') return;
      let forma = null;
      try { forma = formaDe(JSON.parse(texto), 4); } catch {
        if (texto.includes('data-name="')) forma = `html${componentesDe(texto)}`;
      }
      if (!forma) return; // HTML/JS/CSS comuns não interessam
      const rota = mascararRota(url);
      const atual = estruturas.get(rota);
      if (!atual && estruturas.size >= MAX_ROTAS) return;
      estruturas.set(rota, { rota, vezes: (atual?.vezes ?? 0) + 1, status: Number(status) || 0, ultimaEm: new Date().toISOString(), forma: forma.slice(0, MAX_FORMA) });
    } catch {
      // Nunca interfere na chamada real do Menu Integrado.
    }
  }

  function emitirSinalPainel() {
    sinalAgendado = false;
    ultimoEnvioSinalEm = Date.now();
    const estado = { ...estadoPainel, rotas: [...estruturas.values()] };
    estadoPainel.respostasOk = 0;
    window.postMessage({ channel: CHANNEL, tipo: 'sinal_painel', estado }, '*');
  }

  function agendarSinalPainel(imediato) {
    const espera = INTERVALO_MIN_SINAL_MS - (Date.now() - ultimoEnvioSinalEm);
    if (imediato || espera <= 0) {
      emitirSinalPainel();
      return;
    }
    if (!sinalAgendado && typeof setTimeout === 'function') {
      sinalAgendado = true;
      setTimeout(emitirSinalPainel, espera);
    }
  }

  // urlFinal só é passada quando a resposta veio de um redirecionamento (a
  // própria URL pedida nunca conta como "login": uma chamada a /auth/refresh
  // que responde 200 é sessão válida).
  function classificarResposta(url, status, urlFinal) {
    if (!ehDoMenuIntegrado(url)) return null;
    if (status === 401 || status === 403) return 'falha_sessao';
    if (urlFinal && ehDoMenuIntegrado(urlFinal) && PADRAO_URL_LOGIN.test(new URL(urlFinal, 'https://x/').pathname + '/')) return 'falha_sessao';
    if (status >= 200 && status <= 299) return 'ok';
    return null; // 5xx, 404 etc. não dizem nada sobre a sessão
  }

  function registrarRespostaPainel(url, status, urlFinal) {
    try {
      const tipo = classificarResposta(url, status, urlFinal);
      if (!tipo) return;
      const agora = new Date().toISOString();
      if (tipo === 'ok') {
        estadoPainel.ultimaRespostaOkEm = agora;
        estadoPainel.respostasOk += 1;
        agendarSinalPainel(false);
      } else {
        estadoPainel.ultimaFalhaSessaoEm = agora;
        agendarSinalPainel(true);
      }
    } catch {
      // Nunca deixa o sinal interferir na chamada real do Menu Integrado.
    }
  }

  // --- fetch ---
  const fetchOriginal = window.fetch;
  window.fetch = async function (...args) {
    const resposta = await fetchOriginal.apply(this, args);
    try {
      const url = (args[0] && args[0].url) || String(args[0] || '');
      const opcoes = args[1] || {};
      lembrarCabecalhos(url, opcoes.method || (args[0] && args[0].method), opcoes.headers || (args[0] && args[0].headers));
      registrarRespostaPainel(url, resposta.status, resposta.redirected ? resposta.url : null);
      resposta
        .clone()
        .text()
        .then((texto) => {
          registrarEstrutura(url, resposta.status, texto);
          tentarExtrairEEmitir(url, texto);
        })
        .catch(() => {});
    } catch {
      // Nunca deixa a observação quebrar a chamada real do Menu Integrado.
    }
    return resposta;
  };

  // --- XMLHttpRequest ---
  const xhrOpenOriginal = XMLHttpRequest.prototype.open;
  const xhrSendOriginal = XMLHttpRequest.prototype.send;

  const xhrSetHeaderOriginal = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (_method, url, ...resto) {
    this._verysUrl = url;
    this._verysMetodo = _method;
    this._verysCabecalhos = {};
    return xhrOpenOriginal.apply(this, [_method, url, ...resto]);
  };

  if (typeof xhrSetHeaderOriginal === 'function') {
    XMLHttpRequest.prototype.setRequestHeader = function (nome, valor) {
      try {
        if (this._verysCabecalhos && typeof nome === 'string') this._verysCabecalhos[nome] = String(valor);
      } catch {
        // Idem.
      }
      return xhrSetHeaderOriginal.apply(this, [nome, valor]);
    };
  }

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      lembrarCabecalhos(this._verysUrl || '', this._verysMetodo, this._verysCabecalhos);
    } catch {
      // Idem.
    }
    this.addEventListener('load', () => {
      try {
        const pedida = this._verysUrl || '';
        let redirecionadaPara = null;
        if (this.responseURL) {
          const base = typeof location !== 'undefined' ? location.href : 'https://painel.menuintegrado.com.br/';
          if (new URL(pedida, base).href !== this.responseURL) redirecionadaPara = this.responseURL;
        }
        registrarRespostaPainel(pedida, this.status, redirecionadaPara);
      } catch {
        // Idem.
      }
      try {
        if (typeof this.responseText === 'string') {
          registrarEstrutura(this._verysUrl || '', this.status, this.responseText);
          tentarExtrairEEmitir(this._verysUrl || '', this.responseText);
        }
      } catch {
        // Idem — nunca interfere na requisição real.
      }
    });
    return xhrSendOriginal.apply(this, args);
  };
})();
