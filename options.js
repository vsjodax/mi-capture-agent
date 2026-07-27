const STORAGE_KEY = 'verys_mi_config';

async function carregarConfigSalva() {
  const { [STORAGE_KEY]: config } = await chrome.storage.local.get(STORAGE_KEY);
  if (!config) return;
  document.getElementById('ingestUrl').value = config.ingestUrl || '';
  document.getElementById('token').value = config.token || '';
}

function mostrarStatus(mensagem, tipo) {
  const el = document.getElementById('status');
  el.textContent = mensagem;
  el.className = tipo;
}

document.getElementById('salvar').addEventListener('click', async () => {
  const ingestUrl = document.getElementById('ingestUrl').value.trim();
  const token = document.getElementById('token').value.trim();

  if (!ingestUrl || !token) {
    mostrarStatus('Preencha os dois campos.', 'erro');
    return;
  }

  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: { ingestUrl, token } });
    mostrarStatus('Salvo! Recarregue a aba do Menu Integrado para começar a captar.', 'ok');
  } catch (err) {
    mostrarStatus(`Falha ao salvar: ${err?.message ?? err}`, 'erro');
  }
});

carregarConfigSalva();
