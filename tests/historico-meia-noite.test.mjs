// Datas das etapas do pedido (v1.8.2) — page-hook.js REAL em vm.Context, com
// relógio controlado e fuso de São Paulo. Casos: virada da meia-noite com
// linhas fora de ordem (caso real 21/11/2026, #644539), pedido agendado,
// etapa anterior à criação, entrega mais de um dia depois, pedido antigo ainda
// em andamento. Regra: nunca inventar data — sem data única segura, a etapa
// fica de fora (contada em _historicoAmbiguo). Dados sintéticos.
// Rodar: node tests/historico-meia-noite.test.mjs
process.env.TZ = 'America/Sao_Paulo';
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PAGE_HOOK = fs.readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'page-hook.js'), 'utf-8');
let falhou = false;
const verificar = (nome, cond, det) => { if (cond) console.log('OK:', nome); else { console.error('FALHA:', nome, det === undefined ? '' : JSON.stringify(det)); falhou = true; } };
const esperar = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// createdAt/deliveredAt/agora em horário de São Paulo ("2026-11-20 23:58").
const sp = (s) => new Date(`${s.replace(' ', 'T')}:00-03:00`);

async function capturar({ criado, entregue = null, agora, linhas }) {
  const postados = [];
  const order = { uuid: 'aaaaaaaa-1111-4222-8333-444455556666', code: '644539', createdAt: sp(criado).toISOString(), deliveredAt: entregue ? sp(entregue).toISOString() : null, rootResource: { slug: 'x' }, customer: {}, items: [] };
  const attr = JSON.stringify({ order }).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const html = `<div data-name="CompleteOrder" data-attributes="${attr}"></div>` + linhas.map(([r, v]) => `<tr><td><small>${r}</small></td><td class="pl-2">${v}</td></tr>`).join('');
  const texto = JSON.stringify({ detailsHTML: html });
  const agoraMs = sp(agora).getTime();
  class RelogioFixo extends Date { constructor(...a) { super(...(a.length ? a : [agoraMs])); } static now() { return agoraMs; } }
  const window_ = { fetch: () => Promise.resolve({ status: 200, redirected: false, url: '', clone: () => ({ text: () => Promise.resolve(texto) }) }), postMessage: (m) => postados.push(m) };
  function XHR() {} XHR.prototype.open = function () {}; XHR.prototype.send = function () {}; XHR.prototype.addEventListener = function () {}; XHR.prototype.setRequestHeader = function () {};
  const sb = { window: window_, XMLHttpRequest: XHR, location: { href: 'https://www.menuintegrado.com.br/panel', pathname: '/panel' }, setTimeout: () => 0, console, JSON, Object, Array, String, RegExp, Date: RelogioFixo, Promise, Map, Set, URL, Number, encodeURIComponent };
  vm.createContext(sb); vm.runInContext(PAGE_HOOK, sb);
  await sb.window.fetch('/panel/franchises/x/orders/aaaaaaaa-1111-4222-8333-444455556666.json'); await esperar();
  const p = postados.find((m) => m.payload)?.payload;
  const fmt = (iso) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  return { h: Object.fromEntries((p?.statusHistory ?? []).map((x) => [x.status, fmt(x.timestamp)])), prev: p?.previsaoEntrega ? fmt(p.previsaoEntrega) : null, amb: p?._historicoAmbiguo ?? 0 };
}

// 1) Caso real: criado 20/11 23:58, linhas FORA de ordem, entregue 00:15.
const linhasReais = [['Produzido', '00:10'], ['Despachado', '00:10'], ['Enviado', '00:11'], ['Entregue', '00:15'], ['Recebido', '23:58'], ['Produzindo', '23:58'], ['Entrega prevista', '00:40']];
const r1 = await capturar({ criado: '2026-11-20 23:58', entregue: '2026-11-21 00:15', agora: '2026-11-21 01:54', linhas: linhasReais });
verificar('caso real: Recebido/Produzindo em 20/11 23:58', r1.h.Recebido === '20/11 23:58' && r1.h.Produzindo === '20/11 23:58', r1);
verificar('caso real: Produzido/Despachado/Enviado/Entregue em 21/11', r1.h.Produzido === '21/11 00:10' && r1.h.Despachado === '21/11 00:10' && r1.h.Enviado === '21/11 00:11' && r1.h.Entregue === '21/11 00:15', r1);
verificar('caso real: previsão em 21/11 00:40; nada ambíguo', r1.prev === '21/11 00:40' && r1.amb === 0, r1);

// 2) Mesmo caso ainda em andamento (sem deliveredAt), consultado às 00:20.
const r2 = await capturar({ criado: '2026-11-20 23:58', agora: '2026-11-21 00:20', linhas: [['Enviado', '00:11'], ['Recebido', '23:58'], ['Produzindo', '23:58']] });
verificar('em andamento atravessando a meia-noite: Enviado em 21/11 00:11', r2.h.Enviado === '21/11 00:11' && r2.h.Recebido === '20/11 23:58' && r2.amb === 0, r2);

// 3) Pedido AGENDADO: criado 20/11 10:00 para 21/11 20:15.
const r3 = await capturar({ criado: '2026-11-20 10:00', entregue: '2026-11-21 20:15', agora: '2026-11-21 21:00',
  linhas: [['Recebido', '10:00'], ['Produzindo', '19:30'], ['Enviado', '20:00'], ['Entregue', '20:15'], ['Entrega prevista', '20:30']] });
verificar('agendado: Recebido no dia da criação e Entregue pelo horário completo do MI', r3.h.Recebido === '20/11 10:00' && r3.h.Entregue === '21/11 20:15', r3);
verificar('agendado: Produzindo/Enviado (dois dias possíveis) ficam de fora, sem data inventada', !('Produzindo' in r3.h) && !('Enviado' in r3.h) && r3.amb >= 2, r3);

// 4) Etapa ANTERIOR à criação (aceite 40 min antes do registro).
const r4 = await capturar({ criado: '2026-11-20 19:30', entregue: '2026-11-20 20:20', agora: '2026-11-20 21:00', linhas: [['Recebido', '18:50'], ['Produzindo', '19:35'], ['Entregue', '20:20']] });
verificar('etapa anterior à criação fica no mesmo dia (20/11 18:50), não no dia seguinte', r4.h.Recebido === '20/11 18:50' && r4.h.Produzindo === '20/11 19:35' && r4.amb === 0, r4);

// 5) Entrega MAIS DE UM DIA depois (não agendado): criado 20/11 19:00, entregue 21/11 21:00.
const r5 = await capturar({ criado: '2026-11-20 19:00', entregue: '2026-11-21 21:00', agora: '2026-11-21 22:00', linhas: [['Recebido', '19:00'], ['Produzindo', '19:05'], ['Entregue', '21:00']] });
verificar('entrega um dia depois: Entregue 21/11 21:00 (horário do MI), Recebido 20/11 19:00', r5.h.Entregue === '21/11 21:00' && r5.h.Recebido === '20/11 19:00', r5);
verificar('entrega um dia depois: Produzindo 19:05 (20/11 ou 21/11) fica de fora', !('Produzindo' in r5.h) && r5.amb === 1, r5);

// 6) Pedido antigo AINDA em andamento, consultado 2 dias depois (recuperação).
const r6 = await capturar({ criado: '2026-11-20 19:00', agora: '2026-11-22 20:00', linhas: [['Recebido', '19:00'], ['Enviado', '19:40']] });
verificar('antigo em andamento: Recebido mantido; Enviado sem data única fica de fora', r6.h.Recebido === '20/11 19:00' && !('Enviado' in r6.h) && r6.amb === 1, r6);

// 7) Pedido comum do dia.
const r7 = await capturar({ criado: '2026-11-20 19:30', entregue: '2026-11-20 20:20', agora: '2026-11-20 21:00', linhas: [['Recebido', '19:30'], ['Produzindo', '19:31'], ['Enviado', '20:05'], ['Entregue', '20:20']] });
verificar('pedido comum: tudo em 20/11, nada ambíguo', r7.h.Recebido === '20/11 19:30' && r7.h.Enviado === '20/11 20:05' && r7.h.Entregue === '20/11 20:20' && r7.amb === 0, r7);

// 8) Arredondamento: Recebido 1 min antes da criação.
const r8 = await capturar({ criado: '2026-11-20 19:30', agora: '2026-11-20 19:45', linhas: [['Recebido', '19:29']] });
verificar('Recebido 1 min antes da criação fica no mesmo dia', r8.h.Recebido === '20/11 19:29', r8);

// 9) Criado depois da meia-noite.
const r9 = await capturar({ criado: '2026-11-21 00:16', entregue: '2026-11-21 00:50', agora: '2026-11-21 01:00', linhas: [['Recebido', '00:16'], ['Entregue', '00:50']] });
verificar('criado após a meia-noite: tudo em 21/11', r9.h.Recebido === '21/11 00:16' && r9.h.Entregue === '21/11 00:50', r9);

// 10) Data completa no HTML vale direto.
const r10 = await capturar({ criado: '2026-11-18 22:00', agora: '2026-11-21 10:00', linhas: [['Recebido', '18/11/2026 22:00'], ['Entregue', '19/11 00:30']] });
verificar('data completa no HTML é usada como está', r10.h.Recebido === '18/11 22:00' && r10.h.Entregue === '19/11 00:30', r10);

// 11) Entregue sem linha no HTML, mas com deliveredAt: entra pelo horário do MI.
const r11 = await capturar({ criado: '2026-11-20 19:30', entregue: '2026-11-20 20:20', agora: '2026-11-20 21:00', linhas: [['Recebido', '19:30']] });
verificar('Entregue só no deliveredAt entra com o horário do MI', r11.h.Entregue === '20/11 20:20', r11);

if (falhou) { console.log('\n=== TESTE FALHOU ==='); process.exitCode = 1; } else console.log('\n=== DATAS DAS ETAPAS: TODOS OS CASOS CONFIRMADOS ===');
