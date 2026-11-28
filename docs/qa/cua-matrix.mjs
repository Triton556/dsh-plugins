import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const lab=process.env.WFR_LAB;
const filename=(s)=>join(lab,s);
const stub=new URL('../../dsh-computer-use/tools/dsh-tools-stub.mjs',import.meta.url).href;
registerHooks({resolve(s,c,n){return s==='@deepseek-ai/dsh-tools'?{url:stub,shortCircuit:true}:n(s,c);}});
const {apply}=await import('../../dsh-computer-use/index.js');
const {engine}=await import('../../dsh-computer-use/tools/engine.mjs');
const reg=new Map(), starts=[];
const ctx={get:n=>n==='tools'?{register:t=>{reg.set(t.name,t);return ()=>{};}}:undefined,
 effect:f=>starts.push(f()),inject:(ns,f)=>{if(ns.includes('tools'))f(ctx);return ()=>{};}};
apply(ctx); await Promise.all(starts);
const f=JSON.parse(readFileSync(filename('ready'),'utf8'));
const call=(name,args={})=>reg.get('computer_'+name).execute({window:f.title,...args});
const events=()=>readFileSync(filename('input.csv'),'utf8').trim().split(/\r?\n/).slice(1)
  .map(line=>{const [at,kind,x,y]=line.split(',');return {at:+at,kind,x:+x,y:+y};});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stage=s=>writeFileSync(filename('phase.txt'),s);
const xy=(x,y)=>({x:x+f.offsetX,y:y+f.offsetY});
const [cx,dx]=[f.buttonX,f.dragX];
const shot=async (name,opts={})=>{
 const r=await call('shot',{path:filename(name+'.png'),...opts});
 assert.equal(r.ok,true,r.text);
 const id=r.text.match(/Frame ID: (\S+)/)?.[1];
 assert.ok(id,r.text);
 assert.ok(existsSync(filename(name+'.png')));
 return {r,id};
};
const ok=r=>assert.equal(r.ok,true,r.text);
const count=(es,name)=>es.filter(e=>e.kind===name).length;
function mouse(es,down,up,n) {assert.equal(count(es,down),n,JSON.stringify(es)); assert.equal(count(es,up),n,JSON.stringify(es));}
const out=[];
async function test(name,body,obs){
 stage(name); const start=Date.now(), before=events().length;
 const row={name,start,window:f.title};
 try{
  row.result=await body();
  await sleep(180);
  row.end=Date.now();
  row.events=events().slice(before);
  await obs(row.result,row.events);
  row.pass=true;
 }catch(e){row.pass=false;row.error=String(e.message);row.events=events().slice(before);row.end=Date.now();}
 out.push(row); console.log(JSON.stringify({case:name,pass:row.pass,error:row.error}));
 writeFileSync(filename('matrix.json'),JSON.stringify({window:f,out},null,2));
 stage(name+'-clear');await sleep(1100);
}
await test('list',()=>call('windows'),r=>{ok(r);assert.ok(r.text.includes(f.title));});
await test('wait',()=>call('wait',{timeout:2500}),r=>{ok(r);assert.notEqual(r.text,'timeout');});
await test('focus',()=>call('focus'),r=>{ok(r);assert.match(r.text,/focused: True/i);});
await test('shot-full',()=>shot('full'),r=>assert.ok(r.id));
await test('shot-crop',()=>shot('crop',{...xy(50,46),width:125,height:55}),r=>assert.match(r.r.text,/125, 55/));
await test('click',async()=>{const {id}=await shot('used-for-click');return call('click',{...xy(cx,69),frame_id:id,intent:'fixture click'});},(r,e)=>{ok(r);mouse(e,'click-down-Left','click-up-Left',1);});
await test('double-click',()=>call('click',{...xy(cx,69),double:true,intent:'fixture double click'}),(r,e)=>{ok(r);mouse(e,'click-down-Left','click-up-Left',2);});
await test('right-click',()=>call('click',{...xy(cx,69),right:true,intent:'fixture right click'}),(r,e)=>{ok(r);mouse(e,'click-down-Right','click-up-Right',1);});
await test('drag',()=>call('drag',{...xy(dx,138),x2:f.offsetX+210,y2:f.offsetY+180,steps:32,intent:'fixture drag'}),(r,e)=>{ok(r);mouse(e,'drag-down','drag-up',1);assert.ok(e.find(x=>x.kind==='drag-up').x-e.find(x=>x.kind==='drag-down').x>=90);});
await test('cancel-drag',()=>call('drag',{...xy(dx,138),x2:f.offsetX+210,y2:f.offsetY+180,steps:190,intent:'cancel this drag'}),(r,e)=>{assert.equal(r.ok,false);assert.match(r.text,/STOPPED/);mouse(e,'drag-down','drag-up',1);assert.equal(count(e,'esc-injected'),1);assert.ok(e.find(x=>x.kind==='drag-up').x<130);});
await test('stop-notice',()=>call('windows'),r=>{assert.equal(r.ok,false);assert.match(r.text,/^STOPPED:/);});
await test('type',async()=>{ok(await call('click',{...xy(228,68),intent:'focus text field'}));return call('type',{unicode:true,text:'DSH Тест '+f.hWnd,intent:'type test text'});},(r,e)=>{ok(r);assert.ok(count(e,'text-changed')>0);assert.equal(readFileSync(filename('typed.txt'),'utf8'),'DSH Тест '+f.hWnd);});
await test('key',()=>call('key',{text:'{HOME}',intent:'move to start'}),(r,e)=>{ok(r);assert.equal(count(e,'key-home'),1);});
await test('scroll',()=>call('scroll',{...xy(dx,145),delta:-120,intent:'scroll fixture'}),(r,e)=>{ok(r);assert.equal(count(e,'wheel'),1);assert.equal(e.find(v=>v.kind==='wheel').x,-120);});
await test('ui-tree',()=>call('uitree',{depth:6}),r=>{ok(r);assert.match(r.text,/Click complete|Click test/);});
await test('ui-invoke',()=>call('ui_action',{name:'QA Invoke',kind:'invoke'}),(r,e)=>{ok(r);assert.equal(count(e,'wpf-invoke'),1);});
await test('clipboard',async()=>{ok(await call('clipboard',{text:'QA clipboard '+f.hWnd}));return call('clipboard');},r=>{ok(r);assert.equal(r.text,'QA clipboard '+f.hWnd);});
await test('record',()=>call('record',{dir:filename('plugin-frames'),frames:3,interval:80}),r=>{ok(r);assert.equal(readdirSync(filename('plugin-frames')).filter(s=>s.endsWith('.png')).length,3);});
await test('video',()=>call('video',{path:filename('plugin-video.mp4'),frames:3,interval:100}),r=>{ok(r);assert.ok(readFileSync(filename('plugin-video.mp4')).subarray(4,8).equals(Buffer.from('ftyp')));});
await test('ocr',()=>call('ocr',{path:filename('full.png')}),r=>{ok(r);assert.match(r.text,/Real fixture/i);});
await test('stale-after-move',async()=>{const {id}=await shot('pre-move');ok(await engine({Action:'window',Window:f.title,Op:'move',X:f.left+85,Y:f.top+30}));return call('click',{...xy(cx,69),frame_id:id});},(r,e)=>{assert.equal(r.ok,false);assert.match(r.text,/STALE_FRAME: window identity/);assert.equal(e.length,0);});
let lastId;
await test('fresh-after-move',async()=>{const {id}=await shot('post-move',{...xy(50,46),width:125,height:55});lastId=id;return call('click',{...xy(cx,69),frame_id:id});},(r,e)=>{ok(r);mouse(e,'click-down-Left','click-up-Left',1);});
await test('reuse',()=>call('click',{...xy(cx,69),frame_id:lastId}),(r,e)=>{assert.equal(r.ok,false);assert.match(r.text,/STALE_FRAME: unknown/);assert.equal(e.length,0);});
await test('no-consent',()=>reg.get('computer_click').execute(xy(cx,69)),(r,e)=>{assert.equal(r.ok,false);assert.match(r.text,/REFUSED/);assert.equal(e.length,0);});
await test('window-move',()=>call('window',{op:'move',x:f.left+30,y:f.top+15}),async r=>{
 ok(r);const state=await engine({Action:'info',Window:f.title});ok(state);
 assert.match(state.text,new RegExp('window\\s*:\\s*'+(f.left+30)+','+(f.top+15)));
});
const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
const labelA='DSH Matrix Alpha '+f.hWnd, labelB='DSH Matrix Beta '+f.hWnd;
const tabA=filename('alpha.html'),tabB=filename('beta.html');
for (const [p,title] of [[tabA,labelA],[tabB,labelB]]) writeFileSync(p,'<!doctype html><meta charset="utf-8"><title>'+title+'</title><h1>'+title+'</h1>');
let browserTarget, testBrowserPid;
const browserCall=(n,args)=>call(n,{...args,window:browserTarget});
await test('launch',async()=>{
 assert.ok(chrome,'Chrome executable not installed on this test VM');
 const args=['--user-data-dir="'+filename('test-browser')+'"','--no-first-run','--no-default-browser-check','--disable-background-networking','--new-window',pathToFileURL(tabA).href,pathToFileURL(tabB).href].join(' ');
 const r=await call('launch',{path:chrome,args,timeout:15000});
 ok(r);
 testBrowserPid=+(r.text.match(/launched pid=(\d+)/)?.[1]||0);
 assert.ok(testBrowserPid);
 // A new browser may report a bootstrap window, or still be loading its
 // local pages. Poll observations only; never launch again on timeout.
 const limit=Date.now()+15000, states=[];
 do {
  const matcher=await call('windows');ok(matcher);
  browserTarget=matcher.text.includes(labelB)?labelB:matcher.text.includes(labelA)?labelA:undefined;
  states.push({at:Date.now(),ready:!!browserTarget,chromeLines:matcher.text.split(/\r?\n/).filter(t=>t.includes('chrome'))});
  if(!browserTarget) await sleep(400);
 } while(!browserTarget && Date.now()<limit);
 writeFileSync(filename('browser-readiness.json'),JSON.stringify({launch:r,states},null,2));
 assert.ok(browserTarget,'Chrome fixture did not expose a named window: '+r.text);
 return r;
},r=>assert.match(r.text,/launched pid=\d+/));
await test('browser-tabs',async()=>{assert.ok(browserTarget);return browserCall('tabs',{});},r=>{ok(r);assert.ok(r.text.includes(labelA)&&r.text.includes(labelB),r.text);});
await test('browser-tab-switch',async()=>{
 assert.ok(browserTarget);
 const listed=await browserCall('tabs',{});
 ok(listed);
 const next=listed.text.split(/\r?\n/).some(l=>l.includes('[x]')&&l.includes(labelA))?labelB:labelA;
 const r=await browserCall('tab',{title:next});ok(r);
 assert.match(r.text,/selected tab:/);
 browserTarget=next;
 const after=await browserCall('tabs',{});ok(after);
 assert.ok(after.text.split(/\r?\n/).some(l=>l.includes('[x]')&&l.includes(next)),after.text);
 const snap=await browserCall('shot',{path:filename('browser-after.png'),method:'print'});ok(snap);
 return after;
},ok);
stage('done');
if(out.some(r=>!r.pass))process.exitCode=1;
