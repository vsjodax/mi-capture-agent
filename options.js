const STORAGE_KEY = 'verys_mi_config';

async function carregarConfigSalva() {
  const { [STORAGE_KEY]: config } = await chrome.storage.local.get(STORAGE_KEY);
  if (!config) return;
  document.getElementById('miUrl').value = config.miUrlPattern || '';
  document.getElementById('ingestUrl').value = config.ingestUrl || '';
  document.getElementById('token').value = config.token || '';
}

function mostrarStatus(mensagem, tipo) {
  const el = document.getElementById('status');
  el.textContent = mensagem;
  el.className = tipo;
}

document.getElementById('salvar').addEventListener('click', async () => {
  const miUrlPattern = document.getElementById('miUrl').value.trim();
  const ingestUrl = document.getElementById('ingestUrl').value.trim();
  const token = document.getElementById('token').value.trim();

  if (!miUrlPattern || !ingestUrl || !token) {
    mostrarStatus('Preencha os três campos.', 'erro');
    return;
  }

  try {
    // Permissão de host é pedida SÓ para o domínio informado — nunca
    // acesso amplo por padrão, o usuário decide explicitamente ao clicar
    // aqui (diálogo nativo do Chrome).
    const concedida = await chrome.permissions.request({ origins: [miUrlPattern] });
    if (!concedida) {
      mostrarStatus('Permissão negada — a extensão não vai funcionar sem acesso a essa URL.', 'erro');
      return;
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: { miUrlPattern, ingestUrl, token } });
    await chrome.runtime.sendMessage({ type: 'configurar_dominio', urlPattern: miUrlPattern });

    mostrarStatus('Salvo! Recarregue a aba do Menu Integrado para começar a captar.', 'ok');
  } catch (err) {
    mostrarStatus(`Falha ao salvar: ${err?.message ?? err}`, 'erro');
  }
});

carregarConfigSalva();
