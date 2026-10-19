// Teste comportamental (Node puro, sem dependências, sem Chrome) do
// background.js real — mocka só chrome.storage.local/chrome.alarms/
// chrome.runtime e carrega o ARQUIVO DO DISCO dentro de um vm.Context, pra
// provar o comportamento de retentativa sem precisar carregar a extensão
// de verdade no navegador.
//
// REGRA CRÍTICA deste teste: `fetch` devolve objetos REAIS da classe
// global `Response` (Node 18+, mesma usada pelo fetch do browser) —
// NUNCA um objeto `{ok: <valor escolhido na mão>, status, text}`. Um mock
// à mão poderia "decidir" ok:false pra um status 207 mesmo sem isso ser
// verdade (207 está dentro de 200-299, e a spec do fetch define
// `Response.ok = status >= 200 && status <= 299` — ou seja, `new
// Response(..., {status:207}).ok` é `true` de verdade). Só um Response
// real prova se o código trata 207 corretamente ou não.
//
// Rodar: node tests/background.retry.test.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));
const CAMINHO_REAL = join(AQUI, '..', 'background.js');
const codigoFonte = fs.readFileSync(CAMINHO_REAL, 'utf-8');

let falhou = false;
function falhar(msg) {
  console.error('FALHA:', msg);
  falhou = true;
}
function ok(msg) {
  console.log('OK:', msg);
}

// Confirma a premissa antes de tudo — se isto falhar, o resto do arquivo
// não significa nada (prova que o ambiente Node realmente define
// Response.ok como a spec do fetch diz, não como eu gostaria que fosse).
function confirmarPremissaResponseOk() {
  const r207 = new Response('{}', { status: 207 });
  if (r207.ok !== true) {
    throw new Error(`Premissa falhou: new Response(status:207).ok deveria ser true (fetch spec), veio ${r207.ok}`);
  }
  ok('premissa confirmada: Response real com status 207 tem .ok === true (207 é 2xx) — não é um mock arbitrário.');
}

function criarChromeFake() {
  const dados = {};
  const alarmesCriados = new Map();
  let onAlarmListener = null;
  let onMessageListener = null;

  return {
    storage: {
      local: {
        get: (chaveOuChaves) => {
          const chaves = Array.isArray(chaveOuChaves) ? chaveOuChaves : [chaveOuChaves];
          const resultado = {};
          for (const k of chaves) if (k in dados) resultado[k] = dados[k];
          return Promise.resolve(resultado);
        },
        set: (patch) => {
          Object.assign(dados, patch);
          return Promise.resolve();
        },
      },
    },
    alarms: {
      get: (nome) => Promise.resolve(alarmesCriados.get(nome)),
      create: (nome, opts) => {
        alarmesCriados.set(nome, opts);
      },
      onAlarm: { addListener: (fn) => { onAlarmListener = fn; } },
    },
    runtime: {
      onMessage: { addListener: (fn) => { onMessageListener = fn; } },
    },
    _inspecionar: () => ({
      dados,
      alarmesCriados,
      dispararAlarme: (nome) => onAlarmListener?.({ name: nome }),
      enviarMensagem: onMessageListener,
    }),
  };
}

async function esperarMicrotasks() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

// Monta uma resposta REAL de fetch (classe Response global do Node),
// nunca um objeto à mão com `ok` escolhido manualmente.
function respostaReal(status, corpoObj) {
  return Promise.resolve(new Response(JSON.stringify(corpoObj), { status }));
}

async function rodarCenario() {
  confirmarPremissaResponseOk();

  const filasFetch = [];
  const chrome = criarChromeFake();

  const sandbox = {
    chrome,
    console,
    fetch: () => {
      const proxima = filasFetch.shift();
      if (!proxima) throw new Error('Teste chamou fetch mais vezes do que o esperado');
      if (proxima.erroDeRede) return Promise.reject(new Error('rede indisponível (simulado)'));
      return respostaReal(proxima.status, proxima.corpo);
    },
    setImmediate,
    Promise,
    Date,
    Object,
    Array,
    JSON,
    Map,
    Error,
    Response, // precisa existir no sandbox só pra fetch() poder construir — background.js em si não usa Response diretamente
  };
  vm.createContext(sandbox);
  vm.runInContext(codigoFonte, sandbox, { filename: 'background.js (v1.6.7)' });

  await sandbox.chrome.storage.local.set({
    verys_mi_config: { ingestUrl: 'https://exemplo.invalido/ingest-mi-order', token: 'token-teste' },
  });

  const { dados, alarmesCriados, dispararAlarme, enviarMensagem } = chrome._inspecionar();
  const payload = { id: 'uuid-pedido-teste-422', displayId: '999999' };

  // ---- PASSO 1: HTTP 207 real + corpo {ok:false} — o caso que a versão anterior do teste simulava errado ----
  filasFetch.push({ status: 207, corpo: { ok: false, avisos: ['falha_ao_sincronizar_taxa_entrega'] } });
  await new Promise((resolve) => enviarMensagem({ type: 'pedido_observado', payload }, null, resolve));
  await esperarMicrotasks();

  const statsA = dados['verys_mi_stats'];
  const pendentesA = dados['verys_mi_pendentes'] || {};
  if (statsA?.enviados === 0 && statsA?.falhas === 1) {
    ok('207 (status real, Response.ok=true) com corpo {ok:false} NÃO registrou sucesso — o código lê o corpo, não só resposta.ok.');
  } else {
    falhar(`esperado enviados=0/falhas=1 com 207+ok:false, obtido enviados=${statsA?.enviados}/falhas=${statsA?.falhas}`);
  }
  if (pendentesA['uuid-pedido-teste-422']) {
    ok('pedido ficou pendente mesmo com status HTTP 2xx (207), porque o corpo dizia ok:false.');
  } else {
    falhar('pedido deveria ter ficado pendente com 207+ok:false e não ficou.');
  }

  // ---- PASSO 2: retentativa com 422 real + corpo {ok:false} (o status que o ingest-mi-order usa de fato hoje) ----
  filasFetch.push({ status: 422, corpo: { ok: false, avisos: ['falha_ao_sincronizar_taxa_entrega'] } });
  await dispararAlarme('verys_mi_retry_pendentes');
  await esperarMicrotasks();

  const statsB = dados['verys_mi_stats'];
  const pendentesB = dados['verys_mi_pendentes'] || {};
  if (Object.keys(pendentesB).length === 1 && pendentesB['uuid-pedido-teste-422']?.tentativas === 2 && statsB.falhas === 2) {
    ok('422 (fora de 2xx) + ok:false: continua pendente (tentativas=2), sem duplicar entrada.');
  } else {
    falhar(`esperado 1 pendente/tentativas=2/falhas=2, obtido ${JSON.stringify(pendentesB)} falhas=${statsB.falhas}`);
  }

  // ---- PASSO 3: retentativa com sucesso real (200 + {ok:true}) ----
  filasFetch.push({ status: 200, corpo: { ok: true, avisos: [] } });
  await dispararAlarme('verys_mi_retry_pendentes');
  await esperarMicrotasks();

  const statsC = dados['verys_mi_stats'];
  const pendentesC = dados['verys_mi_pendentes'] || {};
  if (!pendentesC['uuid-pedido-teste-422'] && statsC.enviados === 1 && statsC.falhas === 2) {
    ok('200 real + {ok:true}: saiu da fila de pendentes, "enviados" incrementou só agora (sucesso real), "falhas" não regrediu.');
  } else {
    falhar(`esperado sem pendente/enviados=1/falhas=2, obtido pendentes=${JSON.stringify(pendentesC)} enviados=${statsC.enviados}/falhas=${statsC.falhas}`);
  }

  // ---- PASSO 4: caso-armadilha — status 200 real, mas corpo {ok:false} (nunca deveria acontecer no ingest-mi-order de hoje, mas o código não pode confiar só no status) ----
  const payload2 = { id: 'uuid-pedido-armadilha-200-ok-false' };
  filasFetch.push({ status: 200, corpo: { ok: false, avisos: ['cenario_hipotetico'] } });
  await new Promise((resolve) => enviarMensagem({ type: 'pedido_observado', payload: payload2 }, null, resolve));
  await esperarMicrotasks();

  const pendentesD = dados['verys_mi_pendentes'] || {};
  if (pendentesD['uuid-pedido-armadilha-200-ok-false']) {
    ok('mesmo com status 200 (2xx), um corpo {ok:false} é tratado como falha/pendente — nunca confia só no status HTTP.');
  } else {
    falhar('status 200 com corpo {ok:false} deveria ter ficado pendente e não ficou — o código está confiando só em resposta.ok.');
  }

  if (!falhou) {
    console.log('\n=== TODOS OS PASSOS CONFIRMADOS (Response real, nunca mock de ok escolhido à mão) ===');
  } else {
    console.log('\n=== TESTE FALHOU ===');
    process.exitCode = 1;
  }
}

rodarCenario().catch((err) => {
  console.error('ERRO INESPERADO NO TESTE:', err);
  process.exitCode = 1;
});
