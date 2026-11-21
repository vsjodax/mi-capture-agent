// Diagnóstico de estrutura (v1.7.1): page-hook.js e background.js REAIS em
// vm.Context. Prova que só rota mascarada e nomes de campos/tipos saem — nunca
// valores (nomes, telefones, endereços, ids) — e que chegam ao sinal.
// Dados sintéticos. Rodar: node tests/diagnostico-estrutura.test.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PAGE_HOOK = fs.readFileSync(join(AQUI, '..', 'page-hook.js'), 'utf-8');
const BACKGROUND = fs.readFileSync(join(AQUI, '..', 'background.js'), 'utf-8');

let falhou = false;
const verificar = (nome, cond, det) => { if (cond) console.log('OK:', nome); else { console.error('FALHA:', nome, det === undefined ? '' : JSON.stringify(det)); falhou = true; } };
const esperar = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// Valores que NUNCA podem aparecer no diagnóstico.
const SENSIVEIS = ['Fulano de Tal', '47999998888', 'Rua das Flores', 'fulano@exemplo.com', '9e0c1d2a-1111-4222-8333-444455556666', 'CUPOM10', '123456'];

function criarPageHook() {
  const postados = []; const fila = []; const timers = [];
  const window_ = {
    fetch: () => { const r = fila.shift(); return Promise.resolve({ status: r.status ?? 200, redirected: false, url: '', clone: () => ({ text: () => Promise.resolve(r.texto) }) }); },
    postMessage: (m) => postados.push(m),
  };
  function XHR() {} XHR.prototype.open = function () {}; XHR.prototype.send = function () {}; XHR.prototype.addEventListener = function () {};
  const sandbox = { window: window_, XMLHttpRequest: XHR, location: { href: 'https://painel.menuintegrado.com.br/pedidos', pathname: '/pedidos' },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, console, JSON, Object, Array, String, RegExp, Date, Promise, Map, Set, URL, Number };
  vm.createContext(sandbox); vm.runInContext(PAGE_HOOK, sandbox, { filename: 'page-hook.js' });
  return { postados, rodarTimers() { while (timers.length) timers.shift()(); }, async buscar(url, texto, status = 200) { fila.push({ texto, status }); await sandbox.window.fetch(url); await esperar(); } };
}

const ph = criarPageHook();
// Lista (formato hipotético do MI, com dados sintéticos sensíveis)
await ph.buscar('/api/v2/stores/123456/orders?status=open&page=2&token=abc', JSON.stringify({
  orders: [{ uuid: '9e0c1d2a-1111-4222-8333-444455556666', code: '123456', status: 'PRODUCING', couponCode: 'CUPOM10',
    customer: { name: 'Fulano de Tal', mobilePhone: '47999998888', email: 'fulano@exemplo.com' }, street: 'Rua das Flores', total: 59.9, cancelled: false }],
  porTelefone: { '47999998888': { ultima: 'x' } },
}));
// Detalhe com componente embutido no HTML
const attr = JSON.stringify({ order: { uuid: 'u', customer: { name: 'Fulano de Tal' }, street: 'Rua das Flores' } }).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
await ph.buscar('/orders/9e0c1d2a-1111-4222-8333-444455556666/details', JSON.stringify({ detailsHTML: `<div data-name="CompleteOrder" data-attributes="${attr}"></div>` }));
// Fora do MI e não-JSON: ignorados
await ph.buscar('https://cdn.outro.com/x.json', '{"a":1}');
await ph.buscar('/pagina', '<html><body>texto</body></html>');
ph.rodarTimers(); // envio agendado (como o navegador faz depois de 30 s)

const sinal = ph.postados.filter((m) => m.tipo === 'sinal_painel').at(-1);
const rotas = sinal?.estado?.rotas ?? [];
const porRota = Object.fromEntries(rotas.map((r) => [r.rota, r]));
const lista = porRota['/api/v2/stores/:id/orders?page&status&token'];
verificar('rota mascarada: id do caminho vira :id e só os NOMES dos parâmetros ficam', !!lista, Object.keys(porRota));
verificar('forma da lista traz nomes de campos e tipos', lista && lista.forma.includes('orders:[{uuid:str,code:str,status:str,couponCode:str,customer:{name:str,mobilePhone:str,email:str},street:str,total:num,cancelled:bool}]'), lista?.forma);
verificar('chave que é dado (telefone) vira :k', lista && lista.forma.includes('porTelefone:{:k:{'), lista?.forma);
const det = porRota['/orders/:id/details'];
verificar('componente do HTML entra com nome e estrutura dos atributos', det && det.forma.includes('detailsHTML:html[CompleteOrder{order:{uuid:str,customer:{name:str},street:str}}]'), det?.forma);
verificar('respostas de outro domínio e HTML comum não entram', rotas.length === 2, rotas.map((r) => r.rota));
verificar('nenhum valor sensível no diagnóstico', !SENSIVEIS.some((v) => JSON.stringify(rotas).includes(v)), SENSIVEIS.filter((v) => JSON.stringify(rotas).includes(v)));
verificar('contagem e status por rota', lista?.vezes === 1 && lista?.status === 200);

// Background: rotas chegam ao sinal enviado ao VERYS
const dados = {}; let onMessage = null; let onAlarm = null; const enviados = [];
const chrome = {
  storage: { local: { get: (k) => { const r = {}; for (const x of [].concat(k)) if (x in dados) r[x] = structuredClone(dados[x]); return Promise.resolve(r); }, set: (p) => { Object.assign(dados, structuredClone(p)); return Promise.resolve(); } } },
  alarms: { get: () => Promise.resolve(undefined), create: () => {}, onAlarm: { addListener: (f) => { onAlarm = f; } } },
  runtime: { onMessage: { addListener: (f) => { onMessage = f; } }, getManifest: () => ({ version: '1.7.1' }) },
};
const sb = { chrome, console: { ...console, error: () => {} }, crypto: globalThis.crypto, setImmediate, Response,
  fetch: (url, o) => { enviados.push(JSON.parse(o.body)); return Promise.resolve(new Response('{"ok":true}', { status: 200 })); } };
vm.createContext(sb); vm.runInContext(BACKGROUND, sb, { filename: 'background.js' });
dados.verys_mi_config = { ingestUrl: 'https://exemplo.invalido/ingest', token: 't' };
await new Promise((r) => onMessage({ type: 'sinal_painel', estado: sinal.estado }, { tab: { id: 3 } }, r));
await onAlarm({ name: 'verys_mi_sinal' }); await esperar();
const s = enviados.at(-1);
verificar('sinal ao VERYS leva diagnostico.rotas', Array.isArray(s?.diagnostico?.rotas) && s.diagnostico.rotas.length === 2, s?.diagnostico);
verificar('sinal ao VERYS sem nenhum valor sensível', !SENSIVEIS.some((v) => JSON.stringify(s).includes(v)));

if (falhou) { console.log('\n=== TESTE FALHOU ==='); process.exitCode = 1; } else console.log('\n=== DIAGNÓSTICO DE ESTRUTURA: TODOS OS CASOS CONFIRMADOS ===');
