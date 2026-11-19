// Teste comportamental (Node puro, sem dependências, sem Chrome/DOM) do
// page-hook.js REAL — carrega o ARQUIVO DO DISCO dentro de um vm.Context
// (mesmo padrão de tests/background.retry.test.mjs), mockando só
// `window`/`XMLHttpRequest`, e dirige a captura chamando o próprio
// `window.fetch` já interceptado pelo script (nunca chama funções internas
// diretamente — elas vivem dentro de um IIFE, sem export; só dá pra
// observar o comportamento real via o que é emitido em `window.postMessage`,
// que é exatamente o que o content-script.js real repassa pro resto da
// extensão).
//
// Cobre a adição de `deliveryMethod`/`tableName` em normalizarPedido()
// (achado 2026-11-05: chaves confirmadas presentes no objeto real do MI,
// nunca extraídas até agora) -- SEM calibração ainda contra o formato real
// dos valores (ver comentário em page-hook.js). Objetivo destes testes é só
// confirmar que a captura é estritamente aditiva: os dois campos novos
// aparecem quando presentes, a ausência deles (100% das capturas reais até
// hoje) não quebra nada, e nenhum campo pré-existente muda de valor.
//
// Rodar: node tests/page-hook.normalizarPedido.test.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));
const CAMINHO_REAL = join(AQUI, '..', 'page-hook.js');
const codigoFonte = fs.readFileSync(CAMINHO_REAL, 'utf-8');

let falhou = false;
function falhar(msg) {
  console.error('FALHA:', msg);
  falhou = true;
}
function ok(msg) {
  console.log('OK:', msg);
}

async function esperarMicrotasks() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

// Mesmo algoritmo de escape usado pelo MI real (confirmado contra
// extrairOrderDoDetailsHTML em page-hook.js: decodifica &quot;/&#39;/&lt;/
// &gt;/&amp; nessa ordem) -- a ordem de ESCAPE aqui é a inversa (& primeiro),
// senão corrompe o round-trip.
function escaparAtributoHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function montarDetailsHtml(order) {
  const json = JSON.stringify({ order });
  return `<div data-name="CompleteOrder" data-attributes="${escaparAtributoHtml(json)}"></div>`;
}

function criarSandbox() {
  const mensagensPostadas = [];
  const respostasFetchPendentes = [];

  function respostaFakeDe(corpoObj) {
    const texto = JSON.stringify(corpoObj);
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve(texto) }) });
  }

  const window_ = {
    // fetchOriginal capturado pelo script na hora que ele carrega -- é
    // isso que controla o que tentarExtrairEEmitir vai processar.
    fetch: (...args) => {
      const proxima = respostasFetchPendentes.shift();
      if (!proxima) throw new Error('Teste chamou fetch mais vezes do que programou resposta');
      return respostaFakeDe(proxima);
    },
    postMessage: (msg) => mensagensPostadas.push(msg),
  };

  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function () {};
  XMLHttpRequest.prototype.send = function () {};
  XMLHttpRequest.prototype.addEventListener = function () {};

  const sandbox = { window: window_, XMLHttpRequest, console, JSON, Object, Array, String, RegExp, Date, Promise, Map };
  vm.createContext(sandbox);
  vm.runInContext(codigoFonte, sandbox, { filename: 'page-hook.js' });

  return {
    sandbox,
    mensagensPostadas,
    async dispararDetalhe(order) {
      respostasFetchPendentes.push({ detailsHTML: montarDetailsHtml(order) });
      await sandbox.window.fetch('https://menuintegrado.exemplo/orders/detail');
      await esperarMicrotasks();
    },
    async dispararDetalheHtml(detailsHTML) {
      respostasFetchPendentes.push({ detailsHTML });
      await sandbox.window.fetch('https://menuintegrado.exemplo/orders/detail');
      await esperarMicrotasks();
    },
    async dispararLista(objListaOuArray) {
      respostasFetchPendentes.push(objListaOuArray);
      await sandbox.window.fetch('https://menuintegrado.exemplo/orders');
      await esperarMicrotasks();
    },
  };
}

// Pedido de detalhe mínimo, mas realista (mesmos campos usados em produção
// -- payment/address/motoboy incluídos pra provar que nada deles regride).
function pedidoDetalheBase(extra = {}) {
  return {
    uuid: 'uuid-pedido-teste-001',
    code: '555001',
    createdAt: '2026-11-05T12:00:00.000-03:00',
    channel: 'ifood',
    rootResource: { slug: 'hiperchefpizza' },
    customer: { uuid: 'cliente-uuid-1', name: 'Cliente Teste' },
    mobilePhone: '(47) 99999-0000',
    items: [{ uuid: 'item-1', product: { name: 'Pizza Teste' }, quantity: 1, unitPrice: 50 }],
    subtotal: 50,
    total: 50,
    payments: [{ methodLabel: 'PIX', provider: { sku: 'marketplace' }, needsChange: false, changeFor: null }],
    street: 'Rua Teste',
    neighborhood: 'Centro',
    cancelled: false,
    ...extra,
  };
}

async function rodarCenarios() {
  // ---- CENÁRIO 1: deliveryMethod + tableName presentes -- aparecem no payload emitido ----
  {
    const { mensagensPostadas, dispararDetalhe } = criarSandbox();
    await dispararDetalhe(pedidoDetalheBase({ deliveryMethod: 'Delivery', tableName: null }));

    const payload = mensagensPostadas[0]?.payload;
    if (payload?.deliveryMethod === 'Delivery') {
      ok('deliveryMethod presente no objeto real é transmitido no payload emitido.');
    } else {
      falhar(`esperado deliveryMethod='Delivery', obtido ${JSON.stringify(payload?.deliveryMethod)}`);
    }
    if (payload?.tableName === null) {
      ok('tableName null (pedido não é de mesa) é transmitido como null, não omitido nem inventado.');
    } else {
      falhar(`esperado tableName=null, obtido ${JSON.stringify(payload?.tableName)}`);
    }
  }

  // ---- CENÁRIO 1b: tableName com valor real (consumo no local) ----
  {
    const { mensagensPostadas, dispararDetalhe } = criarSandbox();
    await dispararDetalhe(pedidoDetalheBase({ deliveryMethod: 'DineIn', tableName: 'Mesa 7' }));
    const payload = mensagensPostadas[0]?.payload;
    if (payload?.deliveryMethod === 'DineIn' && payload?.tableName === 'Mesa 7') {
      ok('deliveryMethod e tableName de um pedido de mesa chegam intactos, sem transformação.');
    } else {
      falhar(`esperado deliveryMethod='DineIn'/tableName='Mesa 7', obtido ${JSON.stringify({ deliveryMethod: payload?.deliveryMethod, tableName: payload?.tableName })}`);
    }
    const chaves = payload?._debugMotoboy?.todasAsChaves ?? [];
    if (chaves.includes('deliveryMethod') && chaves.includes('tableName')) {
      ok('_debugMotoboy.todasAsChaves continua refletindo as chaves reais do objeto (Object.keys), incluindo as novas.');
    } else {
      falhar('_debugMotoboy.todasAsChaves deveria listar deliveryMethod/tableName e não listou.');
    }
  }

  // ---- CENÁRIO 1c: _debugCanalModalidade -- valores reais extraídos corretamente, nunca vaza dado sensível ----
  {
    const { mensagensPostadas, dispararDetalhe } = criarSandbox();
    await dispararDetalhe(pedidoDetalheBase({
      channel: 'counter',
      productChannel: 'balcao-interno',
      canUpdateSchedule: true,
      needsCutlery: false,
      onTrust: true,
      observations: 'Cliente pediu sem cebola, telefone (47) 99999-1234',
      reference: 'Perto do mercado tal, apto 302',
      card: { number: '4111111111111111', holder: 'Fulano' },
      description: 'Pedido anotado pelo atendente Carlos',
    }));
    const dbg = mensagensPostadas[0]?.payload?._debugCanalModalidade;
    if (dbg?.valoresReais?.channel === 'counter' && dbg.valoresReais.productChannel === 'balcao-interno'
      && dbg.valoresReais.canUpdateSchedule === true && dbg.valoresReais.needsCutlery === false && dbg.valoresReais.onTrust === true) {
      ok('_debugCanalModalidade.valoresReais extrai corretamente os campos estruturados (channel/productChannel/booleanos).');
    } else {
      falhar(`valoresReais incorreto: ${JSON.stringify(dbg?.valoresReais)}`);
    }
    const estrutura = dbg?.estruturaSomente;
    const textoSerializado = JSON.stringify(estrutura);
    const vazouDadoSensivel = /99999-1234|4111111111111111|Fulano|Carlos|cebola|mercado|apto 302/.test(textoSerializado);
    if (!vazouDadoSensivel
      && estrutura?.observations?.presente === true && estrutura.observations.tipo === 'string'
      && estrutura?.reference?.presente === true && estrutura.reference.tipo === 'string'
      && estrutura?.card?.presente === true && estrutura.card.tipo === 'object'
      && estrutura?.description?.presente === true && estrutura.description.tipo === 'string') {
      ok('estruturaSomente confirma presença/tipo de observations/reference/card/description SEM nunca serializar o conteúdo real (telefone, endereço, dado de cartão, nome) -- zero vazamento de dado pessoal/financeiro.');
    } else {
      falhar(`estruturaSomente vazou conteúdo sensível ou está incorreta: ${textoSerializado}`);
    }
  }

  // ---- CENÁRIO 1d: _debugCanalModalidade com todos os campos candidatos ausentes -- nunca quebra, nunca inventa ----
  {
    const { mensagensPostadas, dispararDetalhe } = criarSandbox();
    await dispararDetalhe(pedidoDetalheBase());
    const dbg = mensagensPostadas[0]?.payload?._debugCanalModalidade;
    // `channel` sempre vem preenchido em pedidoDetalheBase() (é a mesma
    // fonte de salesChannel, sempre presente em todo pedido real) -- o que
    // importa aqui é que os DEMAIS candidatos (nunca setados na base)
    // fiquem null/ausentes, sem quebrar nada.
    const demaisValoresNull = ['productChannel', 'canUpdateSchedule', 'needsCutlery', 'onTrust']
      .every((chave) => dbg?.valoresReais?.[chave] === null);
    const estruturaTodosAusentes = Object.values(dbg?.estruturaSomente ?? {}).every((v) => v.presente === false && v.tipo === null);
    if (demaisValoresNull && estruturaTodosAusentes) {
      ok('ausência dos campos candidatos (caso real de hoje) resulta em null/presente:false -- nunca quebra, nunca inventa valor.');
    } else {
      falhar(`esperado demais campos null/ausente, obtido ${JSON.stringify(dbg)}`);
    }
  }

  // ---- CENÁRIO 1e: productChannel='internal' (Balcão/Telefone) -- promovido pro nível raiz do payload ----
  {
    const { mensagensPostadas, dispararDetalhe } = criarSandbox();
    await dispararDetalhe(pedidoDetalheBase({ channel: 'counter', productChannel: 'internal' }));
    const payload = mensagensPostadas[0]?.payload;
    if (payload?.productChannel === 'internal') {
      ok("productChannel='internal' aparece no nível raiz do payload (payload.productChannel), não só dentro de _debugCanalModalidade.");
    } else {
      falhar(`esperado payload.productChannel='internal', obtido ${JSON.stringify(payload?.productChannel)}`);
    }
    if (payload?._debugCanalModalidade?.valoresReais?.productChannel === 'internal') {
      ok('_debugCanalModalidade.valoresReais.productChannel continua espelhando o mesmo valor (nenhuma lógica duplicada, só o dado repetido).');
    } else {
      falhar('_debugCanalModalidade.valoresReais.productChannel deveria continuar igual a payload.productChannel.');
    }
  }

  // ---- CENÁRIO 1f: productChannel='marketplace' (iFood/99Food/etc. via Balcão/retirada) -- também promovido ----
  {
    const { mensagensPostadas, dispararDetalhe } = criarSandbox();
    await dispararDetalhe(pedidoDetalheBase({ channel: 'counter', productChannel: 'marketplace' }));
    const payload = mensagensPostadas[0]?.payload;
    if (payload?.productChannel === 'marketplace') {
      ok("productChannel='marketplace' também chega intacto no nível raiz do payload.");
    } else {
      falhar(`esperado payload.productChannel='marketplace', obtido ${JSON.stringify(payload?.productChannel)}`);
    }
  }

  // ---- CENÁRIO 1g: productChannel explicitamente null -- nunca vira undefined/omitido ----
  {
    const { mensagensPostadas, dispararDetalhe } = criarSandbox();
    await dispararDetalhe(pedidoDetalheBase({ channel: 'counter', productChannel: null }));
    const payload = mensagensPostadas[0]?.payload;
    if (payload?.productChannel === null) {
      ok('productChannel explicitamente null no objeto real chega como null no payload (nunca omitido, nunca virando undefined na serialização).');
    } else {
      falhar(`esperado payload.productChannel=null, obtido ${JSON.stringify(payload?.productChannel)}`);
    }
  }

  // ---- CENÁRIO 1h: productChannel ausente do objeto real (chave nunca existiu) -- vira null, nunca quebra ----
  {
    const { mensagensPostadas, dispararDetalhe } = criarSandbox();
    const pedidoSemProductChannel = pedidoDetalheBase({ channel: 'counter' });
    delete pedidoSemProductChannel.productChannel;
    await dispararDetalhe(pedidoSemProductChannel);
    const payload = mensagensPostadas[0]?.payload;
    if (payload?.productChannel === null) {
      ok('productChannel ausente do objeto real (chave nunca existiu) chega como null no payload -- mesmo tratamento do caso explicitamente null, nunca inventa valor.');
    } else {
      falhar(`esperado payload.productChannel=null para campo ausente, obtido ${JSON.stringify(payload?.productChannel)}`);
    }
  }

  // ---- CENÁRIO 2: ausência total dos campos (100% das capturas reais até hoje) -- nunca quebra, nunca inventa valor ----
  {
    const { mensagensPostadas, dispararDetalhe } = criarSandbox();
    const pedidoSemCampos = pedidoDetalheBase();
    delete pedidoSemCampos.deliveryMethod;
    delete pedidoSemCampos.tableName;
    await dispararDetalhe(pedidoSemCampos);

    const payload = mensagensPostadas[0];
    if (!payload) {
      falhar('ausência de deliveryMethod/tableName impediu a captura inteira -- isso é regressão grave.');
    } else {
      ok('pedido sem deliveryMethod/tableName (caso real de hoje) continua sendo capturado e emitido normalmente.');
      if (payload.payload.deliveryMethod === null && payload.payload.tableName === null) {
        ok('campos ausentes no objeto real chegam como null no payload (nunca undefined "sumindo" da serialização, nunca um valor inventado).');
      } else {
        falhar(`esperado null/null para campos ausentes, obtido ${JSON.stringify({ d: payload.payload.deliveryMethod, t: payload.payload.tableName })}`);
      }
      // Confere que NENHUM campo pré-existente foi afetado por esta mudança.
      const p = payload.payload;
      const checagens = [
        ['id', p.id === 'uuid-pedido-teste-001'],
        ['displayId', p.displayId === '555001'],
        ['createdAt', p.createdAt === '2026-11-05T12:00:00.000-03:00'],
        ['salesChannel', p.salesChannel === 'ifood'],
        ['merchant.name', p.merchant?.name === 'hiperchefpizza'],
        ['customer.name', p.customer?.name === 'Cliente Teste'],
        ['customer.phone.number', p.customer?.phone?.number === '(47) 99999-0000'],
        ['items.length', p.items?.length === 1],
        ['total.orderAmount', p.total?.orderAmount === 50],
        ['payment.methodLabel', p.payment?.methodLabel === 'PIX'],
        ['payment.isPrepaid', p.payment?.isPrepaid === true],
        ['address.rua', p.address?.rua === 'Rua Teste'],
        ['cancelled', p.cancelled === false],
      ];
      const falhas = checagens.filter(([, passou]) => !passou).map(([nome]) => nome);
      if (falhas.length === 0) {
        ok('todos os campos pré-existentes (identificação, financeiro, endereço, pagamento, status) permanecem exatamente iguais a antes da mudança.');
      } else {
        falhar(`campos pré-existentes divergiram após a mudança: ${falhas.join(', ')}`);
      }
    }
  }

  // ---- CENÁRIO 3: pedido de marketplace (iFood) real continua funcionando ponta a ponta ----
  {
    const { mensagensPostadas, dispararDetalhe } = criarSandbox();
    await dispararDetalhe(pedidoDetalheBase({
      channel: 'ifood',
      motoboy: { name: 'Valmir Silva', mobilePhone: '(47) 98888-0000', uuid: 'motoboy-uuid-1', cost: 7 },
    }));
    const p = mensagensPostadas[0]?.payload;
    if (p?.salesChannel === 'ifood' && p?.motoboy?.nome === 'Valmir Silva' && p?.deliveryMethod === null) {
      ok('pedido iFood com motoboy continua normalizado corretamente -- deliveryMethod ausente não interfere no fluxo de marketplace.');
    } else {
      falhar(`pedido de marketplace regrediu: ${JSON.stringify(p)}`);
    }
  }

  // ---- CENÁRIO 4: forma de lista (sem passar por normalizarPedido) -- continua 100% intocada ----
  {
    const { mensagensPostadas, dispararLista } = criarSandbox();
    const pedidoLista = {
      id: 'uuid-lista-1',
      displayId: '777000',
      createdAt: '2026-11-05T12:00:00.000-03:00',
      salesChannel: 'ifood',
      merchant: { id: 'hiperchefpizza', name: 'hiperchefpizza' },
      customer: { id: 'c1', name: 'Fulano', phone: { number: '47999990000' } },
      items: [],
      total: { subTotal: 10, orderAmount: 10 },
    };
    await dispararLista(pedidoLista);
    const payload = mensagensPostadas[0]?.payload;
    if (JSON.stringify(payload) === JSON.stringify(pedidoLista)) {
      ok('captura via tela de lista (não passa por normalizarPedido) continua sendo repassada byte a byte, sem nenhuma alteração -- esta mudança não toca esse caminho.');
    } else {
      falhar(`forma de lista deveria ser repassada sem alteração, veio diferente: ${JSON.stringify(payload)}`);
    }
  }

  // ---- CENÁRIO 5: couponCode (v1.6.9) -- texto vira código limpo; o resto vira null ----
  {
    const casos = [
      ['código simples', { couponCode: 'VOLTA10' }, 'VOLTA10'],
      ['espaços nas pontas', { couponCode: '  volta15 ' }, 'volta15'],
      ['string vazia', { couponCode: '   ' }, null],
      ['null explícito', { couponCode: null }, null],
      ['número (formato inesperado)', { couponCode: 123 }, null],
      ['objeto (formato inesperado)', { couponCode: { code: 'X' } }, null],
      ['chave ausente', {}, null],
    ];
    for (const [nome, extra, esperado] of casos) {
      const { mensagensPostadas, dispararDetalhe } = criarSandbox();
      await dispararDetalhe(pedidoDetalheBase(extra));
      const p = mensagensPostadas[0]?.payload;
      if (p && p.couponCode === esperado && 'couponCode' in p) {
        ok(`couponCode (${nome}) -> ${JSON.stringify(esperado)}`);
      } else {
        falhar(`couponCode (${nome}): esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(p?.couponCode)}`);
      }
    }
    // `coupon` (objeto) e `couponDiscount` não alimentam couponCode.
    {
      const { mensagensPostadas, dispararDetalhe } = criarSandbox();
      await dispararDetalhe(pedidoDetalheBase({ couponCode: null, coupon: { code: 'OUTRO' }, couponDiscount: 5 }));
      const p = mensagensPostadas[0]?.payload;
      if (p?.couponCode === null) ok('coupon (objeto) e couponDiscount não são usados como código (formato ainda não conferido).');
      else falhar(`couponCode deveria ser null quando só há coupon/couponDiscount, obtido ${JSON.stringify(p?.couponCode)}`);
    }
  }

  // ---- CENÁRIO 6: com cupom, pagamento/endereço/motoboy/status chegam idênticos ao pedido sem cupom ----
  {
    const html = '<table><tr><td><small>Recebido</small></td><td class="pl-2">18:01</td></tr>'
      + '<tr><td><small>Produzindo</small></td><td class="pl-2">18:05</td></tr>'
      + '<tr><td><small>Enviado</small></td><td class="pl-2">18:40</td></tr>'
      + '<tr><td><small>Entregue</small></td><td class="pl-2">19:02</td></tr></table>';
    const extra = {
      createdAt: '2026-11-19T18:00:00.000-03:00',
      payments: [{ methodLabel: 'Dinheiro', provider: { sku: 'delivery' }, needsChange: true, changeFor: 100 }],
      missingPayment: true,
      street: 'Rua das Flores', number: '120', complement: 'Apto 3', neighborhood: 'Velha', reference: 'Perto da praça', city: 'Blumenau',
      motoboy: { name: 'Valmir Silva', mobilePhone: '(47) 98888-0000', uuid: 'motoboy-uuid-1', cost: 7 },
      cancelled: false,
    };
    // Mesmo caminho real (fetch interceptado -> detailsHTML), com a tabela de
    // status anexada ao HTML do detalhe.
    const semCupom = criarSandbox();
    const comCupom = criarSandbox();
    await semCupom.dispararDetalheHtml(montarDetailsHtml(pedidoDetalheBase(extra)) + html);
    await comCupom.dispararDetalheHtml(montarDetailsHtml(pedidoDetalheBase({ ...extra, couponCode: 'VOLTA10' })) + html);
    const a = semCupom.mensagensPostadas[0]?.payload;
    const b = comCupom.mensagensPostadas[0]?.payload;
    const campos = ['payment', 'address', 'motoboy', 'statusHistory', 'previsaoEntrega', 'cancelled', 'total', 'customer', 'items', 'salesChannel', 'productChannel'];
    const divergentes = campos.filter((c) => JSON.stringify(a?.[c]) !== JSON.stringify(b?.[c]));
    if (a && b && divergentes.length === 0 && a.couponCode === null && b.couponCode === 'VOLTA10') {
      ok('com cupom, pagamento/endereço/motoboy/histórico de status/cancelamento chegam idênticos ao pedido sem cupom; só couponCode muda.');
    } else {
      falhar(`regressão com cupom: divergentes=${JSON.stringify(divergentes)} a.couponCode=${JSON.stringify(a?.couponCode)} b.couponCode=${JSON.stringify(b?.couponCode)}`);
    }
    const esperado = {
      payment: { methodLabel: 'Dinheiro', isPrepaid: false, needsChange: true, changeFor: 100, missingPayment: true },
      address: { rua: 'Rua das Flores', numero: '120', complemento: 'Apto 3', bairro: 'Velha', referencia: 'Perto da praça', cidade: 'Blumenau' },
      motoboy: { nome: 'Valmir Silva', telefone: '(47) 98888-0000', uuid: 'motoboy-uuid-1', custo: 7 },
      status: ['Recebido', 'Produzindo', 'Enviado', 'Entregue'],
    };
    const conf = [
      ['pagamento', JSON.stringify(b?.payment) === JSON.stringify(esperado.payment)],
      ['endereço', JSON.stringify(b?.address) === JSON.stringify(esperado.address)],
      ['motoboy', JSON.stringify(b?.motoboy) === JSON.stringify(esperado.motoboy)],
      ['histórico de status', JSON.stringify((b?.statusHistory ?? []).map((s) => s.status)) === JSON.stringify(esperado.status)],
    ].filter(([, passou]) => !passou).map(([n]) => n);
    if (conf.length === 0) ok('pedido com cupom: pagamento, endereço, motoboy e histórico de status com os valores esperados.');
    else falhar(`pedido com cupom com valores errados em: ${conf.join(', ')} -> ${JSON.stringify({ payment: b?.payment, address: b?.address, motoboy: b?.motoboy, statusHistory: b?.statusHistory })}`);
  }

  if (!falhou) {
    console.log('\n=== TODOS OS CENÁRIOS CONFIRMADOS (deliveryMethod/tableName aditivos, zero regressão) ===');
  } else {
    console.log('\n=== TESTE FALHOU ===');
    process.exitCode = 1;
  }
}

rodarCenarios().catch((err) => {
  console.error('ERRO INESPERADO NO TESTE:', err);
  process.exitCode = 1;
});
