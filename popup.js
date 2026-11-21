function formatarData(iso) {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleTimeString('pt-BR');
}

// v1.8.0: o popup separa DUAS perguntas que antes se confundiam:
//   1. "Painel conectado"      — há aba do MI aberta, logada, recebendo
//                                resposta, e o sinal chega ao VERYS;
//   2. "Pedidos sincronizados" — o VERYS conferiu que os pedidos (novos e
//                                em andamento) estão atualizados lá.
// Achado de 20/11/2026: o painel ficou conectado por 30 min enquanto nenhum
// pedido era atualizado. Painel conectado NÃO prova pedido sincronizado.

const MOTIVOS_PAINEL = new Set(['sem_sinal', 'agente_sem_sinal', 'painel_fechado', 'sessao_mi_invalida', 'painel_sem_resposta']);

const TEXTO_MOTIVO = {
  sem_sinal: 'o VERYS não recebe sinal de nenhum computador',
  agente_sem_sinal: 'um dos computadores com a extensão parou de mandar sinal',
  painel_fechado: 'há computador com a extensão sem o painel do MI aberto',
  sessao_mi_invalida: 'sessão do MI expirada ou na tela de login',
  painel_sem_resposta: 'o painel não recebe resposta do MI há mais de 10 min',
  fila_reenvio: 'há pedido esperando reenvio',
  pedidos_nao_registrados: 'há pedido visto no painel que não chegou ao VERYS',
  pedidos_atualizacao_pendente: 'há pedido com atualização ainda não sincronizada',
  pedidos_sem_atualizacao: 'há pedido em andamento sem atualização há mais de 20 min',
};
const SINAL_RECENTE_MS = 5 * 60 * 1000;

function descreverPainel(painel) {
  if (!painel || painel.abasAbertas === 0) return 'nenhuma aba aberta';
  if (painel.paginaLogin) return 'na tela de login (entre de novo)';
  if (painel.ultimaFalhaSessaoEm && (!painel.ultimaRespostaOkEm || painel.ultimaFalhaSessaoEm > painel.ultimaRespostaOkEm)) {
    return 'sessão expirada (entre de novo)';
  }
  return `sessão válida, última resposta ${formatarData(painel.ultimaRespostaOkEm)}`;
}

function sinalRecente(ultimoSinal, agoraMs) {
  return !!ultimoSinal && ultimoSinal.ok && agoraMs - Date.parse(ultimoSinal.em) <= SINAL_RECENTE_MS;
}

function motivosDasLojas(situacao, filtro) {
  if (!situacao || !Array.isArray(situacao.lojas)) return [];
  return situacao.lojas
    .filter((l) => l && l.motivo && filtro(l.motivo))
    .map((l) => `${l.loja ?? 'Loja'}: ${TEXTO_MOTIVO[l.motivo] ?? l.motivo}`);
}

// 1. Painel conectado: estado local da aba E o VERYS sem motivo de painel.
function descreverConexaoPainel(painel, ultimoSinal, agoraMs) {
  const nao = (detalhes) => ({ conectado: false, titulo: 'Painel NÃO conectado', detalhes });
  const local = descreverPainel(painel);
  if (!painel || painel.abasAbertas === 0 || painel.paginaLogin || local.startsWith('sessão expirada')) return nao([local]);
  if (!ultimoSinal) return nao([local, 'o sinal ainda não foi enviado (confira endpoint e token em Configurar)']);
  if (!ultimoSinal.ok) return nao([local, `o último sinal não chegou ao VERYS (${ultimoSinal.motivo ?? 'erro'}, ${formatarData(ultimoSinal.em)})`]);
  if (!sinalRecente(ultimoSinal, agoraMs)) return nao([local, `nenhum sinal desde ${formatarData(ultimoSinal.em)}`]);
  const problemas = motivosDasLojas(ultimoSinal.situacao, (m) => MOTIVOS_PAINEL.has(m));
  if (problemas.length) return nao([local, ...problemas]);
  return { conectado: true, titulo: 'Painel conectado', detalhes: [local, `sinal recebido pelo VERYS às ${formatarData(ultimoSinal.em)}`] };
}

function descreverConsulta(consulta) {
  if (!consulta) return null;
  if (consulta.outroComputadorConsulta) return 'consulta automática feita por outro computador da loja (este só captura o que o painel mostra)';
  if (consulta.pausadaAte) {
    const motivo = consulta.pausaMotivo === 'sessao_mi' ? 'a sessão do MI recusou a consulta'
      : consulta.pausaMotivo === 'sem_conexao' ? 'sem conexão com o MI'
        : `o MI respondeu ${String(consulta.pausaMotivo ?? '').replace('mi_http_', 'HTTP ')}`;
    return `consulta automática pausada até ${formatarData(consulta.pausadaAte)} (${motivo})`;
  }
  if (!consulta.modeloAprendido) return 'consulta automática aguardando o painel carregar um detalhe de pedido uma vez';
  const partes = [`consulta automática: ${consulta.consultasOk30min} ok em 30 min`];
  if (consulta.consultasFalha30min) partes.push(`${consulta.consultasFalha30min} sem sucesso`);
  if (consulta.ultimaConsultaOkEm) partes.push(`última às ${formatarData(consulta.ultimaConsultaOkEm)}`);
  if (consulta.pedidosAguardandoDetalhe) partes.push(`${consulta.pedidosAguardandoDetalhe} pedido(s) na fila`);
  return partes.join(', ');
}

// 2. Pedidos sincronizados: só o VERYS comprova (situacao.comprovada num sinal
// recente). Com o painel desconectado não há como comprovar.
function descreverSincronizacao(ultimoSinal, agoraMs, consulta) {
  const extra = descreverConsulta(consulta);
  const nao = (detalhes) => ({ comprovada: false, titulo: 'Pedidos sincronizados: NÃO comprovado', detalhes: extra ? [...detalhes, extra] : detalhes });
  if (!ultimoSinal) return nao(['o sinal ainda não foi enviado (confira endpoint e token em Configurar)']);
  if (!ultimoSinal.ok) return nao([`o último sinal não chegou ao VERYS (${ultimoSinal.motivo ?? 'erro'}, ${formatarData(ultimoSinal.em)})`]);
  if (!sinalRecente(ultimoSinal, agoraMs)) return nao([`nenhum sinal desde ${formatarData(ultimoSinal.em)}`]);
  const s = ultimoSinal.situacao;
  if (!s || typeof s !== 'object' || !Array.isArray(s.lojas)) return nao(['o VERYS não informou a situação da captura']);
  if (s.comprovada === true) {
    return { comprovada: true, titulo: `Pedidos sincronizados: comprovado pelo VERYS às ${formatarData(ultimoSinal.em)}`, detalhes: extra ? [extra] : [] };
  }
  if (motivosDasLojas(s, (m) => MOTIVOS_PAINEL.has(m)).length) {
    return nao(['não dá para comprovar enquanto o painel não estiver conectado', ...motivosDasLojas(s, (m) => !MOTIVOS_PAINEL.has(m))]);
  }
  const detalhes = motivosDasLojas(s, () => true);
  return nao(detalhes.length ? detalhes : ['o VERYS não confirmou a captura']);
}

function preencher(idCaixa, idTitulo, idLista, ok, titulo, detalhes) {
  document.getElementById(idCaixa).className = ok ? 'sinc ok' : 'sinc nao';
  document.getElementById(idTitulo).textContent = titulo;
  const lista = document.getElementById(idLista);
  lista.textContent = '';
  for (const d of detalhes) {
    const li = document.createElement('li');
    li.textContent = d;
    lista.appendChild(li);
  }
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
  chrome.runtime.sendMessage({ type: 'obter_stats' }, (stats) => {
    if (!stats) return;
    document.getElementById('pedidosHoje').textContent = String(stats.pedidosHoje ?? 0);
    document.getElementById('falhas').textContent = String(stats.falhas ?? 0);
    document.getElementById('pendentes').textContent = String(stats.pendentes ?? 0);
    document.getElementById('ultimoEnvio').textContent = formatarData(stats.ultimoEnvioEm);

    const agora = Date.now();
    const painel = descreverConexaoPainel(stats.painel, stats.ultimoSinal, agora);
    preencher('painelBloco', 'painelTitulo', 'painelDetalhes', painel.conectado, painel.titulo, painel.detalhes);
    const sinc = descreverSincronizacao(stats.ultimoSinal, agora, stats.consulta);
    preencher('sincronizacao', 'sincTitulo', 'sincDetalhes', sinc.comprovada, sinc.titulo, sinc.detalhes);
  });
}
