// Makes a new admin token, saves it in worker/.admin-token (gitignored),
// and sets it as the deployed Worker's ADMIN_TOKEN secret.
//
//   node scripts/set-admin-token.mjs
//
// Needs `npx wrangler login` first. The old token stops working the moment
// this runs. Shared trackers and invite codes already handed out are not
// affected: the token only gates minting codes, listing rooms, and
// answering access requests.

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const worker = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'worker');
const token = randomBytes(32).toString('base64url');

const result = spawnSync('npx wrangler secret put ADMIN_TOKEN', {
  cwd: worker,
  input: token,
  shell: true,
  stdio: ['pipe', 'inherit', 'inherit'],
});

if (result.status !== 0) {
  console.error('\nwrangler did not take the secret; nothing was saved. Run `npx wrangler login` in worker/ and try again.');
  process.exit(1);
}

writeFileSync(join(worker, '.admin-token'), token);
console.log('\nDone. The token is in worker/.admin-token. To use it from PowerShell:');
console.log('  $env:API = "https://expenses.thebarbellengineer.com/api"');
console.log('  $env:ADMIN_TOKEN = Get-Content worker\\.admin-token');
console.log('  node scripts/admin.mjs requests');
