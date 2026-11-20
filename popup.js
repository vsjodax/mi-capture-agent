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

const TEXTO_MOTIVO = {
  sem_sinal: 'o VERYS não recebe sinal de nenhum computador',
  agente_sem_sinal: 'um dos computadores com a extensão parou de mandar sinal',
  painel_fechado: 'há computador com a extensão sem o painel do MI aberto',
  sessao_mi_invalida: 'sessão do MI expirada ou na tela de login',
  painel_sem_resposta: 'o painel não recebe resposta do MI há mais de 10 min',
  fila_reenvio: 'há pedido esperando reenvio',
  pedidos_nao_registrados: 'há pedido visto no painel que não chegou ao VERYS',
  pedidos_atualizacao_pendente: 'há pedido com atualização ainda não sincronizada',
};
const SINAL_RECENTE_MS = 5 * 60 * 1000;

// Só diz "comprovada" quando o VERYS respondeu, a um sinal recente, que
// conferiu tudo (situacao.comprovada === true). Qualquer outra coisa —
// sinal não enviado, recusado, antigo, resposta sem situação, ou motivo em
// alguma loja — é "não comprovada", com o motivo.
function descreverSincronizacao(ultimoSinal, agoraMs) {
  const nao = (texto) => ({ comprovada: false, titulo: 'Sincronização NÃO comprovada', detalhes: [texto] });
  if (!ultimoSinal) return nao('o sinal ainda não foi enviado (confira endpoint e token em Configurar)');
  if (!ultimoSinal.ok) return nao(`o último sinal não chegou ao VERYS (${ultimoSinal.motivo ?? 'erro'}, ${formatarData(ultimoSinal.em)})`);
  if (agoraMs - Date.parse(ultimoSinal.em) > SINAL_RECENTE_MS) return nao(`nenhum sinal desde ${formatarData(ultimoSinal.em)}`);
  const s = ultimoSinal.situacao;
  if (!s || typeof s !== 'object' || !Array.isArray(s.lojas)) return nao('o VERYS não informou a situação da captura');
  if (s.comprovada === true) {
    return { comprovada: true, titulo: `Sincronização comprovada pelo VERYS às ${formatarData(ultimoSinal.em)}`, detalhes: [] };
  }
  const detalhes = s.lojas
    .filter((l) => l && l.motivo)
    .map((l) => `${l.loja ?? 'Loja'}: ${TEXTO_MOTIVO[l.motivo] ?? l.motivo}`);
  return { comprovada: false, titulo: 'Sincronização NÃO comprovada', detalhes: detalhes.length ? detalhes : ['o VERYS não confirmou a captura'] };
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
  chrome.runtime.sendMessage({ type: 'obter_stats' }, (stats) => {
    if (!stats) return;
    document.getElementById('pedidosHoje').textContent = String(stats.pedidosHoje ?? 0);
    document.getElementById('falhas').textContent = String(stats.falhas ?? 0);
    document.getElementById('pendentes').textContent = String(stats.pendentes ?? 0);
    document.getElementById('ultimoEnvio').textContent = formatarData(stats.ultimoEnvioEm);
    document.getElementById('painelMi').textContent = descreverPainel(stats.painel);

    const sinc = descreverSincronizacao(stats.ultimoSinal, Date.now());
    const caixa = document.getElementById('sincronizacao');
    caixa.className = sinc.comprovada ? 'sinc ok' : 'sinc nao';
    document.getElementById('sincTitulo').textContent = sinc.titulo;
    const lista = document.getElementById('sincDetalhes');
    lista.textContent = '';
    for (const d of sinc.detalhes) {
      const li = document.createElement('li');
      li.textContent = d;
      lista.appendChild(li);
    }
  });
}
