// The socket's promises: a write never waits on the network, and nothing
// you typed is lost because the connection went away.

import test from 'node:test';
import assert from 'node:assert/strict';

// storage.js talks to window.localStorage, so give it one. Doing it this
// way rather than injecting a double means these tests exercise the real
// path, including the part where a reload reads the queue back off disk.
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
};

const { createSync, STATUS } = await import('../src/sync.js');
const { putPerson } = await import('../src/ops.js');

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.last = this;
  }
  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code, reason });
  }
  receive(message) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(message) });
  }
  pushes() {
    return this.sent.filter((m) => m.type === 'push');
  }
}

function harness(roomId, extra = {}) {
  const seen = { snapshots: [], ops: [], statuses: [], notices: [] };
  const sync = createSync(
    Object.assign(
      {
        endpoint: 'https://example.com/api',
        roomId,
        WebSocketImpl: FakeSocket,
        // Retries are driven by hand so nothing here waits on a clock.
        setTimer: () => 0,
        clearTimer: () => {},
        onSnapshot: (snapshot) => seen.snapshots.push(snapshot),
        onOps: (ops) => seen.ops.push(...ops),
        onStatus: (status) => seen.statuses.push(status),
        onNotice: (notice) => seen.notices.push(notice),
      },
      extra
    )
  );
  return { sync, seen };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a room arrives in pieces and is handed over whole', async () => {
  const { sync, seen } = harness('room-snapshot');
  sync.start();
  FakeSocket.last.open();

  FakeSocket.last.receive({ type: 'hello', usage: { bytes: 10, records: 2 } });
  FakeSocket.last.receive({
    type: 'records',
    items: [{ kind: 'person', type: 'put', at: 1, id: 'p1', blob: 'a' }],
    last: false,
  });
  await settle();
  assert.equal(seen.snapshots.length, 0, 'half a room is not shown');

  FakeSocket.last.receive({
    type: 'records',
    items: [{ kind: 'expense', type: 'put', at: 2, id: 'e1', blob: 'b' }],
    last: true,
  });
  await settle();

  assert.equal(seen.snapshots.length, 1);
  assert.equal(seen.snapshots[0].items.length, 2, 'both chunks, once');
  assert.equal(sync.getStatus(), STATUS.online);
});

test('writes made with no connection are kept and sent on the next one', async () => {
  const { sync } = harness('room-offline');
  sync.push([putPerson({ id: 'p1', name: 'Ana' }, 5)]);
  assert.equal(sync.getPending(), 1, 'queued, not lost, and nothing threw');

  sync.start();
  FakeSocket.last.open();
  await settle();

  assert.equal(FakeSocket.last.pushes().length, 1);
  assert.equal(FakeSocket.last.pushes()[0].ops[0].record.name, 'Ana');
});

test('the queue outlives the tab it was typed into', async () => {
  const first = harness('room-reload');
  first.sync.push([putPerson({ id: 'p1', name: 'Ana' }, 5)]);
  assert.equal(first.sync.getPending(), 1);

  // A reload: same room, a brand new sync that has never seen that op.
  const second = harness('room-reload');
  assert.equal(second.sync.getPending(), 1, 'read back off disk');

  second.sync.start();
  FakeSocket.last.open();
  await settle();
  assert.equal(FakeSocket.last.pushes()[0].ops[0].record.name, 'Ana');
});

test('an ack drains the batch and a second connection does not resend it', async () => {
  const { sync } = harness('room-ack');
  sync.start();
  FakeSocket.last.open();
  sync.push([putPerson({ id: 'p1', name: 'Ana' }, 5)]);
  await settle();

  const seq = FakeSocket.last.pushes()[0].seq;
  FakeSocket.last.receive({ type: 'ack', seq, usage: { bytes: 40, records: 1 } });
  assert.equal(sync.getPending(), 0);

  FakeSocket.last.close(1006);
  sync.reconnect();
  FakeSocket.last.open();
  await settle();
  assert.equal(FakeSocket.last.pushes().length, 0, 'nothing left to say');
});

test('a batch the server refuses is dropped and the room is asked for again', async () => {
  const { sync, seen } = harness('room-reject');
  sync.start();
  FakeSocket.last.open();
  sync.push([putPerson({ id: 'p1', name: 'Ana' }, 5)]);
  await settle();

  const seq = FakeSocket.last.pushes()[0].seq;
  FakeSocket.last.receive({
    type: 'reject',
    seq,
    reason: 'full',
    message: 'This tracker is full.',
  });

  assert.equal(sync.getPending(), 0, 'retrying a refused write forever helps nobody');
  assert.equal(seen.notices[0].kind, 'full');
  assert.ok(
    FakeSocket.last.sent.some((m) => m.type === 'resync'),
    'and the screen goes back to what the room actually holds'
  );
});

test('a room this link cannot open stops trying instead of hammering', async () => {
  const { sync, seen } = harness('room-gone');
  sync.start();
  FakeSocket.last.open();
  FakeSocket.last.close(4403, 'not found');

  assert.equal(sync.getStatus(), STATUS.blocked);
  assert.equal(seen.statuses.at(-1), STATUS.blocked);
});

test('leaving for good takes the unsent queue with it', async () => {
  const { sync } = harness('room-leave');
  sync.push([putPerson({ id: 'p1', name: 'Ana' }, 5)]);
  assert.equal(sync.getPending(), 1);

  sync.discardQueue();
  assert.equal(sync.getPending(), 0);
  assert.equal(harness('room-leave').sync.getPending(), 0, 'and off the disk too');
});
