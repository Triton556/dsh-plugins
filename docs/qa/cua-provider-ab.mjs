import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [driver, lab] = process.argv.slice(2);
const file = f => join(lab, f);
const count = id => readFileSync(file(id + '.count'), 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
const {pid,a,b} = JSON.parse(readFileSync(file('ready'), 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const child = spawn(driver, ['mcp'], { windowsHide:true });
const pending = new Map();
let id = 0;
let errors = '';
child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-1500); });
child.on('error', error => { errors = String(error); });
const lines = createInterface({ input:child.stdout });
lines.on('line', line => {
  try { const v=JSON.parse(line); pending.get(v.id)?.(v); } catch {}
});
function rpc(method, params) {
  const n=++id;
  return new Promise((resolve,reject) => {
    const timer=setTimeout(() => {
      pending.delete(n);
      reject(new Error(method+' timed out: '+errors));
    },8000);
    pending.set(n, r => {
      clearTimeout(timer); pending.delete(n);
      if (r.error) reject(new Error(JSON.stringify(r.error))); else resolve(r.result);
    });
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');
  });
}
const call = (name,args) => rpc('tools/call',{name, arguments:args});
const snapshots = () => readFileSync(file('focus.csv'),'utf8').trim().split(/\r?\n/).map(row=>row.split(',').map(Number)).filter(a=>a.length===4);
const summary = r => ({
  isError: Boolean(r.isError),
  value: r.structuredContent ?? r.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n').slice(0,1200)
});
const result={expectedWindowA:a, expectedUnchangedWindowB:b};
try {
  const init=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'dsh-provider-fixture',version:'1'}});
  result.version=init.serverInfo?.version;
  assert.equal(result.version,'0.28.0');
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const listed = await rpc('tools/list',{});
  assert.ok(listed.tools.some(t=>t.name==='click'));
  const observation=await call('get_window_state',{pid,window_id:a,include_screenshot:false});
  const state=observation.structuredContent;
  const button=state?.elements?.find(e=>[e.name,e.title,e.label,e.value].includes('Increment A'));
  assert.ok(button?.element_token || Number.isInteger(button?.index),
    'Expected exactly addressed fixture element; state excerpt: '+JSON.stringify(summary(observation)).slice(0,1800));
  const target=button.element_token ? {element_token:button.element_token} : {element_index:button.index,snapshot_id:state.snapshot_id};
  const pre=snapshots().at(-1);
  assert.equal(pre[1],b,'explicit fixture B must own focus before test');
  assert.deepEqual([count('A'),count('B')],[0,0]);
  const ts=Date.now();
  const click=await call('click',{pid,window_id:a,delivery_mode:'background',...target});
  result.action=summary(click);
  await sleep(250);
  const after=snapshots().filter(t=>t[0]>=ts);
  result.focusSamples=after.length;
  result.focusAndCursorUnchanged=after.length>0&&after.every(t=>t[1]===b&&t[2]===pre[2]&&t[3]===pre[3]);
  result.counts=[count('A'),count('B')];
  assert.equal(click.isError ?? false,false);
  assert.deepEqual(result.counts,[1,0],'only the intended WinForms button must be invoked, once');
  assert.equal(result.focusAndCursorUnchanged,true,'sampled foreground and cursor must not change');
  console.log('PASS: Cua Driver MCP background UIA click: A=1, B=0, no sampled focus/cursor change');
} catch (e) {
  result.failure=String(e.message);
  console.error(result.failure);
  process.exitCode=1;
} finally {
  writeFileSync(file('provider-result.json'),JSON.stringify(result,null,2));
  child.stdin.end(); lines.close(); child.kill();
}
