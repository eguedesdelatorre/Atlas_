# ATLAS AI — nova estrutura integrada

Esta pasta recebe a nova estrutura web/cloud adaptada para ATLAS AI, sem substituir a aplicação principal existente em `public/` e `src/`.

## Estratégia de integração
- A aplicação atual permanece como produção e fonte do motor de sinais e do conector IQ Option.
- A nova estrutura fica isolada em `platform-v2/` durante a migração.
- Não publicar sinais simulados: sem feed real e estratégia validada, a API deve informar ausência de dados.
- Não duplicar nem expor credenciais. Segredos permanecem exclusivamente nas variáveis privadas do Railway.
- A integração final deve reutilizar o motor real de `src/signal-engine.js` e o conector `src/nexus-iq-connector.js` por meio de uma camada de adaptação testada.

## Estado desta etapa
Esta é uma área de integração isolada. Ela ainda não substitui a interface atual, não muda o comando de inicialização da raiz e não altera o serviço Railway existente.
