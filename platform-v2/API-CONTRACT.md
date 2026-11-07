# ATLAS AI — API v2

A API v2 roda no servidor principal (src/server.js) e compartilha o estado real da aplicação.

Todos os endpoints exigem sessão autenticada, como as rotas atuais.

- GET /api/v1/status: estado do conector IQ Option, disponibilidade do motor ATLAS e modo de dados.
- GET /api/v1/signals: sinais emitidos pelo motor src/signal-engine.js, separados internamente por mercado e entregues em uma lista ordenada.
- GET /api/v1/history?limit=200: registros recentes de sinais e resultados do armazenamento persistente.

## Limites
- Modo somente leitura: nenhuma ordem é enviada.
- dataMode=live exige conexão ativa e recebimento de candles.
- Sem dados reais, a API informa no_live_data.
- A autenticação é herdada da aplicação; chamadas sem sessão recebem HTTP 401.
- Credenciais nunca são retornadas pela API.
