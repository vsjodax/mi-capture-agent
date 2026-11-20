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

    repassar({ type: 'pedido_observado', payload: event.data.payload });
  });

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
