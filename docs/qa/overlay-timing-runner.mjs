import { registerHooks } from 'node:module';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
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
 ['click','click',{x:95,y:69,intent:'fixture click'}],
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
phase('complete');writeFileSync(path('actions.json'),JSON.stringify(output,null,2));
if(!output[0]?.ok||!output[1]?.ok||output[2]?.ok||!/STOPPED/.test(output[2]?.text||''))process.exitCode=1;
