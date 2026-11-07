'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { NexusIqConnector } = require('./nexus-iq-connector');
const PORT = 3000;
const state={source:'IQ Option',connected:false,enabled:process.env.ATLAS_CONNECTOR_ENABLED==='true',message:'Aguardando configuração',assets:[],candlesReceived:0,lastCandleAt:null};
let connector=null;

function classifyMarket(asset) {
  const name=String(asset.asset||'');
  const otc=asset.isOtc===true || /(?:^|[\s._-])OTC(?:$|[\s._-])/i.test(name) || /-OTC$/i.test(name);
  return otc ? 'OTC' : 'OPEN';
}
function marketSnapshot() {
  const openAssets=state.assets.filter(a=>classifyMarket(a)==='OPEN');
  const otcAssets=state.assets.filter(a=>classifyMarket(a)==='OTC');
  return {
    assets:state.assets,
    markets:{open:openAssets,otc:otcAssets},
    signals:{open:[],otc:[]},
    marketCounts:{open:openAssets.length,otc:otcAssets.length}
  };
}
function startFeed(){
 if(!state.enabled){state.message='IQ Option configurada como fonte; conexão desativada até validação em DEMO';return;}
 if(!process.env.IQ_IDENTIFIER||!process.env.IQ_PASSWORD){state.message='Credenciais IQ Option ausentes nas variáveis privadas Railway';return;}
 connector=new NexusIqConnector({email:process.env.IQ_IDENTIFIER,password:process.env.IQ_PASSWORD});
 connector.on('connected',()=>{state.connected=true;state.message='Sessão conectada; aguardando candles válidos';});
 connector.on('disconnected',()=>{state.connected=false;state.message='Conexão encerrada';});
 connector.on('reconnecting',x=>{state.connected=false;state.message='Reconectando em '+x.delay+'ms';});
 connector.on('error',()=>{state.connected=false;state.message='Falha no conector; verifique autenticação, 2FA e protocolo';});
 connector.on('assets',assets=>{state.assets=assets.filter(a=>a.enabled&&!a.suspended).map(a=>({asset:a.asset,activeId:a.activeId,isOtc:/-OTC$/i.test(a.asset)||/\bOTC\b/i.test(a.asset)}));});
 connector.on('candles',p=>{if(p.asset&&Array.isArray(p.candles))state.candlesReceived+=p.candles.length;});
 connector.on('candle',p=>{if(p.asset&&p.candle){state.candlesReceived++;state.lastCandleAt=new Date().toISOString();}});
 connector.connect().catch(()=>{});
}

const root = path.resolve(__dirname, '..', 'public');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (req.method === 'GET' && url.pathname === '/api/health') {
    res.writeHead(200, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    return res.end(JSON.stringify({ok:true,app:'ATLAS AI',status:'online',feed:state,mode:'read_only'}));
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    res.writeHead(200, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    return res.end(JSON.stringify({status:'online',feedConnected:state.connected,feedMessage:state.message,source:'IQ Option',...marketSnapshot(),candlesReceived:state.candlesReceived,lastCandleAt:state.lastCandleAt,mode:'read_only'}));
  }
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(root, requested);
  if (file !== path.join(root,'index.html') && !file.startsWith(root + path.sep)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, {'content-type':type,'cache-control':'no-cache'});
    res.end(data);
  });
});
server.listen(PORT, '0.0.0.0', () => (console.log('ATLAS AI online on port ' + PORT),startFeed()));
process.on('SIGTERM', () => {connector?.stop();server.close(() => process.exit(0))});
process.on('SIGINT', () => server.close(() => process.exit(0)));
