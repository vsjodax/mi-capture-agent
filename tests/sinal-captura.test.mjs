// Teste comportamental (Node puro, sem dependências) do sinal de
// funcionamento da v1.7.0 — carrega os arquivos REAIS (background.js e
// page-hook.js) do disco dentro de um vm.Context, mesmo padrão dos outros
// testes. Nenhum dado real de cliente: ids e horários sintéticos.
//
// Rodar: node tests/sinal-captura.test.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));
const BACKGROUND = fs.readFileSync(join(AQUI, '..', 'background.js'), 'utf-8');
const PAGE_HOOK = fs.readFileSync(join(AQUI, '..', 'page-hook.js'), 'utf-8');

let falhou = false;
function verificar(nome, condicao, detalhe) {
  if (condicao) console.log('OK:', nome);
  else {
    console.error('FALHA:', nome, detalhe === undefined ? '' : JSON.stringify(detalhe));
    falhou = true;
  }
}

async function esperarMicrotasks() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------- background
function criarBackground() {
  const dados = {};
  const alarmes = new Map();
  let onAlarm = null;
  let onMessage = null;
  const chamadasFetch = [];
  const respostas = [];

  const chrome = {
    storage: {
      local: {
        get: (k) => {
          const ks = Array.isArray(k) ? k : [k];
          const r = {};
          for (const x of ks) if (x in dados) r[x] = structuredClone(dados[x]);
          return Promise.resolve(r);
        },
        set: (patch) => { Object.assign(dados, structuredClone(patch)); return Promise.resolve(); },
      },
    },
    alarms: {
      get: (n) => Promise.resolve(alarmes.get(n)),
      create: (n, o) => { alarmes.set(n, o); },
      onAlarm: { addListener: (fn) => { onAlarm = fn; } },
    },
    runtime: {
      onMessage: { addListener: (fn) => { onMessage = fn; } },
      getManifest: () => ({ version: '1.7.0' }),
    },
  };

  const sandbox = {
    chrome,
    console: { ...console, error: () => {} },
    fetch: (url, opts) => {
      chamadasFetch.push({ url, opts, corpo: JSON.parse(opts.body) });
      const r = respostas.shift() ?? { status: 200, corpo: { ok: true } };
      return Promise.resolve(new Response(JSON.stringify(r.corpo), { status: r.status }));
    },
    crypto: globalThis.crypto,
    setImmediate,
    Response,
  };
  vm.createContext(sandbox);
  vm.runInContext(BACKGROUND, sandbox, { filename: 'background.js' });

  const mensagem = (msg, tabId = null) =>
    new Promise((resolve) => onMessage(msg, tabId == null ? {} : { tab: { id: tabId } }, resolve));
  const alarme = async (nome) => { await onAlarm({ name: nome }); await esperarMicrotasks(); };
  return { dados, alarmes, chamadasFetch, respostas, mensagem, alarme };
}

async function testarBackground() {
  const bg = criarBackground();
  await esperarMicrotasks();

  verificar('alarme do sinal criado na inicialização, a cada 2 min',
    bg.alarmes.get('verys_mi_sinal')?.periodInMinutes === 2, Object.fromEntries(bg.alarmes));

  // Sem configuração: não envia nada.
  await bg.alarme('verys_mi_sinal');
  verificar('sem endpoint/token configurados, nenhum sinal é enviado', bg.chamadasFetch.length === 0);

  bg.dados.verys_mi_config = { ingestUrl: 'https://exemplo.invalido/ingest-mi-order', token: 'token-teste' };

  // Painel aberto, sessão válida, 3 respostas do MI, 1 pedido visto e enviado com sucesso.
  await bg.mensagem({ type: 'painel_presente', paginaLogin: false }, 7);
  const okEm = new Date(Date.now() - 20000).toISOString();
  await bg.mensagem({ type: 'sinal_painel', estado: { ultimaRespostaOkEm: okEm, ultimaFalhaSessaoEm: null, respostasOk: 3 } }, 7);
  await bg.mensagem({ type: 'pedido_observado', payload: { id: 'pedido-a', customer: { name: 'Fulano' } } }, 7);
  await esperarMicrotasks();

  await bg.alarme('verys_mi_sinal');
  const s1 = bg.chamadasFetch.at(-1);
  verificar('sinal vai para o endpoint com o token da loja',
    s1?.url === 'https://exemplo.invalido/ingest-mi-order' && s1.opts.headers.Authorization === 'Bearer token-teste');
  verificar('sinal identifica tipo, versão e agente', s1?.corpo.tipo === 'sinal_captura' && s1.corpo.versaoSinal === 1
    && s1.corpo.versao === '1.7.0' && typeof s1.corpo.agenteId === 'string' && s1.corpo.agenteId.length >= 8, s1?.corpo);
  verificar('painel: 1 aba aberta, fora do login, última resposta e 3 respostas em 30 min',
    s1?.corpo.painel.abasAbertas === 1 && s1.corpo.painel.paginaLogin === false
    && s1.corpo.painel.ultimaRespostaOkEm === okEm && s1.corpo.painel.respostasOk30min === 3, s1?.corpo.painel);
  verificar('fila de reenvio vazia', s1?.corpo.fila.pendentes === 0 && s1.corpo.fila.maisAntigaEm === null && s1.corpo.fila.itens.length === 0, s1?.corpo.fila);
  verificar('pedido visto aparece só por id, horário e marca', s1?.corpo.pedidos.observados.length === 1
    && JSON.stringify(Object.keys(s1.corpo.pedidos.observados[0]).sort()) === JSON.stringify(['id', 'marca', 'vistoEm'])
    && s1.corpo.pedidos.observados[0].id === 'pedido-a' && s1.corpo.pedidos.observados[0].marca === null && typeof s1.corpo.pedidos.ultimoVistoEm === 'string', s1?.corpo.pedidos);
  verificar('nenhum dado de cliente no sinal', !JSON.stringify(s1?.corpo).includes('Fulano'));
  verificar('resultado do sinal guardado para o popup (sem situação do VERYS na resposta = null)', bg.dados.verys_mi_ultimo_sinal?.ok === true && bg.dados.verys_mi_ultimo_sinal.situacao === null);

  // O mesmo agente é mantido entre sinais.
  const agente = s1.corpo.agenteId;

  // Pedido recusado (422) fica na fila de reenvio e aparece no sinal.
  bg.respostas.push({ status: 422, corpo: { ok: false, avisos: ['x'] } });
  await bg.mensagem({ type: 'pedido_observado', payload: { id: 'pedido-b', merchant: { id: 'hiperchefpizza', name: 'hiperchefpizza' }, customer: { name: 'Ciclano' } } }, 7);
  await esperarMicrotasks();
  await bg.alarme('verys_mi_sinal');
  const s2 = bg.chamadasFetch.at(-1);
  verificar('pedido recusado entra na fila de reenvio do sinal',
    s2?.corpo.fila.pendentes === 1 && typeof s2.corpo.fila.maisAntigaEm === 'string', s2?.corpo.fila);
  verificar('pedido recusado também consta como visto, com a marca (para a conferência por loja)',
    s2?.corpo.pedidos.observados.some((o) => o.id === 'pedido-b' && o.marca === 'hiperchefpizza'));
  verificar('fila de reenvio leva id e marca de cada pedido, sem dado de cliente',
    JSON.stringify(s2?.corpo.fila.itens) === JSON.stringify([{ id: 'pedido-b', marca: 'hiperchefpizza' }]) && !JSON.stringify(s2?.corpo).includes('Ciclano'), s2?.corpo.fila);
  verificar('mesmo agente entre sinais', s2?.corpo.agenteId === agente);

  // Tela de login e sessão caída.
  await bg.mensagem({ type: 'painel_presente', paginaLogin: true }, 7);
  const falhaEm = new Date().toISOString();
  await bg.mensagem({ type: 'sinal_painel', estado: { ultimaRespostaOkEm: okEm, ultimaFalhaSessaoEm: falhaEm, respostasOk: 0 } }, 7);
  await bg.alarme('verys_mi_sinal');
  const s3 = bg.chamadasFetch.at(-1);
  verificar('tela de login e falha de sessão chegam no sinal',
    s3?.corpo.painel.paginaLogin === true && s3.corpo.painel.ultimaFalhaSessaoEm === falhaEm, s3?.corpo.painel);
  verificar('horário de resposta nunca regride quando uma aba manda um mais antigo', s3?.corpo.painel.ultimaRespostaOkEm === okEm);

  // Aba que parou de informar presença há mais de 3 min não conta.
  bg.dados.verys_mi_painel.abas = { 7: { vistoEm: new Date(Date.now() - 4 * 60000).toISOString(), paginaLogin: false } };
  await bg.alarme('verys_mi_sinal');
  verificar('aba sem presença há 4 min não conta como aberta', bg.chamadasFetch.at(-1)?.corpo.painel.abasAbertas === 0);

  // Pedido visto há mais de 24 h sai da lista.
  bg.dados.verys_mi_observados['pedido-velho'] = { vistoEm: new Date(Date.now() - 25 * 3600000).toISOString(), marca: null };
  await bg.alarme('verys_mi_sinal');
  verificar('pedido visto há mais de 24 h não é enviado',
    !bg.chamadasFetch.at(-1)?.corpo.pedidos.observados.some((o) => o.id === 'pedido-velho'));

  // Mensagens simultâneas de abas diferentes não se sobrescrevem.
  for (let i = 0; i < 5; i++) bg.respostas.push({ status: 200, corpo: { ok: true } });
  await Promise.all([1, 2, 3, 4, 5].map((i) => bg.mensagem({ type: 'pedido_observado', payload: { id: `simultaneo-${i}` } }, 10 + i)));
  await esperarMicrotasks();
  const vistos = Object.keys(bg.dados.verys_mi_observados).filter((k) => k.startsWith('simultaneo-'));
  verificar('5 pedidos vistos ao mesmo tempo ficam todos registrados', vistos.length === 5, vistos);

  // Situação conferida pelo VERYS fica guardada para o popup.
  const situacaoVerys = { comprovada: false, verificadoEm: new Date().toISOString(), lojas: [{ loja: 'Pizza', motivo: 'pedidos_atualizacao_pendente' }, { loja: 'Burger', motivo: null }] };
  bg.respostas.push({ status: 200, corpo: { ok: true, situacao: situacaoVerys } });
  await bg.alarme('verys_mi_sinal');
  verificar('situação devolvida pelo VERYS fica guardada para o popup', JSON.stringify(bg.dados.verys_mi_ultimo_sinal?.situacao) === JSON.stringify(situacaoVerys));

  // Falha de rede no sinal fica registrada para o popup.
  const fetchAntes = bg.chamadasFetch.length;
  bg.respostas.push({ status: 401, corpo: { error: 'token_invalido' } });
  await bg.alarme('verys_mi_sinal');
  verificar('sinal recusado fica registrado como falha', bg.chamadasFetch.length === fetchAntes + 1
    && bg.dados.verys_mi_ultimo_sinal?.ok === false && bg.dados.verys_mi_ultimo_sinal.motivo === 'http_401', bg.dados.verys_mi_ultimo_sinal);
}

// ---------------------------------------------------------------- page-hook
function criarPageHook() {
  const postados = [];
  const filaFetch = [];
  const timers = [];

  class XHRFake {
    constructor() { this.listeners = {}; }
    open(_m, url) { this.urlAberta = url; }
    send() {}
    addEventListener(ev, fn) { this.listeners[ev] = fn; }
    disparar(status, responseURL, texto = '{}') {
      this.status = status; this.responseURL = responseURL; this.responseText = texto;
      this.listeners.load?.();
    }
  }

  const window_ = {
    fetch: () => {
      const r = filaFetch.shift();
      if (!r) throw new Error('fetch sem resposta programada');
      return Promise.resolve({
        status: r.status, redirected: !!r.redirecionadaPara, url: r.redirecionadaPara ?? '',
        clone: () => ({ text: () => Promise.resolve(r.texto ?? '{}') }),
      });
    },
    postMessage: (m) => postados.push(m),
  };

  const sandbox = {
    window: window_, XMLHttpRequest: XHRFake, location: { href: 'https://painel.menuintegrado.com.br/pedidos', pathname: '/pedidos' },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    console, JSON, Object, Array, String, RegExp, Date, Promise, Map, URL,
  };
  vm.createContext(sandbox);
  vm.runInContext(PAGE_HOOK, sandbox, { filename: 'page-hook.js' });

  return {
    postados, timers,
    sinais: () => postados.filter((m) => m.tipo === 'sinal_painel'),
    async buscar(url, status, extra = {}) {
      filaFetch.push({ status, ...extra });
      await sandbox.window.fetch(url);
      await esperarMicrotasks();
    },
    xhr(url, status, responseURL, texto) {
      const x = new sandbox.XMLHttpRequest();
      x.open('GET', url);
      x.send();
      x.disparar(status, responseURL, texto);
    },
  };
}

async function testarPageHook() {
  const ph = criarPageHook();

  await ph.buscar('/api/orders?status=open', 200);
  verificar('1ª resposta 2xx do painel emite sinal na hora', ph.sinais().length === 1
    && typeof ph.sinais()[0].estado.ultimaRespostaOkEm === 'string' && ph.sinais()[0].estado.respostasOk === 1, ph.sinais());
  verificar('sinal do painel não carrega conteúdo da resposta (v1.7.1: + rotas, só estrutura)', Object.keys(ph.sinais()[0].estado).sort().join() === 'respostasOk,rotas,ultimaFalhaSessaoEm,ultimaRespostaOkEm' && ph.sinais()[0].estado.rotas.every((r) => !JSON.stringify(r).includes('Teste')), ph.sinais()[0].estado);

  await ph.buscar('/api/orders?status=open', 200);
  await ph.buscar('/api/orders?status=open', 200);
  verificar('respostas seguintes em menos de 30 s são agrupadas (um único envio agendado)',
    ph.sinais().length === 1 && ph.timers.length === 1 && ph.timers[0].ms > 0 && ph.timers[0].ms <= 30000, ph.timers);
  ph.timers[0].fn();
  verificar('envio agendado leva a contagem acumulada', ph.sinais().length === 2 && ph.sinais()[1].estado.respostasOk === 2, ph.sinais()[1]);

  await ph.buscar('https://cdn.outro-dominio.com/lib.js', 200);
  await ph.buscar('https://www.google-analytics.com/collect', 200);
  verificar('respostas de outros domínios são ignoradas', ph.sinais().length === 2 && ph.timers.length === 1);

  await ph.buscar('/api/orders', 500);
  verificar('erro 5xx do MI não conta como sessão válida nem inválida', ph.sinais().length === 2 && ph.timers.length === 1);

  await ph.buscar('/api/orders', 401);
  const s401 = ph.sinais().at(-1);
  verificar('401 do painel emite falha de sessão na hora', ph.sinais().length === 3 && typeof s401.estado.ultimaFalhaSessaoEm === 'string', s401);

  await ph.buscar('/api/orders', 200, { redirecionadaPara: 'https://painel.menuintegrado.com.br/login?next=/pedidos' });
  verificar('resposta redirecionada para o login é falha de sessão', ph.sinais().length === 4
    && ph.sinais().at(-1).estado.ultimaFalhaSessaoEm >= s401.estado.ultimaFalhaSessaoEm);

  const antesXhr = ph.sinais().length;
  const okAntes = ph.sinais().at(-1).estado.ultimaRespostaOkEm;
  ph.xhr('/auth/refresh', 200, 'https://painel.menuintegrado.com.br/auth/refresh');
  verificar('XHR a /auth/refresh com 200 (sem redirecionamento) é sessão válida, não login',
    ph.sinais().length === antesXhr && ph.timers.length === 2, { sinais: ph.sinais().length, timers: ph.timers.length });
  ph.xhr('/api/orders', 200, 'https://painel.menuintegrado.com.br/entrar');
  verificar('XHR redirecionado para /entrar é falha de sessão', ph.sinais().length === antesXhr + 1 && okAntes !== undefined);
  ph.xhr('/api/orders', 403, 'https://painel.menuintegrado.com.br/api/orders');
  verificar('XHR 403 é falha de sessão', ph.sinais().length === antesXhr + 2);

  // Captura de pedido continua igual (sem `tipo`, mesmo canal).
  const order = { uuid: 'uuid-sintetico-1', code: '1', createdAt: '2026-11-20T18:00:00.000Z', rootResource: { slug: 'marca' }, customer: { uuid: 'c', name: 'Teste' }, items: [] };
  const attr = JSON.stringify({ order }).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  await ph.buscar('/api/orders/detail', 200, { texto: JSON.stringify({ detailsHTML: `<div data-name="CompleteOrder" data-attributes="${attr}"></div>` }) });
  const pedidos = ph.postados.filter((m) => !m.tipo);
  verificar('pedido continua sendo emitido como antes', pedidos.length === 1 && pedidos[0].payload.id === 'uuid-sintetico-1', pedidos);
}

// ---------------------------------------------------------------- popup
function testarPopup() {
  const POPUP = fs.readFileSync(join(AQUI, '..', 'popup.js'), 'utf-8');
  const ctx = { Date, JSON, Array, Object, String };
  vm.createContext(ctx);
  vm.runInContext(POPUP + '\nthis.descreverSincronizacao = descreverSincronizacao;', ctx, { filename: 'popup.js' });
  const agora = Date.parse('2026-11-20T18:00:00.000Z');
  const em = (min) => new Date(agora - min * 60000).toISOString();
  const d = (s) => ctx.descreverSincronizacao(s, agora);
  verificar('popup: sem sinal enviado = NÃO comprovada', d(null).comprovada === false && /NÃO comprovada/.test(d(null).titulo));
  verificar('popup: sinal recusado = NÃO comprovada, com o motivo', d({ em: em(1), ok: false, motivo: 'http_401' }).comprovada === false
    && d({ em: em(1), ok: false, motivo: 'http_401' }).detalhes[0].includes('http_401'));
  verificar('popup: sinal antigo (> 5 min) = NÃO comprovada, mesmo se o VERYS tinha comprovado',
    d({ em: em(6), ok: true, situacao: { comprovada: true, lojas: [] } }).comprovada === false);
  verificar('popup: resposta sem situação (servidor antigo) = NÃO comprovada', d({ em: em(1), ok: true, situacao: null }).comprovada === false);
  const pend = d({ em: em(1), ok: true, situacao: { comprovada: false, lojas: [{ loja: 'HiperChef Pizza Premium', motivo: 'pedidos_atualizacao_pendente' }, { loja: 'HiperChef Burger Premium', motivo: null }] } });
  verificar('popup: motivo por loja aparece por extenso, só nas lojas com problema', pend.comprovada === false && pend.detalhes.length === 1
    && pend.detalhes[0] === 'HiperChef Pizza Premium: há pedido com atualização ainda não sincronizada', pend.detalhes);
  const ok = d({ em: em(1), ok: true, situacao: { comprovada: true, lojas: [{ loja: 'Pizza', motivo: null }] } });
  verificar('popup: só diz comprovada quando o VERYS comprovou num sinal recente', ok.comprovada === true && /comprovada pelo VERYS/.test(ok.titulo));
}

await testarBackground();
await testarPageHook();
testarPopup();
if (falhou) {
  console.log('\n=== TESTE FALHOU ===');
  process.exitCode = 1;
} else {
  console.log('\n=== SINAL DE CAPTURA: TODOS OS CASOS CONFIRMADOS ===');
}
