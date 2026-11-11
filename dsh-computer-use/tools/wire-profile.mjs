// Add the computer-use bundle to the desktop profile: dependency link plus the
// bundle entry, keeping the rest of the profile untouched.
import fs from 'node:fs';

const profile = 'F:/DeepSeek-Harness/data/profiles/desktop/package.json';
const target = 'C:/Users/Danil/Documents/deepseek-harness/default-workspace/dsh-computer-use';
const pkg = JSON.parse(fs.readFileSync(profile, 'utf8'));

pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['dsh-computer-use'] = `link:${target}`;

const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
if (!bundles.includes('dsh-computer-use')) bundles.push('dsh-computer-use');
if (pkg.dsh && pkg.dsh.profile) pkg.dsh.profile.bundles = bundles;

fs.writeFileSync(profile, JSON.stringify(pkg, null, 2) + '\n');
console.log('dependency added, bundles:', bundles.join(', '));
console.log('deps:', Object.keys(pkg.dependencies).join(', '));