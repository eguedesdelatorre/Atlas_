# ATLAS AI — integração da API v2

A API versionada foi integrada ao servidor principal existente. Ela reutiliza o mesmo estado do conector IQ Option, o mesmo histórico persistente e o motor de estratégia ATLAS AI.

## Endpoints (protegidos por sessão)
- GET /api/v1/status — estado da conexão, feed e motor.
- GET /api/v1/signals — sinais gerados pelo motor existente.
- GET /api/v1/history — registros recentes de sinais e resultados.

## Segurança e operação
- API em modo somente leitura; não envia ordens.
- Endpoints v2 herdam a autenticação da aplicação.
- dataMode só é live quando a sessão do feed está conectada e candles foram recebidos.
- Sem feed real, os sinais existentes não são apresentados como live.
- Credenciais ficam somente nas variáveis privadas Railway.

## Deploy
A aplicação raiz continua sendo o único serviço de produção. A pasta platform-v2/cloud é apenas um scaffold inicial e não deve ser implantada como segundo serviço, pois isso duplicaria a conexão da corretora.
