function formatarData(iso) {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleTimeString('pt-BR');
}

function descreverPainel(painel) {
  if (!painel || painel.abasAbertas === 0) return 'nenhuma aba aberta';
  if (painel.paginaLogin) return 'na tela de login (entre de novo)';
  if (painel.ultimaFalhaSessaoEm && (!painel.ultimaRespostaOkEm || painel.ultimaFalhaSessaoEm > painel.ultimaRespostaOkEm)) {
    return 'sessão expirada (entre de novo)';
  }
  return `sessão válida, última resposta ${formatarData(painel.ultimaRespostaOkEm)}`;
}

chrome.runtime.sendMessage({ type: 'obter_stats' }, (stats) => {
  if (!stats) return;
  document.getElementById('pedidosHoje').textContent = String(stats.pedidosHoje ?? 0);
  document.getElementById('falhas').textContent = String(stats.falhas ?? 0);
  document.getElementById('pendentes').textContent = String(stats.pendentes ?? 0);
  document.getElementById('ultimoEnvio').textContent = formatarData(stats.ultimoEnvioEm);
  document.getElementById('painelMi').textContent = descreverPainel(stats.painel);
  const s = stats.ultimoSinal;
  document.getElementById('ultimoSinal').textContent = s
    ? `${formatarData(s.em)} ${s.ok ? '(recebido)' : `(falhou: ${s.motivo ?? 'erro'})`}`
    : 'ainda não enviado';
});
