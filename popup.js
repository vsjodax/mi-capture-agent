function formatarData(iso) {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleTimeString('pt-BR');
}

chrome.runtime.sendMessage({ type: 'obter_stats' }, (stats) => {
  if (!stats) return;
  document.getElementById('pedidosHoje').textContent = String(stats.pedidosHoje ?? 0);
  document.getElementById('falhas').textContent = String(stats.falhas ?? 0);
  document.getElementById('ultimoEnvio').textContent = formatarData(stats.ultimoEnvioEm);
});
