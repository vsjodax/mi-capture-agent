// Roda no isolated world (padrão de extensão) — única ponte entre o
// page-hook.js (MAIN world, sem acesso a chrome.runtime) e o service
// worker da extensão. Só repassa mensagens, nunca decide nada sozinho.
(() => {
  const CHANNEL = 'verys-mi-capture';

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.channel !== CHANNEL) return;

    chrome.runtime.sendMessage({ type: 'pedido_observado', payload: event.data.payload }).catch(() => {
      // Service worker pode estar reiniciando (normal em MV3) — o próximo
      // evento observado tenta de novo; nunca acumula fila aqui.
    });
  });
})();
