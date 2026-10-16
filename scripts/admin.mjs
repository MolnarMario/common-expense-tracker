// The other end of the invite gate: what you run to let someone in.
//
//   node scripts/admin.mjs rooms                    what exists
//   node scripts/admin.mjs codes                    codes, and whether they are spent
//   node scripts/admin.mjs mint 5 "for the flat"    codes to hand out
//   node scripts/admin.mjs room "<password>" "Ana"  a room made here and now
//
// The last one is the hands-on path: it makes the key, locks it with the
// password you pass, and prints the link. Send the link one way and the
// password another. Nothing here ever tells the server the password, so a
// room made this way is as unreadable to you as any other the moment you
// forget what you typed.
//
//   API=https://expenses.example.com/api ADMIN_TOKEN=... node scripts/admin.mjs rooms

import { createLock, generateDataKey, toRecoveryKey } from '../src/crypto.js';

const API = (process.env.API ?? 'http://127.0.0.1:8787/api').replace(/\/+$/, '');
const SITE = process.env.SITE ?? API.replace(/\/api$/, '');
const TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';

const USAGE = [
  'usage:',
  '  node scripts/admin.mjs rooms',
  '  node scripts/admin.mjs codes',
  '  node scripts/admin.mjs mint [count] [note]',
  '  node scripts/admin.mjs room <password> [note]',
  '',
  'reads API, SITE and ADMIN_TOKEN from the environment',
].join('\n');

async function call(path, body) {
  let response;
  try {
    response = await fetch(API + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + TOKEN,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('could not reach ' + API);
  }

  const payload = await response.json().catch(() => null);
  if (response.status === 403) throw new Error('the server refused the admin token');
  if (!response.ok || !payload || payload.ok === false) {
    throw new Error('the server said ' + response.status + ' ' + JSON.stringify(payload));
  }
  return payload;
}

const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '');

async function listRooms() {
  const { rooms } = await call('/rooms');
  if (rooms.length === 0) return console.log('no rooms yet');
  for (const room of rooms) {
    console.log([when(room.createdAt), room.id, room.via, room.note || ''].join('  '));
  }
}

async function listCodes() {
  const { codes } = await call('/invites');
  if (codes.length === 0) return console.log('no codes yet');
  for (const code of codes) {
    const state = code.usedAt ? 'spent ' + when(code.usedAt) : 'unused';
    console.log([code.code, state, code.note || ''].join('  '));
  }
}

async function mint(count, note) {
  const { codes } = await call('/invites', { count: Number(count ?? 1), note: note ?? '' });
  for (const code of codes) console.log(code);
}

async function makeRoom(password, note) {
  if (!password || password.length < 8) {
    throw new Error('give a password of at least 8 characters as the first argument');
  }
  const key = await generateDataKey();
  const lock = await createLock(key, password);
  const { roomId } = await call('/rooms', { lock, note: note ?? '' });

  console.log('\nlink      ' + SITE + '/#s=' + roomId);
  console.log('password  ' + password + '   send this separately');
  console.log('recovery  ' + (await toRecoveryKey(key)));
  console.log('\nThe recovery key is the only way in if the password is lost, and it');
  console.log('is sitting in your shell history now. Move it or drop it deliberately.\n');
}

const [command, ...args] = process.argv.slice(2);

try {
  if (command === 'rooms') await listRooms();
  else if (command === 'codes') await listCodes();
  else if (command === 'mint') await mint(args[0], args[1]);
  else if (command === 'room') await makeRoom(args[0], args[1]);
  else console.log(USAGE);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
