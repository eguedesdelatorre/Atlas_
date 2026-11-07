# ATLAS AI — contrato da nova API (rascunho de integração)

## Princípios
1. A API nova não envia ordens à corretora.
2. O feed deve ser identificado como real, indisponível ou desconectado; nunca inventar candles ou sinais.
3. O motor de estratégia continua independente do adaptador IQ Option.
4. A interface atual e o backend atual continuam operacionais durante a migração.

## Endpoints planejados
- GET /health — saúde do serviço.
- GET /api/v1/status — estado do feed, corretora e motor.
- GET /api/v1/signals — sinais validados; lista vazia quando não houver evidência suficiente.
- GET /api/v1/history — histórico persistido.

## Estado inicial
O serviço desta pasta ainda não está ligado ao feed IQ Option nem ao motor real. Não marcar broker.connected ou strategy.active como true até validação por testes e logs.
