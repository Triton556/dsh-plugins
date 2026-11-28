import { registerHooks } from 'node:module';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const root=process.env.GITHUB_WORKSPACE, lab=process.env.WFR_LAB;
const path=(name)=>join(lab,name);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const phase=name=>{writeFileSync(path('phase.txt'),name);console.log(name,Date.now());};
const stub=new URL('file:///'+join(root,'dsh-computer-use/tools/dsh-tools-stub.mjs').replaceAll('\\','/')).href;
registerHooks({resolve(spec,context,next){return spec==='@deepseek-ai/dsh-tools'?{url:stub,shortCircuit:true}:next(spec,context);}});
const {pathToFileURL}=await import('node:url');
const {apply}=await import(pathToFileURL(join(root,'dsh-computer-use/index.js')).href);
const reg=[];const effects=[];const ctx={get:n=>n==='tools'?{register: t=>{reg.push(t);return ()=>{};}}:undefined,effect:f=>{effects.push(f);return ()=>{};},inject:(n,f)=>{if(n.includes('tools'))f(ctx);return ()=>{};}};
apply(ctx,{});for(const f of effects)await f();
const fixture=JSON.parse(readFileSync(path('ready'),'utf8'));
const window=fixture.title;
const call=(name,args)=>{
 const result={window,...args};
 for(const [key,off] of [['x',fixture.offsetX],['y',fixture.offsetY],['x2',fixture.offsetX],['y2',fixture.offsetY]])if(result[key]!==undefined)result[key]+=off;
 return reg.find(t=>t.name==='computer_'+name).execute(result);
};
const output=[];
const steps=[
 ['click','click',{x:95,y:69,intent:'cold fixture click'}],
 ['warm-click','click',{x:95,y:69,intent:'warm fixture click'}],
 ['drag','drag',{x:120,y:138,x2:250,y2:185,steps:180,intent:'normal drag'}],
 ['escape','drag',{x:120,y:138,x2:250,y2:185,steps:200,intent:'cancel drag'}]
];
phase('baseline');await sleep(1100);
for(const [label,name,args] of steps){
 phase(label);const start=Date.now();const result=await call(name,args);
 output.push({label,start,end:Date.now(),...result});
 if(label!=='escape'&&!result.ok)break;
 phase(label+'-done');
 await sleep(1600);
}
const good=output.length===4 && output.slice(0,3).every(r=>r.ok) && !output[3].ok && /STOPPED/.test(output[3].text);
if(good){
 const {engine}=await import(pathToFileURL(join(root,'dsh-computer-use/tools/engine.mjs')).href);
 phase('missing-paint');
 // Invoke the exact native engine as usual, but intentionally supply no
 // state publisher/renderer receipt for this fresh token.
 const before=readFileSync(path('input.csv'),'utf8');
 const start=Date.now();
 const result=await engine({Action:'click',Window:window,Client:true,Overlay:true,StopToken:randomUUID(),X:80,Y:80});
 const elapsedMs=Date.now()-start;
 await sleep(180);
 const after=readFileSync(path('input.csv'),'utf8');
 output.push({label:'missing-paint',start,end:Date.now(),elapsedMs,unchangedInputLog:before===after,...result});
}
// Exercise movement outside the plugin so geometry, not its in-memory
// invalidation, is what refuses the original frame.
async function proveFrameReceipt() {
 // The previous scenario intentionally pressed Escape. Acknowledge the one
 // stop notice as a new test phase before any fresh observation or input.
 const stopped=await reg.find(t=>t.name==='computer_windows').execute({});
 assert.equal(stopped.ok,false,stopped.text);
 assert.match(stopped.text,/^STOPPED:/);
 const {engine}=await import(pathToFileURL(join(root,'dsh-computer-use/tools/engine.mjs')).href);
 const screenshot=async label=>{
  const r=await call('shot',{x:80,y:55,width:110,height:55,path:path(label+'.png')});
  assert.equal(r.ok,true,r.text);
  assert.match(r.text,/Source crop.*110, 55/);
  return r.text.match(/Frame ID: (\S+)/)?.[1];
 };
 phase('stale-after-move');
 const old=await screenshot('before-move');
 assert.ok(old,'Windows PrintWindow must return a frame ID');
 const move=await engine({Action:'window',Window:window,Op:'move',X:96,Y:100});
 assert.equal(move.ok,true,move.text);
 const before=readFileSync(path('input.csv'),'utf8');
 const rejected=await call('click',{x:95,y:69,frame_id:old});
 assert.equal(rejected.ok,false,rejected.text);
 assert.match(rejected.text,/STALE_FRAME: window identity/);
 assert.match(rejected.text,/No pointer input sent/);
 await sleep(180);
 assert.equal(readFileSync(path('input.csv'),'utf8'),before,'stale frame must produce zero native input');
 output.push({label:'stale-after-move',...rejected});
 phase('fresh-after-move');
 const fresh=await screenshot('after-move');
 assert.ok(fresh && fresh!==old);
 const one=await call('click',{x:95,y:69,frame_id:fresh});
 assert.equal(one.ok,true,one.text);
 assert.match(one.text,/Input sent. App response not verified/);
 await sleep(180);
 const events=readFileSync(path('input.csv'),'utf8').slice(before.length);
 assert.deepEqual(events.trim().split(/\r?\n/).map(line=>line.split(',')[1]),['click-down','click-up']);
 const reuse=await call('click',{x:95,y:69,frame_id:fresh});
 assert.equal(reuse.ok,false);
 assert.match(reuse.text,/STALE_FRAME: unknown, consumed or expired/);
 assert.equal(readFileSync(path('input.csv'),'utf8'),before+events);
 output.push({label:'fresh-after-move',...one},{label:'reuse',...reuse});
 console.log('PASS: moved-window frame staled natively; fresh window crop clicked once; reusing ID produced no input');
}
if(good && output[4]?.unchangedInputLog && process.env.WFR_TEST_RECEIPTS==='1'){
 try { await proveFrameReceipt(); } catch(e) { output.push({label:'frame receipt assertions',error:String(e.stack||e)}); console.error(e); process.exitCode=1; }
}
phase('complete');writeFileSync(path('actions.json'),JSON.stringify(output,null,2));
if(!good||output[4]?.ok||!/OVERLAY_NOT_READY/.test(output[4]?.text||'')||!output[4]?.unchangedInputLog)process.exitCode=1;
