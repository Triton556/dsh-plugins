import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const listeners = new Map();
const on = name => ({ addListener: listener => listeners.set(name, listener) });
const native = { onMessage: on('message'), onDisconnect: on('disconnect'), postMessage() {} };
const chrome = {
  debugger: { onDetach: on('detach'), attach: async () => {} },
  tabs: { onRemoved: on('removed'), onUpdated: on('updated') },
  runtime: { onStartup: on('startup'), onInstalled: on('installed'), connectNative: () => native },
  alarms: { create() {}, onAlarm: on('alarm') },
};
const context = vm.createContext({ chrome, setTimeout: () => 1, clearTimeout() {}, console });
vm.runInContext(source, context);

test('a lost reply after input was performed never replays the action', async () => {
  let sent = 0;
  context.sendFixtureInput = async () => { sent++; throw new Error('detached while handling command'); };
  await assert.rejects(vm.runInContext('withMutation(12, sendFixtureInput)', context), /may already have run/);
  assert.equal(sent, 1);
  assert.equal(vm.runInContext('attached.has(12)', context), false);
});

test('loading a new page discards only that tab’s previous AX snapshot', () => {
  vm.runInContext('snapshots.set(12, {at: Date.now(), nodes: []}); snapshots.set(13, {at: Date.now(), nodes: []});', context);
  listeners.get('updated')(12, { status: 'loading' });
  assert.throws(() => vm.runInContext('snapshotNode(12, 0)', context), /no fresh ax snapshot/);
  assert.equal(vm.runInContext('snapshots.has(13)', context), true);
});

test('a snapshot interrupted by navigation cannot repopulate the cache', async () => {
  let url = 'https://fixture.invalid/a';
  chrome.tabs.get = async () => ({ status: 'complete', url });
  chrome.debugger.sendCommand = async (_, method) => {
    if (method === 'Accessibility.getFullAXTree') {
      url = 'https://fixture.invalid/b';
      listeners.get('updated')(14, { status: 'loading', url });
      return { nodes: [{ role: { value: 'button' }, name: { value: 'Page A' }, backendDOMNodeId: 21 }] };
    }
    if (method === 'Runtime.evaluate') return { result: { value: url } };
    return {};
  };
  await assert.rejects(vm.runInContext('axSnapshot(14, {})', context), /page changed/i);
  assert.throws(() => vm.runInContext('snapshotNode(14, 0)', context), /no fresh ax snapshot/);

  chrome.debugger.sendCommand = async (_, method) => {
    if (method === 'Accessibility.getFullAXTree') {
      return { nodes: [{ role: { value: 'button' }, name: { value: 'Page B' }, backendDOMNodeId: 42 }] };
    }
    if (method === 'Runtime.evaluate') return { result: { value: url } };
    return {};
  };
  const fresh = await vm.runInContext('axSnapshot(14, {})', context);
  assert.equal(fresh.url, url);
  assert.equal(vm.runInContext('snapshotNode(14, 0).name', context), 'Page B');
});

test('ambiguous tabMatch fails closed instead of selecting the first tab', async () => {
  chrome.tabs.query = async () => [
    { id: 15, title: 'QA Order A', url: 'https://fixture.invalid/a', active: true },
    { id: 16, title: 'QA Order B', url: 'https://fixture.invalid/b' },
  ];
  await assert.rejects(vm.runInContext('pickTab({tabMatch: "QA Order"})', context), /matched 2 tabs.*tabId/i);
  assert.equal(await vm.runInContext('pickTab({tabMatch: "QA Order B"})', context), 16);
  assert.equal(await vm.runInContext('pickTab({tabId: 15, tabMatch: "QA Order"})', context), 15);
});

test('an incomplete wait request does not attach to a tab', async () => {
  let calls = 0;
  chrome.debugger.attach = async () => { calls++; };
  await assert.rejects(vm.runInContext('run("page.wait", {tabId: 17})', context), /selector or text is required/);
  assert.equal(calls, 0);
});

test('wait obeys the same internal-page restriction as other readers', async () => {
  let calls = 0;
  chrome.tabs.get = async () => ({ url: 'chrome://version', status: 'complete' });
  chrome.debugger.attach = async () => { calls++; throw new Error('Unexpected debugger attachment'); };
  await assert.rejects(vm.runInContext('run("page.wait", {tabId: 18, selector: "body"})', context), /internal pages are not drivable/i);
  assert.equal(calls, 0);
});

test('screenshots never activate a loading tab or touch its debugger', async () => {
  let reads = 0;
  chrome.tabs.get = async () => ({ active: false, status: ++reads === 1 ? 'loading' : 'complete', url: 'https://fixture.invalid/a' });
  let attempts = 0;
  chrome.tabs.update = chrome.debugger.attach = async () => { attempts++; };
  await assert.rejects(vm.runInContext('run("page.shot", {tabId: 23})', context), /still loading/i);
  assert.equal(attempts, 0);
});

test('a stalled inactive screenshot has a bounded actionable error and no activation', async () => {
  chrome.tabs.get = async () => ({ active: false, status: 'complete', url: 'https://fixture.invalid/a' });
  let attempts = 0;
  chrome.tabs.update = async () => { attempts++; };
  chrome.debugger.attach = async () => {};
  chrome.debugger.sendCommand = async (target, method) => {
    assert.equal(target.tabId, 24);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'a', loaderId: 'l', url: 'https://fixture.invalid/a' } } };
    assert.equal(method, 'Page.captureScreenshot');
    return new Promise(() => {});
  };
  const timers = [];
  const previous = context.setTimeout;
  context.setTimeout = (callback, ms) => {
    timers.push(ms);
    if (ms === 2000 || ms === 25000) queueMicrotask(callback);
    return 1;
  };
  try {
    await assert.rejects(vm.runInContext('run("page.shot", {tabId: 24})', context), /select the intended tab in Chrome and retry/i);
    assert.ok(timers.includes(2000));
    assert.equal(attempts, 0);
  } finally { context.setTimeout = previous; }
});

test('screenshot rejects a same-URL reload and preserves the exact tab on focus changes', async () => {
  const fixtureUrl = 'https://fixture.invalid/a';
  let loader = 'before', active = true, navigate = true;
  chrome.tabs.get = async () => ({ active, status: 'complete', url: fixtureUrl });
  chrome.debugger.attach = async () => {};
  chrome.debugger.sendCommand = async (target, method) => {
    assert.equal(target.tabId, 25);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'a', loaderId: loader, url: fixtureUrl } } };
    assert.equal(method, 'Page.captureScreenshot');
    active = false;
    if (navigate) loader = 'after';
    return { data: 'pixels-of-a' };
  };
  await assert.rejects(vm.runInContext('run("page.shot", {tabId: 25})', context), /page changed/i);
  active = true;
  navigate = false;
  const shot = await vm.runInContext('run("page.shot", {tabId: 25})', context);
  assert.equal(shot.tabId, 25);
  assert.equal(shot.data, 'pixels-of-a');
});
