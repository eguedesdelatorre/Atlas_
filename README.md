# ATLAS AI — IQ Option

ATLAS AI usa o conector Nexus IQ para dados de mercado da IQ Option em modo somente leitura. A Safirion não é mais a fonte configurada.

## Estado
- Interface e API HTTP implantáveis no Railway.
- Conector IQ Option com login, sessão WebSocket, descoberta de ativos e recepção de candles M1/M5 (integração não oficial, ainda não validada em produção).
- Nenhuma ordem é enviada.
- A central de sinais continua vazia até o motor de estratégia ser integrado e testado; não são publicados sinais fictícios.
- Conector permanece desativado por padrão para evitar login sem autorização explícita e sem conta DEMO validada.

## Variáveis privadas Railway
`ATLAS_CONNECTOR_ENABLED=false` (altere para `true` somente após configurar e validar credenciais de conta DEMO)
`IQ_IDENTIFIER` e `IQ_PASSWORD` (credenciais da própria conta, somente no painel de segredos da Railway)

Nunca envie senha, SSID ou cookies ao GitHub ou à conversa. A autenticação 2FA pode exigir adaptação, e a corretora pode alterar endpoints não oficiais. Valide os termos aplicáveis.

## API
- `GET /api/health` — saúde e estado do feed.
- `GET /api/state` — fonte IQ Option, ativos, contagem de candles e sinais.

## Execução
`npm install && npm start` (Node.js 20+). Porta interna 3000.
