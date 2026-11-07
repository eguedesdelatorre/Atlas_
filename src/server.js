'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { NexusIqConnector } = require('./nexus-iq-connector');
const PORT = Number(process.env.PORT || 3000);
const state={source:'IQ Option',connected:false,enabled:process.env.ATLAS_CONNECTOR_ENABLED==='true',message:'Aguardando configuração',assets:[],candlesReceived:0,lastCandleAt:null,lastAssetUpdateAt:null,candleHistory:{},assetQuality:{}};
let connector=null;

function classifyMarket(asset) {
  const name=String(asset.asset||'');
  const otc=asset.isOtc===true || /(?:^|[\s._-])OTC(?:$|[\s._-])/i.test(name) || /-OTC$/i.test(name);
  return otc ? 'OTC' : 'OPEN';
}
function qualityFor(asset) {
  const candles = state.candleHistory[asset.activeId] || [];
  const valid = candles.filter(k => Number.isFinite(Number(k.open)) && Number.isFinite(Number(k.close)) && Number(k.open)>0 && Number(k.close)>0);
  if (valid.length < 70) return null;
  const ranges = valid.map(k => {
    const high = Number(k.max ?? k.high ?? Math.max(Number(k.open),Number(k.close)));
    const low = Number(k.min ?? k.low ?? Math.min(Number(k.open),Number(k.close)));
    return high >= low ? (high-low)/Number(k.open)*100 : null;
  }).filter(Number.isFinite);
  if (ranges.length < 70) return null;
  const avgRange = ranges.reduce((a,b)=>a+b,0)/ranges.length;
  const changes = valid.slice(1).map((k,i)=>Math.sign(Number(k.close)-Number(k.open)) * Math.sign(Number(valid[i].close)-Number(valid[i].open))).filter(x=>x!==0);
  const directionConsistency = changes.length ? changes.filter(x=>x===1).length/changes.length : 0;
  const rangeScore = avgRange >= 0.015 && avgRange <= 0.45 ? 35 : avgRange > 0.005 && avgRange <= 0.8 ? 22 : 5;
  const coverageScore = Math.min(35, valid.length/100*35);
  const activityScore = Math.min(20, ranges.filter(x=>x>0).length/valid.length*20);
  const stabilityScore = Math.max(0, 10-Math.abs(directionConsistency-0.5)*20);
  const score = Math.round(rangeScore+coverageScore+activityScore+stabilityScore);
  return { score, candles:valid.length, avgRangePct:Number(avgRange.toFixed(4)), directionBalance:Number(directionConsistency.toFixed(2)), quality:score>=70?'Apto para observação':'Abaixo do filtro' };
}
function marketSnapshot() {
  const openAssets=state.assets.filter(a=>classifyMarket(a)==='OPEN');
  const otcAssets=state.assets.filter(a=>classifyMarket(a)==='OTC');
  const otcBest = otcAssets.map(a=>({...a,quality:qualityFor(a)})).filter(a=>a.quality && a.quality.score>=70).sort((a,b)=>b.quality.score-a.quality.score).slice(0,8);\n  const modality = list => ({ binary:list.filter(a=>a.modalities?.includes('binary')), digital:list.filter(a=>a.modalities?.includes('digital')), unclassified:list.filter(a=>!a.modalities?.length) });
  const op=modality(openAssets), ot=modality(otcAssets);
  return {
    assets:state.assets,
    markets:{open:openAssets,otc:otcAssets,otcBest,openBinary:op.binary,openDigital:op.digital,otcBinary:ot.binary,otcDigital:ot.digital},
    signals:{open:[],otc:[],openBinary:[],openDigital:[],otcBinary:[],otcDigital:[]},
    marketCounts:{open:openAssets.length,otc:otcAssets.length,binary:state.assets.filter(a=>a.modalities?.includes('binary')).length,digital:state.assets.filter(a=>a.modalities?.includes('digital')).length,openBinary:op.binary.length,openDigital:op.digital.length,otcBinary:ot.binary.length,otcDigital:ot.digital.length,otcBest:otcBest.length,unclassified:state.assets.filter(a=>!a.modalities?.length).length}
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
 connector.on('assets',assets=>{state.assets=assets.filter(a=>a.enabled&&!a.suspended).map(a=>({asset:a.asset,activeId:a.activeId,isOtc:a.isOtc===true||/-OTC$/i.test(a.asset)||/\\bOTC\\b/i.test(a.asset),modalities:a.modalities||[],productStatus:a.productStatus||{}}));state.lastAssetUpdateAt=new Date().toISOString();state.message='Catálogo recebido; carregando dados de todos os ativos habilitados';});
 connector.on('candles',p=>{if(p.asset&&Array.isArray(p.candles)){state.candlesReceived+=p.candles.length;const id=String(p.activeId);state.candleHistory[id]=p.candles.slice(-150);}});
 connector.on('candle',p=>{if(p.asset&&p.candle){state.candlesReceived++;state.lastCandleAt=new Date().toISOString();const id=String(p.activeId);const list=state.candleHistory[id]||[];list.push(p.candle);state.candleHistory[id]=list.slice(-150);}});
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
    return res.end(JSON.stringify({status:'online',feedConnected:state.connected,feedMessage:state.message,source:'IQ Option',...marketSnapshot(),candlesReceived:state.candlesReceived,lastCandleAt:state.lastCandleAt,lastAssetUpdateAt:state.lastAssetUpdateAt,mode:'read_only'}));
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
