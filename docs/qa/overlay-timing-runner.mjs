import {writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=process.env.GITHUB_WORKSPACE,lab=process.env.WFR_LAB;
const {engine}=await import(pathToFileURL(join(root,'dsh-computer-use/tools/engine.mjs')).href);
const path=(name)=>join(lab,name);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const phase=name=>{writeFileSync(path('phase.txt'),name);console.log(name,Date.now());};
const fixture=JSON.parse(readFileSync(path('ready'),'utf8'));
const window=fixture.title;
const stateFile=join(tmpdir(),'dsh-cua-overlay-state.json');
const pattern=/^\[overlay\] hwnd=(\d+) rect=(-?\d+,-?\d+,-?\d+,-?\d+)(?: click=(-?\d+,-?\d+))?\s*$/m;
function show(match,stopToken,ttlMs,label){
 const state={updated:Date.now(),ttlMs,mode:'window',screen:false,stopToken,target:{hwnd:Number(match?.[1]||0),rect:(match?.[2]||'0,0,0,0').split(',').map(Number)}};
 if(match?.[3]){const [x,y]=match[3].split(',').map(Number);state.cursor={x,y};state.label=label};
 writeFileSync(stateFile,JSON.stringify(state));
}
const output=[];
const steps=[
 ['click','click',{X:95,Y:69},'fixture click'],
 ['drag','drag',{X:120,Y:138,X2:250,Y2:185,Steps:80,Delay:25},'normal drag'],
 ['escape','drag',{X:120,Y:138,X2:250,Y2:185,Steps:100,Delay:25},'cancel drag']
];
phase('baseline');await sleep(1100);
for(const [label,Action,args,caption] of steps){
 phase(label);const start=Date.now();const stopToken=randomUUID();
 show(null,stopToken,90000,caption);
 let geometryTime;
 const result=await engine({Action,Window:window,Client:true,Overlay:true,StopToken:stopToken,...args},{onLine(line){
   const match=pattern.exec(line);
   if(match){geometryTime=Date.now();show(match,stopToken,90000,caption);}
 }});
 if(result.ok && pattern.test(result.text)){show(pattern.exec(result.text),undefined,700,caption);}
 else show(null,undefined,0,caption);
 output.push({label,start,end:Date.now(),geometryTime,...result});
 if(label!=='escape'&&!result.ok)break;
 phase(label+'-done');await sleep(1600);
}
phase('complete');writeFileSync(path('actions.json'),JSON.stringify(output,null,2));
if(!output[0]?.ok||!output[1]?.ok||output[2]?.ok||!/STOPPED/.test(output[2]?.text||''))process.exitCode=1;
