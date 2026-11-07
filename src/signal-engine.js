'use strict';

function num(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function normalize(rows){
  return (Array.isArray(rows)?rows:[]).map(c=>({
    open:num(c.open),close:num(c.close),
    high:num(c.max??c.high??Math.max(Number(c.open),Number(c.close))),
    low:num(c.min??c.low??Math.min(Number(c.open),Number(c.close))),
    time:num(c.from??c.at??c.time??c.to)
  })).filter(c=>c.open>0&&c.close>0&&c.high>=c.low&&c.low>0);
}
function ema(values,period){
  if(values.length<period)return null;
  const k=2/(period+1);let value=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++)value=values[i]*k+value*(1-k);
  return value;
}
function rsi(values,period=14){
  if(values.length<period+1)return null;
  let gains=0,losses=0;
  for(let i=values.length-period;i<values.length;i++){const d=values[i]-values[i-1];if(d>0)gains+=d;else losses-=d;}
  if(losses===0)return 100;
  const rs=(gains/period)/(losses/period);return 100-(100/(1+rs));
}
function evaluateSignal(asset,m1Input,m5Input,now=Date.now()){
  const m1=normalize(m1Input),m5=normalize(m5Input);
  if(m1.length<80||m5.length<30)return null;
  const closes=m1.map(c=>c.close),trendCloses=m5.map(c=>c.close);
  const fast=ema(closes.slice(-60),9),slow=ema(closes.slice(-80),21);
  const trendFast=ema(trendCloses.slice(-60),9),trendSlow=ema(trendCloses.slice(-80),21);
  const momentum=rsi(closes,14);
  if([fast,slow,trendFast,trendSlow,momentum].some(v=>v===null))return null;
  const last=m1.at(-1),prev=m1.at(-2),recent=m1.slice(-21,-1);
  const priorHigh=Math.max(...recent.map(c=>c.high)),priorLow=Math.min(...recent.map(c=>c.low));
  const body=Math.abs(last.close-last.open),range=Math.max(last.high-last.low,1e-12);
  const upperWick=last.high-Math.max(last.open,last.close),lowerWick=Math.min(last.open,last.close)-last.low;
  const bullTrend=trendFast>trendSlow&&m5.at(-1).close>trendFast;
  const bearTrend=trendFast<trendSlow&&m5.at(-1).close<trendFast;
  const bullFlow=fast>slow&&last.close>fast&&last.close>last.open;
  const bearFlow=fast<slow&&last.close<fast&&last.close<last.open;
  const bullSweep=last.low<priorLow&&last.close>priorLow&&lowerWick>body*0.7;
  const bearSweep=last.high>priorHigh&&last.close<priorHigh&&upperWick>body*0.7;
  const bullBos=last.close>priorHigh;
  const bearBos=last.close<priorLow;
  const bullRejection=lowerWick/range>=0.38&&last.close>last.open;
  const bearRejection=upperWick/range>=0.38&&last.close<last.open;
  const bullishOb=m1.slice(-8,-1).some((c,i,arr)=>c.close<c.open&&m1.at(-1).close>c.high&&m1.at(-1).close>m1.at(-2).close);
  const bearishOb=m1.slice(-8,-1).some(c=>c.close>c.open&&last.close<c.low&&last.close<prev.close);
  const bullishFvg=m1.length>=3&&m1.at(-1).low>m1.at(-3).high;
  const bearishFvg=m1.length>=3&&m1.at(-1).high<m1.at(-3).low;
  const scoreSide=(side)=>{
    let score=0;const reasons=[];
    const add=(ok,points,label)=>{if(ok){score+=points;reasons.push(label);}};
    if(side==='CALL'){
      add(bullTrend,20,'Tendência M5 alinhada');add(bullFlow,18,'Fluxo M1 comprador');
      add(bullSweep,18,'Varredura de liquidez com recuperação');add(bullBos,12,'Rompimento de estrutura');
      add(bullRejection,10,'Rejeição compradora');add(bullishOb,10,'Order Block comprador mitigado');
      add(bullishFvg,5,'Desequilíbrio/FVG comprador');add(momentum>=52&&momentum<=72,7,'RSI favorece continuação');
    }else{
      add(bearTrend,20,'Tendência M5 alinhada');add(bearFlow,18,'Fluxo M1 vendedor');
      add(bearSweep,18,'Varredura de liquidez com rejeição');add(bearBos,12,'Rompimento de estrutura');
      add(bearRejection,10,'Rejeição vendedora');add(bearishOb,10,'Order Block vendedor mitigado');
      add(bearishFvg,5,'Desequilíbrio/FVG vendedor');add(momentum>=28&&momentum<=48,7,'RSI favorece continuação');
    }
    return {score,reasons};
  };
  const call=scoreSide('CALL'),put=scoreSide('PUT');
  const chosen=call.score>=put.score?{...call,direction:'CALL'}:{...put,direction:'PUT'};
  if(chosen.score<78||chosen.score<Math.max(call.score,put.score)||call.score===put.score)return null;
  if(chosen.direction==='CALL'&&!bullTrend||chosen.direction==='PUT'&&!bearTrend)return null;
  const candleTime=last.time?new Date(last.time<1e12?last.time*1000:last.time).toISOString():new Date(now).toISOString();
  return {
    id:String(asset.activeId)+'-'+chosen.direction+'-'+String(last.time||now),
    asset:asset.asset,activeId:asset.activeId,market:asset.isOtc?'OTC':'OPEN',
    direction:chosen.direction,score:chosen.score,expirySeconds:60,timeframe:'M1',
    confirmationTimeframe:'M5',status:'CONFIRMED',time:candleTime,
    generatedAt:new Date(now).toISOString(),galeMax:1,galeLevel:0,
    reasons:chosen.reasons,indicators:{rsi:Number(momentum.toFixed(1)),ema9:Number(fast.toPrecision(8)),ema21:Number(slow.toPrecision(8))}
  };
}
module.exports={evaluateSignal};
