'use strict';
const EventEmitter = require('node:events');
const WebSocket = require('ws');
class NexusIqConnector extends EventEmitter {
 constructor({email,password}={}) {
  super(); if(!email||!password)throw Error('IQ credentials missing');
  this.email=email;this.password=password;this.ws=null;this.ssid=null;this.stopped=false;this.attempt=0;this.assets=new Map();this.subscriptions=new Set();
 }
 async login(){
  const body=new URLSearchParams({identifier:this.email,password:this.password});
  const response=await fetch('https://auth.iqoption.com/api/v2/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'},body});
  if(!response.ok)throw Error('IQ Option authentication failed (HTTP '+response.status+')');
  const data=await response.json();const ssid=data.ssid||data?.data?.ssid;
  if(!ssid)throw Error('IQ Option did not provide a session; 2FA or updated login flow may be required');
  return String(ssid);
 }
 async connect(){
  this.stopped=false;
  try {
   this.ssid=await this.login();
   const ws=new WebSocket('wss://iqoption.com/echo/websocket',{headers:{Origin:'https://iqoption.com'}});
   this.ws=ws;
   ws.on('open',()=>{ws.send(JSON.stringify({name:'ssid',msg:this.ssid}));});
   ws.on('message',raw=>{try{this.handle(JSON.parse(raw.toString()))}catch(e){this.emit('error',e)}});
   ws.on('error',e=>this.emit('error',e));
   ws.on('close',()=>{this.emit('disconnected');if(!this.stopped)this.reconnect()});
  }catch(e){this.emit('error',e);this.reconnect()}
 }
 send(name,msg,request_id=''){if(this.ws?.readyState===1)this.ws.send(JSON.stringify({name,msg,request_id}))}
 handle(packet){
  const name=packet.name,msg=packet.msg;
  if(name==='profile'||name==='ssid'){
   this.attempt=0;this.emit('connected');
   this.send('get-initialization-data',{});
  }
  if(name==='initialization-data'||name==='get-initialization-data'){
   const data=msg?.binary?.actives||msg?.turbo?.actives||msg?.digital?.actives||{};
   const assets=Object.entries(data).map(([id,a])=>({activeId:Number(id),asset:String(a.name||a.title||id),enabled:a.enabled!==false,suspended:!!a.is_suspended}));
   this.assets=new Map(assets.map(a=>[a.activeId,a]));
   this.emit('assets',assets);
   for(const a of assets.filter(x=>x.enabled&&!x.suspended).slice(0,100)){
    for(const size of [60,300]){
     this.send('subscribeMessage',{name:'candle-generated',params:{routingFilters:{active_id:a.activeId,size}}});
     this.send('get-candles',{active_id:a.activeId,size,to:Math.floor(Date.now()/1000),count:100},'history:'+a.activeId+':'+size);
    }
   }
  }
  if(name==='candles'){
   const m=String(packet.request_id||'').match(/^history:(\d+):(60|300)$/);
   if(m)this.emit('candles',{asset:this.assets.get(Number(m[1]))?.asset,timeframe:Number(m[2])===60?'M1':'M5',candles:msg?.candles||[]});
  }
  if(name==='candle-generated'){
   const id=Number(msg?.active_id||msg?.activeId);
   const size=Number(msg?.size);
   if(this.assets.has(id)&&(size===60||size===300))this.emit('candle',{asset:this.assets.get(id).asset,timeframe:size===60?'M1':'M5',candle:msg});
  }
 }
 reconnect(){if(this.stopped)return;const delay=Math.min(30000,2000*2**Math.min(this.attempt++,4));this.emit('reconnecting',{delay});setTimeout(()=>{if(!this.stopped)this.connect()},delay)}
 stop(){this.stopped=true;this.ws?.close()}
}
module.exports={NexusIqConnector};
