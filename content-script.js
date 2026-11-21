// Roda no isolated world (padrão de extensão) — única ponte entre o
// page-hook.js (MAIN world, sem acesso a chrome.runtime) e o service
// worker da extensão. Só repassa mensagens, nunca decide nada sozinho.
(() => {
  const CHANNEL = 'verys-mi-capture';
  const INTERVALO_PRESENCA_MS = 60000;

  function repassar(mensagem) {
    try {
      chrome.runtime.sendMessage(mensagem).catch(() => {
        // Service worker pode estar reiniciando (normal em MV3) — o próximo
        // evento observado tenta de novo; nunca acumula fila aqui.
      });
    } catch {
      // Extensão recarregada com a aba aberta: o contexto antigo fica
      // inválido até a aba ser recarregada. Nada a fazer aqui.
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.channel !== CHANNEL) return;

    // v1.7.0: sinal do painel (horários de respostas, nunca conteúdo).
    if (event.data.tipo === 'sinal_painel') {
      repassar({ type: 'sinal_painel', estado: event.data.estado });
      return;
    }

    // v1.8.0: lista (só id/código/marca/assinatura), modelo do endereço de
    // detalhe (sem token) e resultado de cada consulta automática.
    if (event.data.tipo === 'lista_pedidos') {
      repassar({ type: 'lista_pedidos', itens: event.data.itens });
      return;
    }
    if (event.data.tipo === 'modelo_detalhe') {
      repassar({ type: 'modelo_detalhe', modelo: event.data.modelo });
      return;
    }
    if (event.data.tipo === 'detalhe_resultado') {
      const { id, status, reconhecido, motivo } = event.data;
      repassar({ type: 'detalhe_resultado', id, status, reconhecido, motivo });
      return;
    }
    // Mensagem que este próprio script manda ao page-hook — não é pedido.
    if (event.data.tipo === 'buscar_detalhes') return;

    if (!event.data.payload) return;
    repassar({ type: 'pedido_observado', payload: event.data.payload });
  });

  // v1.8.0: o service worker escolhe quais detalhes consultar (e quando);
  // aqui só repassa ao page-hook, que faz a consulta de leitura no painel.
  try {
    chrome.runtime.onMessage.addListener((mensagem, _remetente, responder) => {
      if (mensagem?.type !== 'buscar_detalhes' || !Array.isArray(mensagem.pedidos)) return false;
      window.postMessage({ channel: CHANNEL, tipo: 'buscar_detalhes', pedidos: mensagem.pedidos, modelo: mensagem.modelo ?? null }, '*');
      responder({ aceito: true });
      return false;
    });
  } catch {
    // Contexto da extensão invalidado (extensão recarregada): nada a fazer.
  }

  // v1.7.0: presença da aba do painel (a cada minuto). Diz só se a aba está
  // aberta e se está na tela de login do MI (sessão caída), lendo a própria
  // página — nunca faz requisição nem toca em nada da tela.
  function estaNaTelaDeLogin() {
    if (/\/(login|signin|sign-in|entrar)(\/|$)/i.test(location.pathname)) return true;
    const senha = document.querySelector('input[type="password"]');
    return !!(senha && senha.offsetParent !== null);
  }

  function informarPresenca() {
    repassar({ type: 'painel_presente', paginaLogin: estaNaTelaDeLogin() });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', informarPresenca, { once: true });
  } else {
    informarPresenca();
  }
  setInterval(informarPresenca, INTERVALO_PRESENCA_MS);
})();
