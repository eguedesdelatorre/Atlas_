# ATLAS AI

Painel web do ATLAS AI, servido por Node.js 20+ e pronto para deploy na Railway.

## Estado deste deploy
- Interface web e API de saúde.
- Modo somente leitura.
- Feed de mercado ainda não conectado.
- Sem geração de sinais operacionais e sem execução de ordens.

## Desenvolvimento
Execute `npm start` e abra `http://localhost:3000`. A rota `/api/health` verifica o servidor.

## Integração de mercado
Conectar somente uma API/feed autorizado da corretora escolhida. A integração Safirion não está implementada nem validada neste deploy. Não inserir credenciais no código ou no GitHub; usar variáveis secretas da Railway depois de validar a documentação e o acesso permitido.

## Railway
O arquivo `railway.json` configura `npm start` e o healthcheck em `/api/health`.
