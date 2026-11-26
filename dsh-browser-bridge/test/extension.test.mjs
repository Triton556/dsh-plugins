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
