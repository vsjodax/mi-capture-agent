// Sincronização automática (v1.8.0): page-hook.js, background.js e popup.js
// REAIS em vm.Context, com MI e dados sintéticos. Prova:
//   * o modelo do endereço de detalhe é aprendido de uma resposta REAL do
//     painel; token na consulta nunca sai da página;
//   * a consulta é só GET, só em *.menuintegrado.com.br, com os cabeçalhos do
//     painel (que ficam só na memória da página), espaçada, e para em 401/403;
//   * o pedido consultado sai igual ao do painel, marcado _origemCaptura;
//   * a lista sai só com id/código/marca/assinatura (nunca nome/telefone);
//   * o agendador escolhe: novo/mudou já, em andamento a cada 4 min, para
//     no entregue/cancelado, no máximo 6 por rodada, pausa em sessão inválida;
//   * o popup separa "painel conectado" de "pedidos sincronizados".
// Rodar: node tests/sincronizacao-automatica.test.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (f) => fs.readFileSync(join(AQUI, '..', f), 'utf-8');
const PAGE_HOOK = ler('page-hook.js');
const BACKGROUND = ler('background.js');
const POPUP = ler('popup.js');

let falhou = false;
const verificar = (nome, cond, det) => { if (cond) console.log('OK:', nome); else { console.error('FALHA:', nome, det === undefined ? '' : JSON.stringify(det)); falhou = true; } };
const esperar = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

const UUID = '9e0c1d2a-1111-4222-8333-444455556666';
const UUID2 = '7a7a7a7a-2222-4333-8444-555566667777';
const SENSIVEIS = ['Fulano de Tal', '47999998888', 'Rua das Flores', 'segredo-do-painel', 'tok-123'];

function detalheHtml(uuid, extras = {}) {
  const order = { uuid, code: '537420', createdAt: '2026-11-20T22:00:00.000Z', channel: 'platform', rootResource: { slug: 'hiperchefpizza' },
    customer: { uuid: 'c1', name: 'Fulano de Tal' }, mobilePhone: '47999998888', street: 'Rua das Flores', number: '10', neighborhood: 'Centro',
    payments: [{ methodLabel: 'Pix', provider: { sku: 'platform' } }], couponCode: 'CUPOM10', cancelled: false,
    motoboy: { name: 'Motoboy Teste', mobilePhone: '47911112222', uuid: 'm1', cost: 7 }, items: [], subtotal: 50, total: 57, ...extras };
  const attr = JSON.stringify({ order }).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return JSON.stringify({ detailsHTML: `<div data-name="CompleteOrder" data-attributes="${attr}"></div><small>Recebido</small></td><td class="pl-2">19:00</td>${extras._entregue ? '<small>Entregue</small></td><td class="pl-2">19:40</td>' : ''}` });
}

// ------------------------------------------------------------------ page-hook
function criarPageHook() {
  const postados = []; const ouvintes = []; const chamadas = []; const timers = [];
  const respostas = new Map(); // url -> { status, texto }
  const window_ = {
    fetch: (url, opcoes) => {
      const u = typeof url === 'string' ? url : url.url;
      chamadas.push({ url: u, opcoes });
      const r = respostas.get(u) ?? { status: 404, texto: '{}' };
      return Promise.resolve({ status: r.status, redirected: false, url: u, text: () => Promise.resolve(r.texto), clone: () => ({ text: () => Promise.resolve(r.texto) }) });
    },
    postMessage: (m) => { postados.push(m); for (const f of ouvintes) setImmediate(() => f({ source: window_, data: m })); },
    addEventListener: (tipo, f) => { if (tipo === 'message') ouvintes.push(f); },
  };
  function XHR() {} XHR.prototype.open = function () {}; XHR.prototype.send = function () {}; XHR.prototype.addEventListener = function () {}; XHR.prototype.setRequestHeader = function () {};
  const sandbox = { window: window_, XMLHttpRequest: XHR, location: { href: 'https://painel.menuintegrado.com.br/pedidos', pathname: '/pedidos' },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, console, JSON, Object, Array, String, RegExp, Date, Promise, Map, Set, URL, Number, encodeURIComponent };
  vm.createContext(sandbox); vm.runInContext(PAGE_HOOK, sandbox, { filename: 'page-hook.js' });
  return {
    postados, chamadas, respostas,
    async painelPede(url, opcoes) { await sandbox.window.fetch(url, opcoes); await esperar(); },
    async extensaoPede(pedidos, modelo = null) {
      window_.postMessage({ channel: 'verys-mi-capture', tipo: 'buscar_detalhes', pedidos, modelo });
      for (let i = 0; i < 12; i++) { await esperar(); while (timers.length) timers.shift()(); }
      await esperar();
    },
  };
}

{
  const ph = criarPageHook();
  // 1) Antes de aprender o modelo: consulta não acontece.
  await ph.extensaoPede([{ id: UUID }]);
  const semModelo = ph.postados.filter((m) => m.tipo === 'detalhe_resultado');
  verificar('sem modelo aprendido: nenhuma requisição, resultado sem_modelo', ph.chamadas.length === 0 && semModelo[0]?.motivo === 'sem_modelo', semModelo);

  // 2) O painel abre um detalhe (com cabeçalho de sessão e token na URL).
  const urlPainel = `https://api.menuintegrado.com.br/orders/${UUID}/details?token=tok-123`;
  ph.respostas.set(urlPainel, { status: 200, texto: detalheHtml(UUID) });
  await ph.painelPede(urlPainel, { method: 'GET', headers: { Authorization: 'Bearer segredo-do-painel', 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' } });
  const doPainel = ph.postados.filter((m) => m.payload);
  verificar('detalhe aberto pelo painel continua capturado (origem painel)', doPainel.length === 1 && doPainel[0].payload._origemCaptura === 'painel');
  verificar('modelo com token na URL NÃO é enviado à extensão (fica só na página)', !ph.postados.some((m) => m.tipo === 'modelo_detalhe'));

  // 3) Consulta automática de outro pedido usa o modelo da página.
  const urlAuto = `https://api.menuintegrado.com.br/orders/${UUID2}/details?token=tok-123`;
  ph.respostas.set(urlAuto, { status: 200, texto: detalheHtml(UUID2, { _entregue: true }) });
  ph.chamadas.length = 0;
  await ph.extensaoPede([{ id: UUID2 }]);
  const c = ph.chamadas[0];
  verificar('consulta vai ao MESMO endereço de detalhe do painel, com o id trocado', ph.chamadas.length === 1 && c.url === urlAuto, ph.chamadas.map((x) => x.url));
  verificar('consulta é só GET, com a sessão do navegador (credentials include)', c?.opcoes?.method === 'GET' && c.opcoes.credentials === 'include');
  verificar('consulta reaproveita os cabeçalhos do painel, sem Content-Type', c?.opcoes?.headers?.Authorization === 'Bearer segredo-do-painel' && !('Content-Type' in (c?.opcoes?.headers ?? {})));
  const auto = ph.postados.filter((m) => m.payload && m.payload.id === UUID2);
  const p = auto[0]?.payload;
  verificar('pedido consultado sai completo: pagamento, endereço, cupom, motoboy, histórico', p && p.payment?.methodLabel === 'Pix' && p.address?.rua === 'Rua das Flores'
    && p.couponCode === 'CUPOM10' && p.motoboy?.nome === 'Motoboy Teste' && p.statusHistory?.some((h) => h.status === 'Entregue'), p);
  verificar('pedido consultado marcado _origemCaptura=consulta', p?._origemCaptura === 'consulta');
  const res = ph.postados.filter((m) => m.tipo === 'detalhe_resultado').at(-1);
  verificar('resultado da consulta informado (reconhecido, 200)', res?.id === UUID2 && res.reconhecido === true && res.status === 200, res);
  const paraExtensao = ph.postados.filter((m) => m.tipo === 'detalhe_resultado' || m.tipo === 'modelo_detalhe' || m.tipo === 'lista_pedidos');
  verificar('nada de cabeçalho/token/cliente nas mensagens de controle', !SENSIVEIS.some((v) => JSON.stringify(paraExtensao).includes(v)));

  // 4) Sessão recusada: para o lote no primeiro 401.
  ph.chamadas.length = 0;
  for (const id of ['aaaaaaaa-1', 'bbbbbbbb-2', 'cccccccc-3']) ph.respostas.set(`https://api.menuintegrado.com.br/orders/${id}/details?token=tok-123`, { status: 401, texto: '{}' });
  await ph.extensaoPede([{ id: 'aaaaaaaa-1' }, { id: 'bbbbbbbb-2' }, { id: 'cccccccc-3' }]);
  verificar('401 interrompe o lote (1 requisição só)', ph.chamadas.length === 1, ph.chamadas.length);

  // 5) Modelo vindo de fora apontando para outro domínio é recusado.
  const ph2 = criarPageHook();
  await ph2.extensaoPede([{ id: UUID }], { url: 'https://evil.example.com/orders/{id}', campo: 'uuid' });
  verificar('modelo fora de *.menuintegrado.com.br é recusado (nenhuma requisição)', ph2.chamadas.length === 0);
  // id com caractere estranho é recusado
  await ph2.extensaoPede([{ id: '../../x' }], { url: 'https://api.menuintegrado.com.br/orders/{id}', campo: 'uuid' });
  verificar('id inválido não vira URL', ph2.chamadas.length === 0);

  // 6) Modelo sem token na URL é guardado na extensão.
  const ph3 = criarPageHook();
  const urlLimpa = `https://api.menuintegrado.com.br/orders/${UUID}/details`;
  ph3.respostas.set(urlLimpa, { status: 200, texto: detalheHtml(UUID) });
  await ph3.painelPede(urlLimpa, { method: 'GET' });
  const modelo = ph3.postados.find((m) => m.tipo === 'modelo_detalhe')?.modelo;
  verificar('modelo sem token vai para a extensão (sobrevive a recarregar)', modelo?.url === 'https://api.menuintegrado.com.br/orders/{id}/details' && modelo.campo === 'uuid', modelo);

  // 7) Lista: só id/código/marca/assinatura.
  const lista = { data: { orders: [
    { uuid: UUID, code: '537420', status: 'PRODUCING', createdAt: '2026-11-20T22:00:00.000Z', rootResource: { slug: 'hiperchefpizza' }, customer: { name: 'Fulano de Tal', mobilePhone: '47999998888' }, street: 'Rua das Flores' },
    { uuid: UUID2, code: '537421', status: 'DISPATCHED', motoboy: { name: 'Motoboy Teste' } },
  ] } };
  ph3.respostas.set('https://api.menuintegrado.com.br/orders?status=open', { status: 200, texto: JSON.stringify(lista) });
  await ph3.painelPede('https://api.menuintegrado.com.br/orders?status=open', { method: 'GET' });
  const resumo = ph3.postados.find((m) => m.tipo === 'lista_pedidos');
  verificar('lista reconhecida: 2 pedidos com id, código e marca', resumo?.itens?.length === 2 && resumo.itens[0].id === UUID && resumo.itens[0].codigo === '537420' && resumo.itens[0].marca === 'hiperchefpizza', resumo);
  verificar('lista sem nenhum dado de cliente/motoboy', !SENSIVEIS.concat(['Motoboy Teste']).some((v) => JSON.stringify(resumo).includes(v)));
  lista.data.orders[0].status = 'DISPATCHED';
  ph3.respostas.set('https://api.menuintegrado.com.br/orders?status=open', { status: 200, texto: JSON.stringify(lista) });
  await ph3.painelPede('https://api.menuintegrado.com.br/orders?status=open', { method: 'GET' });
  const resumo2 = ph3.postados.filter((m) => m.tipo === 'lista_pedidos').at(-1);
  verificar('mudança de status muda a assinatura', resumo2.itens[0].assinatura !== resumo.itens[0].assinatura && resumo2.itens[1].assinatura === resumo.itens[1].assinatura);
}

// ------------------------------------------------------------------ background
function criarBackground(agoraInicial) {
  const dados = {}; let onMessage = null; let onAlarm = null; const abasMsgs = []; const enviados = []; const alarmes = new Map();
  let agora = agoraInicial;
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [agora])); } static now() { return agora; } }
  const chrome = {
    storage: { local: { get: (k) => { const r = {}; for (const x of [].concat(k)) if (x in dados) r[x] = structuredClone(dados[x]); return Promise.resolve(r); }, set: (p) => { Object.assign(dados, structuredClone(p)); return Promise.resolve(); } } },
    alarms: { get: (n) => Promise.resolve(alarmes.get(n)), create: (n, o) => alarmes.set(n, o), onAlarm: { addListener: (f) => { onAlarm = f; } } },
    runtime: { onMessage: { addListener: (f) => { onMessage = f; } }, getManifest: () => ({ version: '1.8.0' }) },
    tabs: { sendMessage: (aba, msg) => { abasMsgs.push({ aba, msg }); return Promise.resolve({ aceito: true }); } },
  };
  const sb = { chrome, console: { ...console, error: () => {}, warn: () => {} }, crypto: globalThis.crypto, setImmediate, Response, URL, Date: FakeDate, setTimeout: () => 0,
    fetch: (url, o) => { enviados.push(JSON.parse(o.body)); return Promise.resolve(new Response('{"ok":true}', { status: 200 })); } };
  vm.createContext(sb); vm.runInContext(BACKGROUND, sb, { filename: 'background.js' });
  const msg = (m, aba = 7) => new Promise((r) => onMessage(m, { tab: { id: aba } }, r));
  return {
    dados, abasMsgs, enviados, alarmes, msg,
    avancar(min) { agora += min * 60000; },
    agora: () => agora,
    async rodada() { await onAlarm({ name: 'verys_mi_consulta' }); await esperar(); },
  };
}

{
  const T0 = Date.parse('2026-11-20T22:10:00.000Z');
  const bg = criarBackground(T0);
  await esperar();
  verificar('alarme da consulta criado (1 min)', bg.alarmes.get('verys_mi_consulta')?.periodInMinutes === 1);
  await bg.msg({ type: 'painel_presente', paginaLogin: false }, 7);
  bg.dados.verys_mi_config = { ingestUrl: 'https://exemplo.invalido/ingest', token: 't' };

  await bg.msg({ type: 'lista_pedidos', itens: [{ id: UUID, codigo: '537420', marca: 'hiperchefpizza', assinatura: 'a1', criadoEm: '2026-11-20T22:00:00.000Z' }] });
  await bg.rodada();
  verificar('sem modelo aprendido: consulta ainda é pedida (página pode ter o modelo em memória)', bg.abasMsgs.length === 1 && bg.abasMsgs[0].msg.pedidos[0].id === UUID);
  verificar('pedido vai para a aba logada', bg.abasMsgs[0]?.aba === 7);

  await bg.msg({ type: 'modelo_detalhe', modelo: { url: 'https://api.menuintegrado.com.br/orders/{id}/details', campo: 'uuid' } });
  await bg.msg({ type: 'modelo_detalhe', modelo: { url: 'https://evil.example.com/{id}', campo: 'uuid' } });
  verificar('modelo de outro domínio é ignorado', bg.dados.verys_mi_sync.modelo?.url === 'https://api.menuintegrado.com.br/orders/{id}/details');

  // Consulta voltou com o pedido completo.
  await bg.msg({ type: 'pedido_observado', payload: { id: UUID, displayId: '537420', createdAt: '2026-11-20T22:00:00.000Z', merchant: { name: 'hiperchefpizza' }, customer: {}, statusHistory: [{ status: 'Recebido' }], _origemCaptura: 'consulta' } });
  await bg.msg({ type: 'detalhe_resultado', id: UUID, status: 200, reconhecido: true });
  await esperar();
  verificar('pedido consultado enviado ao VERYS', bg.enviados.some((e) => e.id === UUID));
  bg.abasMsgs.length = 0;
  bg.avancar(1); await bg.rodada();
  verificar('pedido atualizado não é consultado de novo antes de 4 min', bg.abasMsgs.length === 0);
  bg.avancar(3); await bg.msg({ type: 'painel_presente', paginaLogin: false }, 7); await bg.rodada();
  verificar('em andamento: nova consulta após 4 min (motoboy/pagamento)', bg.abasMsgs.length === 1);

  // Mudou na lista → consulta já (mesmo antes dos 4 min).
  await bg.msg({ type: 'pedido_observado', payload: { id: UUID, createdAt: '2026-11-20T22:00:00.000Z', merchant: { name: 'hiperchefpizza' }, customer: {}, statusHistory: [] } });
  bg.abasMsgs.length = 0;
  bg.avancar(1.5);
  await bg.msg({ type: 'lista_pedidos', itens: [{ id: UUID, assinatura: 'a2' }] });
  await bg.rodada();
  verificar('mudou na lista: consulta na rodada seguinte', bg.abasMsgs.length === 1);

  // Entregue → para.
  await bg.msg({ type: 'pedido_observado', payload: { id: UUID, createdAt: '2026-11-20T22:00:00.000Z', merchant: { name: 'hiperchefpizza' }, customer: {}, statusHistory: [{ status: 'Entregue' }] } });
  bg.abasMsgs.length = 0; bg.avancar(10); await bg.msg({ type: 'painel_presente', paginaLogin: false }, 7); await bg.rodada();
  verificar('entregue: não consulta mais', bg.abasMsgs.length === 0);

  // Muitos pedidos novos → no máximo 6 por rodada.
  const muitos = Array.from({ length: 15 }, (_, i) => ({ id: `pedido-novo-${String(i).padStart(4, '0')}`, assinatura: 'x', criadoEm: new Date(bg.agora()).toISOString() }));
  await bg.msg({ type: 'lista_pedidos', itens: muitos });
  bg.abasMsgs.length = 0; await bg.rodada();
  verificar('no máximo 6 consultas por rodada', bg.abasMsgs.length === 1 && bg.abasMsgs[0].msg.pedidos.length === 6, bg.abasMsgs[0]?.msg.pedidos.length);

  // Sessão inválida → pausa 10 min.
  await bg.msg({ type: 'detalhe_resultado', id: 'pedido-novo-0000', status: 401, reconhecido: false, motivo: 'http_401' });
  bg.abasMsgs.length = 0; bg.avancar(2); await bg.msg({ type: 'painel_presente', paginaLogin: false }, 7); await bg.rodada();
  verificar('401: consultas pausadas', bg.abasMsgs.length === 0 && bg.dados.verys_mi_sync.pausaMotivo === 'sessao_mi');
  bg.avancar(9); await bg.msg({ type: 'painel_presente', paginaLogin: false }, 7); await bg.rodada();
  verificar('após a pausa de 10 min, volta a consultar', bg.abasMsgs.length === 1);

  // Aba na tela de login não recebe consulta.
  bg.abasMsgs.length = 0; bg.avancar(5);
  await bg.msg({ type: 'painel_presente', paginaLogin: true }, 7);
  await bg.rodada();
  verificar('aba no login: nenhuma consulta', bg.abasMsgs.length === 0);

  // Resumo para o popup.
  const stats = await bg.msg({ type: 'obter_stats' });
  verificar('popup recebe o resumo da consulta automática', stats.consulta && stats.consulta.modeloAprendido === true && typeof stats.consulta.consultasOk30min === 'number', stats.consulta);
  verificar('storage da consulta sem dado de cliente', !SENSIVEIS.some((v) => JSON.stringify(bg.dados.verys_mi_sync).includes(v)));
}

// ------------------------------------------------------------------ popup
{
  const ctx = { Date, JSON, Array, Object, String, Set };
  vm.createContext(ctx);
  vm.runInContext(POPUP + '\nthis.dp = descreverConexaoPainel; this.ds = descreverSincronizacao;', ctx, { filename: 'popup.js' });
  const agora = Date.parse('2026-11-20T23:00:00.000Z');
  const em = (min) => new Date(agora - min * 60000).toISOString();
  const painelOk = { abasAbertas: 2, paginaLogin: false, ultimaRespostaOkEm: em(1), ultimaFalhaSessaoEm: null };
  const sinal = (lojas, comprovada) => ({ em: em(1), ok: true, situacao: { comprovada, lojas } });

  const caso1 = sinal([{ loja: 'Pizza', motivo: 'pedidos_sem_atualizacao' }], false);
  const p1 = ctx.dp(painelOk, caso1, agora); const s1 = ctx.ds(caso1, agora, null);
  verificar('popup: painel conectado E pedidos NÃO sincronizados (caso real de 20/11)', p1.conectado === true && s1.comprovada === false
    && s1.detalhes.some((d) => d.includes('sem atualização há mais de 20 min')), { p1, s1 });

  const caso2 = sinal([{ loja: 'Pizza', motivo: 'sessao_mi_invalida' }], false);
  const p2 = ctx.dp({ ...painelOk }, caso2, agora); const s2 = ctx.ds(caso2, agora, null);
  verificar('popup: sessão inválida = painel NÃO conectado e pedidos não comprováveis', p2.conectado === false && s2.comprovada === false
    && s2.detalhes[0].includes('não dá para comprovar'), { p2, s2 });

  const caso3 = sinal([{ loja: 'Pizza', motivo: null }], true);
  const s3 = ctx.ds(caso3, agora, { modeloAprendido: true, consultasOk30min: 12, consultasFalha30min: 0, ultimaConsultaOkEm: em(1), pedidosAguardandoDetalhe: 0 });
  verificar('popup: tudo certo = os dois verdes, com a consulta automática descrita', ctx.dp(painelOk, caso3, agora).conectado && s3.comprovada && s3.detalhes[0].includes('12 ok'), s3);

  const s4 = ctx.ds(caso1, agora, { pausadaAte: em(-5), pausaMotivo: 'sessao_mi' });
  verificar('popup: pausa da consulta aparece', s4.detalhes.some((d) => d.includes('pausada')), s4);
  verificar('popup: sem aba = painel NÃO conectado', ctx.dp({ abasAbertas: 0 }, caso3, agora).conectado === false);
}

if (falhou) { console.log('\n=== TESTE FALHOU ==='); process.exitCode = 1; } else console.log('\n=== SINCRONIZAÇÃO AUTOMÁTICA: TODOS OS CASOS CONFIRMADOS ===');
