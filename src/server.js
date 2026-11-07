'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { NexusIqConnector } = require('./nexus-iq-connector');
const { evaluateSignal } = require('./signal-engine');
const crypto = require('node:crypto');
const readline = require('node:readline');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'atlas_session';
const sessions = new Map();
const SESSION_FILE = path.join(process.env.ATLAS_DATA_DIR || '/data', 'atlas-sessions.json');
function sessionKey(token){return crypto.createHash('sha256').update(token).digest('hex');}
function saveSessions(){
  try{
    const rows=[...sessions.entries()].filter(([,v])=>v.expires>Date.now());
    const tmp=SESSION_FILE+'.tmp';
    fs.mkdirSync(path.dirname(SESSION_FILE),{recursive:true});
    fs.writeFileSync(tmp,JSON.stringify(rows),'utf8');
    fs.renameSync(tmp,SESSION_FILE);
    return true;
  }catch(e){console.error('[AUTH] session persistence error:',e.message);return false;}
}
try{
  const rows=JSON.parse(fs.readFileSync(SESSION_FILE,'utf8'));
  if(Array.isArray(rows))for(const [key,value] of rows)if(value?.expires>Date.now())sessions.set(key,value);
}catch(e){if(e.code!=='ENOENT')console.error('[AUTH] session restore error:',e.message);}

const loginAttempts = new Map();
function cookies(header='') {
  return Object.fromEntries(header.split(';').map(x=>x.trim()).filter(Boolean).map(x=>{
    const i=x.indexOf('='); return i<0?[x,'']:[x.slice(0,i),decodeURIComponent(x.slice(i+1))];
  }));
}
function equal(a,b) {
  const aa=Buffer.from(String(a)), bb=Buffer.from(String(b));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}
function currentSession(req) {
  const token=cookies(req.headers.cookie||'')[COOKIE_NAME];
  if(!token)return null;
  const key=sessionKey(token),session=sessions.get(key);
  if(!session||session.expires<Date.now()){sessions.delete(key);saveSessions();return null;}
  session.expires=Date.now()+(session.remember?REMEMBER_TTL_MS:SESSION_TTL_MS);
  saveSessions();
  return session;
}
function setCookie(res,token,maxAge) {
  res.setHeader('Set-Cookie',COOKIE_NAME+'='+encodeURIComponent(token)+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age='+maxAge);
}
function sendJson(res,status,data) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(data));
}

const PORT = Number(process.env.PORT || 3000);
const HISTORY_DIR=process.env.ATLAS_DATA_DIR||'/data';
const HISTORY_FILE=path.join(HISTORY_DIR,'atlas-history.jsonl');
let historyReady=false,historyWrites=0,historyWriteError=null;
try{fs.mkdirSync(HISTORY_DIR,{recursive:true});fs.accessSync(HISTORY_DIR,fs.constants.W_OK);historyReady=true;}catch(e){historyWriteError=e.message;}
function persistRecord(record){if(!historyReady)return false;try{fs.appendFileSync(HISTORY_FILE,JSON.stringify(record)+'\n');historyWrites++;return true;}catch(e){historyWriteError=e.message;return false;}}
function localDate(iso){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));}
const state={source:'IQ Option',connected:false,enabled:process.env.ATLAS_CONNECTOR_ENABLED==='true',message:'Aguardando configuração',assets:[],candlesReceived:0,lastCandleAt:null,lastAssetUpdateAt:null,lastPacketAt:null,lastConnectorError:null,protocolErrors:0,history:{ready:historyReady,writes:historyWrites,error:historyWriteError},candleHistory:{},assetQuality:{},signals:{open:[],otc:[]}};
const signalCooldowns=new Map();
const pendingSignalResults=new Map();
let liveCandlePackets=0;
function candleStamp(c){const n=Number(c?.from??c?.at??c?.time??c?.to??0);return n<1e12?n*1000:n;}
function recordSignalResult(signal,outcome,galeLevel,detail){const timestamp=new Date().toISOString();signal.resultStatus=outcome;signal.resultAt=timestamp;signal.galeLevel=galeLevel;signal.resultDetail=detail;persistRecord({type:'signal_result',signalId:signal.id,timestamp,date:localDate(timestamp),asset:signal.asset,activeId:signal.activeId,direction:signal.direction,outcome,galeLevel,detail});pendingSignalResults.delete(signal.id);console.log('[SIGNAL] result',signal.asset,signal.direction,outcome,'gale',galeLevel);}
function settleSignalOnClosedCandle(asset,candle,timeframe){const id=String(asset.activeId),stamp=candleStamp(candle);if(!stamp)return;for(const signal of [...pendingSignalResults.values()]){if(String(signal.activeId)!==id||signal.timeframe!==(timeframe||'M1'))continue;if(stamp<Number(signal.nextAttemptAt||0))continue;const open=Number(candle.open),close=Number(candle.close);if(!(open>0&&close>0))continue;const win=signal.direction==='CALL'?close>open:close<open;const tie=close===open;if(win){recordSignalResult(signal,signal.galeLevel===1?'GALE1_WIN':'WIN',signal.galeLevel,'Resultado favorável');continue;}if(tie){recordSignalResult(signal,'DRAW',signal.galeLevel,'Empate no fechamento');continue;}if(signal.galeLevel===0){signal.galeLevel=1;signal.nextAttemptAt=stamp+(signal.timeframe==='M5'?300000:60000);const ts=new Date().toISOString();persistRecord({type:'signal_result',signalId:signal.id,timestamp:ts,date:localDate(ts),asset:signal.asset,activeId:signal.activeId,direction:signal.direction,outcome:'LOSS_GALE1_PENDING',galeLevel:1,detail:'Primeira entrada negativa; gale 1 aguardando fechamento'});console.log('[SIGNAL] first attempt loss; gale 1 pending:',signal.asset);}else recordSignalResult(signal,'LOSS',1,'Duas entradas encerradas sem acerto');}}
function restoreSignalHistory(){try{if(!fs.existsSync(HISTORY_FILE))return;const rows=fs.readFileSync(HISTORY_FILE,'utf8').split(/\r?\n/).filter(Boolean);const signals=new Map(),results=new Map();for(const line of rows){let r;try{r=JSON.parse(line)}catch{continue;}if(r.type==='signal'&&r.id)signals.set(r.id,{...r});if(r.type==='signal_result'&&r.signalId)results.set(r.signalId,r);}for(const [id,signal] of signals){const result=results.get(id);if(result){Object.assign(signal,{resultStatus:result.outcome,resultAt:result.timestamp,galeLevel:result.galeLevel??signal.galeLevel,resultDetail:result.detail});if(result.outcome==='LOSS_GALE1_PENDING'){signal.galeLevel=1;signal.nextAttemptAt=Date.parse(signal.time)+(signal.timeframe==='M5'?600000:120000);pendingSignalResults.set(id,signal);}}else if(signal.resultStatus==='PENDING')pendingSignalResults.set(id,signal);const bucket=signal.market==='OTC'?'otc':'open';state.signals[bucket].push(signal);}for(const bucket of ['open','otc'])state.signals[bucket].sort((a,b)=>Date.parse(b.generatedAt)-Date.parse(a.generatedAt));console.log('[SIGNAL] restored from persistent history:',signals.size);}catch(e){console.error('[SIGNAL] restore error:',e.message);}}
restoreSignalHistory();
const SIGNAL_MIN_SCORE=Number(process.env.ATLAS_MIN_SCORE||78);
function evaluateAssetSignal(asset){
 const id=String(asset.activeId),now=Date.now();
 const timeframe=arguments[1]||'M1',cooldownKey=id+':'+timeframe;
 if((signalCooldowns.get(cooldownKey)||0)>now)return;
 const base=state.candleHistory[id+':'+timeframe]||[];
 const confirmTf=timeframe==='M5'?'M1':'M5';
 const confirm=state.candleHistory[id+':'+confirmTf]||[];
 const signal=evaluateSignal(asset,base.slice(0,-1),confirm,now,timeframe);
 if(!signal||signal.score<SIGNAL_MIN_SCORE)return;
 const market=signal.market==='OTC'?'otc':'open';
 if(state.signals[market].some(x=>x.id===signal.id))return;
 signalCooldowns.set(cooldownKey,now+(timeframe==='M5'?20:4)*60*1000);
 signal.resultStatus='PENDING';signal.nextAttemptAt=Date.parse(signal.time)+(timeframe==='M5'?300000:60000);
 state.signals[market].unshift(signal);state.signals[market]=state.signals[market].slice(0,1000);pendingSignalResults.set(signal.id,signal);
 persistRecord({type:'signal',...signal,timestamp:signal.generatedAt,date:localDate(signal.generatedAt)});
 console.log('[SIGNAL] confirmed',signal.market,signal.asset,signal.direction,signal.score);
}
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
  const otcBest = otcAssets.map(a=>({...a,quality:qualityFor(a)})).filter(a=>a.quality && a.quality.score>=70).sort((a,b)=>b.quality.score-a.quality.score).slice(0,8);
  const modality = list => ({ binary:list.filter(a=>a.modalities?.includes('binary')), digital:list.filter(a=>a.modalities?.includes('digital')), unclassified:list.filter(a=>!a.modalities?.length) });
  const op=modality(openAssets), ot=modality(otcAssets);
  return {
    assets:state.assets,
    markets:{open:openAssets,otc:otcAssets,otcBest,openBinary:op.binary,openDigital:op.digital,otcBinary:ot.binary,otcDigital:ot.digital},
    signals:{open:state.signals.open,otc:state.signals.otc,openBinary:state.signals.open,openDigital:[],otcBinary:state.signals.otc,otcDigital:[]},
    marketCounts:{open:openAssets.length,otc:otcAssets.length,binary:state.assets.filter(a=>a.modalities?.includes('binary')).length,digital:state.assets.filter(a=>a.modalities?.includes('digital')).length,openBinary:op.binary.length,openDigital:op.digital.length,otcBinary:ot.binary.length,otcDigital:ot.digital.length,otcBest:otcBest.length,unclassified:state.assets.filter(a=>!a.modalities?.length).length}
  };
}
function startFeed(){
 if(!state.enabled){state.message='IQ Option configurada como fonte; conexão desativada até validação em DEMO';return;}
 if(!process.env.IQ_IDENTIFIER||!process.env.IQ_PASSWORD){state.message='Credenciais IQ Option ausentes nas variáveis privadas Railway';return;}
 connector=new NexusIqConnector({email:process.env.IQ_IDENTIFIER,password:process.env.IQ_PASSWORD});
 connector.on('connected',()=>{state.connected=true;state.lastConnectorError=null;state.message='Autenticado na IQ Option; aguardando candles válidos';console.log('[IQ] authenticated/profile received');});
 connector.on('disconnected',()=>{state.connected=false;state.message='Conexão encerrada';console.log('[IQ] websocket disconnected');});
 connector.on('reconnecting',x=>{state.connected=false;state.message='Reconectando em '+x.delay+'ms';});
 connector.on('error',e=>{state.connected=false;state.lastConnectorError=String(e?.message||e).slice(0,240);state.message='Falha no conector; verifique autenticação, 2FA e protocolo';console.error('[IQ] connector error:',state.lastConnectorError);});
 connector.on('protocolError',e=>{state.protocolErrors++;state.lastConnectorError=String(e?.message||e).slice(0,240);console.error('[IQ] protocol error:',state.lastConnectorError);});
 connector.on('packet',p=>{state.lastPacketAt=new Date().toISOString();});
 connector.on('assets',assets=>{state.assets=assets.filter(a=>a.enabled&&!a.suspended).map(a=>({asset:a.asset,activeId:a.activeId,isOtc:a.isOtc===true||/-OTC$/i.test(a.asset)||/\\bOTC\\b/i.test(a.asset),modalities:a.modalities||[],productStatus:a.productStatus||{}}));state.lastAssetUpdateAt=new Date().toISOString();state.message='Catálogo recebido; carregando dados de todos os ativos habilitados';console.log('[IQ] assets received:',state.assets.length);});
 connector.on('candles',p=>{if(p.asset&&Array.isArray(p.candles)){state.candlesReceived+=p.candles.length;const id=String(p.activeId),key=id+':'+p.timeframe;state.candleHistory[key]=p.candles.slice(-150).sort((a,b)=>Number(a.from??a.at??a.time??a.to??0)-Number(b.from??b.at??b.time??b.to??0));for(const candle of p.candles){const ts=Number(candle.from??candle.at??candle.time??candle.to??Date.now()/1000);const timestamp=new Date(ts<1e12?ts*1000:ts).toISOString();persistRecord({type:'candle',timestamp,date:localDate(timestamp),asset:p.asset,activeId:p.activeId,timeframe:p.timeframe,candle});}const asset=state.assets.find(a=>String(a.activeId)===id);if(asset)evaluateAssetSignal(asset);console.log('[IQ] historical candles:',p.asset,p.timeframe,p.candles.length);state.history={ready:historyReady,writes:historyWrites,error:historyWriteError};}});
 connector.on('candle',p=>{if(p.asset&&p.candle){state.candlesReceived++;state.lastCandleAt=new Date().toISOString();const id=String(p.activeId),key=id+':'+p.timeframe;const list=state.candleHistory[key]||[];const stamp=candleStamp(p.candle);const isNew=!list.some(c=>candleStamp(c)===stamp);if(isNew){if(p.timeframe==='M1'&&list.length){const prior=[...list].sort((a,b)=>candleStamp(a)-candleStamp(b)).at(-1);const previousAsset=state.assets.find(a=>String(a.activeId)===id);if(previousAsset)settleSignalOnClosedCandle(previousAsset,prior,p.timeframe);}list.push(p.candle);}else{const ix=list.findIndex(c=>candleStamp(c)===stamp);if(ix>=0)list[ix]=p.candle;}list.sort((a,b)=>candleStamp(a)-candleStamp(b));state.candleHistory[key]=list.slice(-150);const rawTs=Number(p.candle.from??p.candle.at??p.candle.time??p.candle.to??Date.now()/1000);const timestamp=new Date(rawTs<1e12?rawTs*1000:rawTs).toISOString();persistRecord({type:'candle',timestamp,date:localDate(timestamp),asset:p.asset,activeId:p.activeId,timeframe:p.timeframe,candle:p.candle});const asset=state.assets.find(a=>String(a.activeId)===id);if(asset&&isNew&&(p.timeframe==='M1'||p.timeframe==='M5'))evaluateAssetSignal(asset,p.timeframe);if(++liveCandlePackets%100===0)console.log('[IQ] live candle packets:',liveCandlePackets,'last:',p.asset,p.timeframe);state.history={ready:historyReady,writes:historyWrites,error:historyWriteError};}});
 connector.connect().catch(()=>{});
}

const root=path.resolve(__dirname,'..','public');
function serveFile(res,name){const file=path.resolve(root,name);if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end('Forbidden');}fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found');}const ext=path.extname(file);res.writeHead(200,{'content-type':ext==='.html'?'text/html; charset=utf-8':ext==='.css'?'text/css; charset=utf-8':'application/octet-stream','cache-control':'no-cache'});res.end(data);});}
const server=http.createServer(async(req,res)=>{
 res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','strict-origin-when-cross-origin');
 const url=new URL(req.url,'http://'+(req.headers.host||'localhost')),session=currentSession(req);
 if(req.method==='GET'&&url.pathname==='/api/health')return sendJson(res,200,{ok:true,app:'ATLAS AI',mode:'read_only'});
 if(req.method==='GET'&&url.pathname==='/api/auth/me')return sendJson(res,200,{authenticated:!!session,user:session?.email||null});
 if(req.method==='POST'&&url.pathname==='/api/auth/login'){
  const ip=req.headers['x-forwarded-for']?.split(',')[0]?.trim()||req.socket.remoteAddress||'unknown',attempt=loginAttempts.get(ip)||{count:0,until:0};
  if(attempt.until>Date.now())return sendJson(res,429,{error:'Muitas tentativas. Aguarde 10 minutos.'});
  let body='';req.on('data',c=>{body+=c;if(body.length>4096)req.destroy();});req.on('end',()=>{
   let d;try{d=JSON.parse(body||'{}')}catch{return sendJson(res,400,{error:'Requisição inválida.'})}
   const configured=!!(process.env.ATLAS_ADMIN_EMAIL&&process.env.ATLAS_ADMIN_PASSWORD);
   const valid=configured&&typeof d.email==='string'&&typeof d.password==='string'&&equal(d.email.trim().toLowerCase(),process.env.ATLAS_ADMIN_EMAIL.trim().toLowerCase())&&equal(d.password,process.env.ATLAS_ADMIN_PASSWORD);
   if(!valid){attempt.count++;if(attempt.count>=5){attempt.count=0;attempt.until=Date.now()+600000;}loginAttempts.set(ip,attempt);return sendJson(res,401,{error:configured?'E-mail ou senha incorretos.':'Login não configurado no servidor.'});}
   loginAttempts.delete(ip);const token=crypto.randomBytes(32).toString('base64url');const remember=d.remember===true,ttl=remember?REMEMBER_TTL_MS:SESSION_TTL_MS;
   sessions.set(sessionKey(token),{email:process.env.ATLAS_ADMIN_EMAIL,expires:Date.now()+ttl,remember});
   saveSessions();setCookie(res,token,ttl/1000);return sendJson(res,200,{ok:true,remember,expiresIn:ttl/1000});
  });return;
 }
 if(req.method==='POST'&&url.pathname==='/api/auth/logout'){const t=cookies(req.headers.cookie||'')[COOKIE_NAME];if(t)sessions.delete(sessionKey(t));saveSessions();setCookie(res,'',0);return sendJson(res,200,{ok:true});}
 if(!session){if(url.pathname==='/login.html'||url.pathname==='/login')return serveFile(res,'login.html');if(url.pathname.startsWith('/api/'))return sendJson(res,401,{error:'Não autenticado.'});res.writeHead(302,{location:'/login.html','cache-control':'no-store'});return res.end();}
 if(req.method==='GET'&&url.pathname==='/api/state')return sendJson(res,200,{status:'online',feedConnected:state.connected,feedMessage:state.message,source:'IQ Option',...marketSnapshot(),candlesReceived:state.candlesReceived,lastCandleAt:state.lastCandleAt,lastAssetUpdateAt:state.lastAssetUpdateAt,lastPacketAt:state.lastPacketAt,lastConnectorError:state.lastConnectorError,protocolErrors:state.protocolErrors,history:{ready:historyReady,writes:historyWrites,error:historyWriteError},mode:'read_only'});
 if(req.method==='GET'&&url.pathname==='/api/history'){
  const date=url.searchParams.get('date')||localDate(new Date().toISOString());
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return sendJson(res,400,{error:'Data inválida. Use AAAA-MM-DD.'});
  const type=url.searchParams.get('type')||'all',asset=url.searchParams.get('asset')||'',limit=Math.min(1000,Math.max(1,Number(url.searchParams.get('limit')||500)));
  if(!historyReady)return sendJson(res,503,{error:'Armazenamento persistente indisponível.',detail:historyWriteError});
  const results=[];
  try{if(fs.existsSync(HISTORY_FILE)){const rl=readline.createInterface({input:fs.createReadStream(HISTORY_FILE),crlfDelay:Infinity});for await(const line of rl){if(!line)continue;let item;try{item=JSON.parse(line);}catch{continue;}if(item.date!==date||(type!=='all'&&!(type==='signal'?(item.type==='signal'||item.type==='signal_result'):item.type===type))||(asset&&String(item.asset||'').toLowerCase()!==asset.toLowerCase()))continue;results.push(item);if(results.length>limit)results.shift();}}}
  catch(e){return sendJson(res,500,{error:'Falha ao consultar histórico.'});}
  return sendJson(res,200,{date,timeZone:'America/Sao_Paulo',type,asset,limit,count:results.length,records:results,historyReady,historyWrites});
 }
 if(url.pathname==='/login.html'){res.writeHead(302,{location:'/'});return res.end();}
 const requested=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));return serveFile(res,requested);
});
server.listen(PORT, '0.0.0.0', () => (console.log('ATLAS AI online on port ' + PORT),startFeed()));
process.on('SIGTERM', () => {connector?.stop();server.close(() => process.exit(0))});
process.on('SIGINT', () => server.close(() => process.exit(0)));
