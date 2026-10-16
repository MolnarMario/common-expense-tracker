import test from 'node:test';
import assert from 'node:assert/strict';

import {
  forgetRoom,
  isRoomId,
  knownRooms,
  readRoomId,
  rememberRoom,
  roomUrl,
  socketUrl,
  syncEndpoint,
} from '../src/room-link.js';

const ID = 'syw4ao373da3om4ngjm5grwpbdtawtuj';

function fakeMemory() {
  let value = {};
  return { read: () => value, write: (next) => (value = next) };
}

test('a room id is 160 bits of base32 and nothing else', () => {
  assert.equal(isRoomId(ID), true);
  assert.equal(isRoomId(ID.toUpperCase()), false);
  assert.equal(isRoomId(ID.slice(1)), false, 'too short');
  assert.equal(isRoomId(ID + 'a'), false, 'too long');
  assert.equal(isRoomId('syw4ao373da3om4ngjm5grwpbdtawt01'), false, '0 and 1 are not in base32');
  assert.equal(isRoomId(null), false);
});

test('the id is read out of the fragment, wherever the # is', () => {
  assert.equal(readRoomId('#s=' + ID), ID);
  assert.equal(readRoomId('s=' + ID), ID);
  assert.equal(readRoomId('#s=' + ID + '&anything=else'), ID);
  assert.equal(readRoomId('#s=nope'), null);
  assert.equal(readRoomId(''), null);
});

test('the link carries the id and no key', () => {
  const link = roomUrl(ID, 'https://expenses.example.com/');
  assert.equal(link, 'https://expenses.example.com/#s=' + ID);
  assert.equal(link.includes('k='), false);

  // Building one over a link that already has a fragment replaces it rather
  // than stacking a second.
  assert.equal(roomUrl(ID, 'https://expenses.example.com/#s=old'), 'https://expenses.example.com/#s=' + ID);
});

test('the API is same origin, so there is no CORS in the picture', () => {
  const loc = { protocol: 'https:', origin: 'https://expenses.example.com' };
  assert.equal(syncEndpoint(null, loc), 'https://expenses.example.com/api');
});

/**
 * The standalone build is meant to be emailed and double clicked, and a page
 * opened that way can reach nothing and encrypt nothing. Better to say so than
 * to fail one request at a time.
 */
test('a page opened from disk has no server, and says so instead of trying', () => {
  assert.equal(syncEndpoint(null, { protocol: 'file:', origin: 'null' }), null);
});

test('a meta tag can point somewhere else, for a split host', () => {
  const doc = {
    querySelector: () => ({ content: 'https://api.example.com/api/' }),
  };
  assert.equal(syncEndpoint(doc, { protocol: 'https:', origin: 'https://x' }), 'https://api.example.com/api');
});

test('http becomes ws and https becomes wss', () => {
  assert.equal(
    socketUrl('https://expenses.example.com/api', ID),
    'wss://expenses.example.com/api/rooms/' + ID + '/socket'
  );
  assert.equal(
    socketUrl('http://localhost:5173/api', ID),
    'ws://localhost:5173/api/rooms/' + ID + '/socket'
  );
});

test('a device remembers the trackers it has opened, newest first, without duplicates', () => {
  const memory = fakeMemory();
  const other = 'aaaa'.repeat(8);

  rememberRoom(memory, ID, { seenAt: 1000 });
  rememberRoom(memory, other, { seenAt: 2000 });
  rememberRoom(memory, ID, { seenAt: 3000 });

  const rooms = knownRooms(memory);
  assert.deepEqual(rooms.map((r) => r.id), [ID, other]);
  assert.equal(rooms[0].seenAt, 3000);

  forgetRoom(memory, ID);
  assert.deepEqual(knownRooms(memory).map((r) => r.id), [other]);
});

test('junk in the remembered list is ignored rather than rendered', () => {
  const memory = fakeMemory();
  memory.write({ rooms: [{ id: 'nope' }, null, { id: ID, seenAt: 1 }] });
  assert.deepEqual(knownRooms(memory).map((r) => r.id), [ID]);
});
