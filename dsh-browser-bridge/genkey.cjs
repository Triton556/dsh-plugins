// Generates a stable extension key (so the extension id never changes) and the
// manifest for the DSH browser bridge. Run once: node genkey.cjs <project dir>

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || __dirname;
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const key = der.toString('base64');
const hash = crypto.createHash('sha256').update(der).digest();
const id = hash.subarray(0, 16).toString('hex').split('')
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

const manifest = {
  manifest_version: 3,
  name: 'DSH Browser Bridge',
  version: '0.1.0',
  description: 'Local native-messaging bridge: lets DeepSeek Harness drive an already running browser through accessibility actions, without a debug port.',
  key,
  permissions: ['nativeMessaging', 'debugger', 'tabs', 'scripting', 'alarms', 'storage'],
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'background.js' },
  minimum_chrome_version: '116',
};

fs.mkdirSync(path.join(root, 'extension'), { recursive: true });
fs.writeFileSync(path.join(root, 'extension', 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(root, 'extension-id.txt'), 'EXTENSION_ID=' + id + '\n');
console.log('EXTENSION_ID=' + id);
