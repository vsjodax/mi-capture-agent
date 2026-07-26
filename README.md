# VERYS Connect — Capture Agent (Menu Integrado)

Extensão de navegador (Chrome/Edge, Manifest V3) que observa o tráfego
que a própria aba do Menu Integrado já faz (nunca simula clique, nunca
altera nada na tela) e envia os pedidos capturados para o VERYS Connect,
para alimentar CRM/RFM/relatórios de recuperação.

## Por que uma extensão, e não uma integração oficial

O Menu Integrado não oferece uma API pública — este é o caminho
combinado com o usuário: uma extensão instalada no computador de quem já
usa o Menu Integrado no dia a dia, rodando em paralelo, sem interferir em
nada da operação real.

## O que ela NÃO faz

- Nunca clica em nada nem simula ação de usuário.
- Nunca altera nenhuma resposta real do Menu Integrado — só observa uma
  cópia, a chamada original segue intacta.
- Nunca envia nada de volta para o Menu Integrado.
- Nunca grava em `public.pedidos` do VERYS (isso aciona KDS/produção) —
  só em `public.mi_pedidos_capturados`, exclusivamente para CRM/relatório.

## Instalação (modo desenvolvedor — ainda não publicada na Chrome Web Store)

Publicar na Chrome Web Store exige conta de desenvolvedor Google e um
processo de revisão de alguns dias — fora do escopo desta entrega.
Instalação hoje é via "modo desenvolvedor", igual a qualquer extensão
interna de empresa:

1. Baixe e extraia o pacote (`mi-capture-agent.zip`) em uma pasta fixa do
   computador (não delete depois — o Chrome carrega os arquivos direto
   dessa pasta).
2. No Chrome/Edge, acesse `chrome://extensions` (ou `edge://extensions`).
3. Ative "Modo do desenvolvedor" (canto superior direito).
4. Clique em "Carregar sem compactação" e selecione a pasta extraída.
5. Clique no ícone da extensão → "Configurar" (ou clique com o botão
   direito no ícone → Opções).
6. Preencha:
   - **URL do Menu Integrado**: o domínio do painel, com `/*` no final
     (ex.: `https://painel.exemplo.com.br/*`).
   - **Endpoint de ingestão**: `https://flpbrylskyqaduwodkpf.supabase.co/functions/v1/ingest-mi-order`
   - **Token da loja**: gerado em Configurações → Integrações do VERYS ERP.
7. Clique em "Autorizar e salvar" — o Chrome vai pedir para confirmar a
   permissão de acesso àquele domínio especificamente (nunca acesso
   amplo por padrão).
8. Recarregue a aba do Menu Integrado.

## Uma URL, várias marcas — mapeamento no VERYS, não na extensão

A URL do painel do Menu Integrado usada no dia a dia é **compartilhada
por várias marcas/lojas** (o "grupo/franquia" do Menu Integrado). A
extensão captura pedidos de TODAS elas sem filtrar nada — quem decide
quais marcas viram Cliente Mestre no CRM é o backend (VERYS Connect),
através da tabela `mi_marcas_lojas` (nome da marca → loja VERYS, ou
`NULL` para "capturar mas não vincular a cliente ainda"). Pedidos de uma
marca sem mapeamento continuam sendo armazenados (úteis para análise —
ex.: entender se o mesmo cliente pula entre marcas do grupo no iFood
atrás de cupom de primeira compra), só não geram Cliente Mestre.

**Calibração concluída (v1.0.1, 2026-07-25)**: o formato real do pedido
foi confirmado contra tráfego real (Response completa de pedidos do
iFood capturados pelo painel). O pedido é um objeto plano, sem wrapper
`{event, order}`:
```
{ id, displayId, createdAt, salesChannel, merchant: {id, name},
  customer: {id, name, phone: {number}}, items: [...], total: {...} }
```
`merchant.name` é a marca (ex.: "Hiperchef Burger Premium"). Pedidos do
iFood trazem em `customer.phone.number` um número mascarado/temporário do
próprio iFood (ex.: "0800 700 3021", expira em poucas horas) — nunca o
WhatsApp real do cliente. Isso já é tratado automaticamente:
`normalizarWhatsappBR` rejeita esse formato (DDD "08" não é válido), então
nenhum Cliente Mestre é criado a partir dele. Um Cliente Mestre só é
criado quando esse campo tiver um celular brasileiro válido de verdade —
o que acontece, por exemplo, quando o atendente edita o pedido no próprio
Menu Integrado com o telefone que o cliente mandou pelo chat.

Ainda não confirmado: o valor de `salesChannel` para pedidos do canal
direto (site/WhatsApp) — só foi visto `"IFOOD"` até agora. Não deveria
importar para a lógica (a validação do telefone já filtra o que interessa
independente do canal), mas fica registrado aqui caso surja algo
inesperado.

## Verificando que está funcionando

Clique no ícone da extensão a qualquer momento — mostra pedidos
capturados hoje, falhas de envio e o horário do último envio. Se
"Pedidos hoje" ficar sempre em zero com o Menu Integrado em uso normal,
o formato real das respostas da API interna deles pode ser diferente do
que foi mapeado (ver `page-hook.js` — heurística de reconhecimento) —
nesse caso, abra o Console do DevTools na aba do Menu Integrado, procure
por respostas de rede que contenham `uuid`/`customer_phone`, e ajuste a
função `pareceUmPedido` conforme o formato real observado.

## Estrutura

- `manifest.json` — permissões mínimas; nenhum domínio fixo (o domínio do
  Menu Integrado é configurado pelo usuário na tela de Opções, nunca
  hardcoded).
- `page-hook.js` — roda no MAIN world da página (só assim enxerga o mesmo
  `fetch`/`XMLHttpRequest` que o Menu Integrado usa); observa respostas,
  nunca modifica.
- `content-script.js` — ponte entre a página e a extensão (isolated
  world, o único que fala com `chrome.runtime`).
- `background.js` — service worker; envia o pedido capturado para o
  VERYS Connect e mantém as estatísticas do popup.
- `popup.html`/`popup.js` — status em tempo real.
- `options.html`/`options.js` — configuração (URL do Menu Integrado,
  endpoint, token).
