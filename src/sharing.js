// Joining, unlocking, leaving, and being in a room.
//
// Two rules hold the whole thing together.
//
// Your own months and a shared room are separate piles of data in separate
// places on this device. Joining does not consume what you had and leaving
// hands it straight back. The only bridge is the one you press.
//
// The link gets you to a room, the password gets you into it. The server
// hands out a wrapped key to anyone who asks, because without the password
// that blob is noise. Once a device unwraps it, it keeps the key, which is
// what "type it once per device" means.

import { createStorage, roomKey, LOCAL_KEY } from './storage.js';
import { createStore } from './state.js';
import { createSync, STATUS } from './sync.js';
import { forgetRoom, isRoomId, readRoomId, rememberRoom, roomUrl } from './room-link.js';
import { openSnapshot, openOps, sealOps } from './envelope.js';
import {
  canEncrypt,
  createLock,
  exportDataKey,
  fromRecoveryKey,
  generateDataKey,
  importDataKey,
  openLock,
  toBase64,
  fromBase64,
  toRecoveryKey,
} from './crypto.js';

/** Where this device is, as far as sharing goes. */
export const MODE = {
  /** Your own months. No room, no socket, nothing leaves the browser. */
  local: 'local',
  /** A room link is open but this device has no key for it yet. */
  locked: 'locked',
  /** In a room, key in hand. */
  room: 'room',
};

const keyStoreFor = (roomId) => createStorage('common-expense-tracker/key/' + roomId);

export function createSharing(config) {
  const {
    store,
    endpoint,
    memory,
    onStatus = () => {},
    onNotice = () => {},
    loc = typeof location === 'undefined' ? null : location,
    request = typeof fetch === 'undefined' ? null : fetch,
  } = config;

  const available = endpoint !== null && canEncrypt();

  let sync = null;
  let mode = MODE.local;
  let roomId = null;
  let pendingRoomId = null;
  let dataKey = null;
  let status = STATUS.offline;
  let usage = null;

  function report(extra = {}) {
    onStatus(
      Object.assign(
        {
          mode,
          roomId: roomId || pendingRoomId,
          status,
          usage,
          available,
          pending: sync ? sync.getPending() : 0,
        },
        extra
      )
    );
  }

  // ------------------------------------------------------- the cached key

  async function rememberKey(id, key) {
    keyStoreFor(id).save({ key: toBase64(await exportDataKey(key)), savedAt: Date.now() });
  }

  async function recallKey(id) {
    const saved = keyStoreFor(id).load();
    if (!saved || typeof saved.key !== 'string') return null;
    try {
      return await importDataKey(fromBase64(saved.key));
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------- the API calls

  async function api(path, options) {
    const response = await request(endpoint + path, options);
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload };
  }

  async function fetchLock(id) {
    try {
      const { ok, payload } = await api('/rooms/' + id + '/lock', { method: 'GET' });
      if (!ok || !payload || !payload.lock) return null;
      return payload.lock;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ connecting

  function codec() {
    return {
      sealOps: (ops) => sealOps(dataKey, ops),
      openOps: (items) => openOps(dataKey, items),
      openSnapshot: (items) => openSnapshot(dataKey, items),
    };
  }

  function connect(id) {
    sync = createSync({
      endpoint,
      roomId: id,
      codec: codec(),
      onSnapshot: (snapshot) => {
        store.applyRoomSnapshot(snapshot);
        rememberRoom(memory, id, { seenAt: Date.now() });
        if (snapshot.failed > 0) {
          onNotice({
            kind: 'undecryptable',
            message:
              snapshot.failed +
              (snapshot.failed === 1 ? ' entry' : ' entries') +
              ' in this tracker could not be read with this password.',
          });
        }
      },
      onOps: (ops) => store.applyRemoteOps(ops),
      onStatus: (next, detail) => {
        status = next;
        usage = detail.usage || usage;
        report();
      },
      onNotice: (notice) => {
        onNotice(notice);
        report();
      },
    });
    sync.start();
  }

  /** Point the app at a room: different storage, different data, same screen. */
  function enter(id, key) {
    if (sync) sync.stop();
    dataKey = key;
    roomId = id;
    pendingRoomId = null;
    mode = MODE.room;
    usage = null;
    store.rebind(createStorage(roomKey(id)));
    rememberRoom(memory, id, { seenAt: Date.now() });
    if (loc) loc.hash = 's=' + id;
    connect(id);
    report();
    return { ok: true, roomId: id };
  }

  return {
    isAvailable: () => available,
    getMode: () => mode,
    isShared: () => mode === MODE.room,
    getRoomId: () => roomId || pendingRoomId,
    getStatus: () => status,
    getUsage: () => usage,
    getPending: () => (sync ? sync.getPending() : 0),

    /** The link to send someone. It carries no key and no password. */
    getLink(id = roomId || pendingRoomId) {
      if (!id || !loc) return '';
      return roomUrl(id, loc.href.split('#')[0]);
    },

    /**
     * Ops from local changes. Dropped on the floor when there is no room,
     * which is what makes the whole app work unchanged on its own.
     */
    push(ops) {
      if (sync) sync.push(ops);
    },

    /**
     * Read the URL. A room this device already knows opens straight away;
     * one it does not needs the password first.
     *
     * @returns {Promise<{mode: string, roomId: string|null}>}
     */
    async start() {
      const id = available && loc ? readRoomId(loc.hash) : null;
      if (!id) {
        report();
        return { mode, roomId: null };
      }

      const key = await recallKey(id);
      if (key) {
        enter(id, key);
        return { mode, roomId: id };
      }

      pendingRoomId = id;
      mode = MODE.locked;
      report();
      return { mode, roomId: id };
    },

    /**
     * Turn a password into the key for the room in the URL. Wrong ones
     * fail here and nowhere else: AES-GCM will not open a blob with the
     * wrong key, so there is no separate password check to get wrong.
     */
    async unlock(password, id = pendingRoomId) {
      if (!id) return { ok: false, error: 'There is no tracker to unlock.' };
      const lock = await fetchLock(id);
      if (!lock) {
        return { ok: false, error: 'That link does not point at a tracker any more.' };
      }
      const key = await openLock(lock, password);
      if (!key) return { ok: false, error: 'That password does not open this tracker.' };
      await rememberKey(id, key);
      return enter(id, key);
    },

    /** The way back in when the password is gone but the paper is not. */
    async unlockWithRecoveryKey(text, id = pendingRoomId) {
      if (!id) return { ok: false, error: 'There is no tracker to unlock.' };
      const key = await fromRecoveryKey(text);
      if (!key) return { ok: false, error: 'That does not look like a recovery key.' };
      await rememberKey(id, key);
      return enter(id, key);
    },

    /**
     * Ask the server for a room. The key is made here and the password
     * never goes anywhere: the server is handed a blob it cannot open and
     * a random id to file it under.
     */
    async create(code, password) {
      if (!available || !request) {
        return { ok: false, error: 'Sharing is not available on this page.' };
      }
      if (!password || password.length < 8) {
        return { ok: false, error: 'Use a password of at least 8 characters.' };
      }

      const key = await generateDataKey();
      const lock = await createLock(key, password);

      let result;
      try {
        result = await api('/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, lock }),
        });
      } catch {
        return { ok: false, error: 'Could not reach the server. Check your connection.' };
      }

      const payload = result.payload;
      if (!payload || !payload.ok || !isRoomId(payload.roomId)) {
        return { ok: false, error: codeError(payload && payload.error) };
      }

      await rememberKey(payload.roomId, key);
      const entered = enter(payload.roomId, key);
      // Shown once, and only here. After this the key exists in two places
      // that both burn with the browser profile.
      return Object.assign(entered, { recoveryKey: await toRecoveryKey(key) });
    },

    /**
     * Re-wrap the same data key with a new password. Everything already in
     * the room stays readable, and other devices keep working because
     * their copy of the key has not changed. They only need the new
     * password the next time one of them starts from scratch.
     */
    async changePassword(next) {
      if (mode !== MODE.room || !dataKey) return { ok: false, error: 'Not in a shared tracker.' };
      if (!next || next.length < 8) {
        return { ok: false, error: 'Use a password of at least 8 characters.' };
      }
      const lock = await createLock(dataKey, next);
      try {
        const { ok } = await api('/rooms/' + roomId + '/lock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lock }),
        });
        if (!ok) return { ok: false, error: 'The server refused that change.' };
      } catch {
        return { ok: false, error: 'Could not reach the server. Check your connection.' };
      }
      return { ok: true };
    },

    async getRecoveryKey() {
      return dataKey ? toRecoveryKey(dataKey) : '';
    },

    /**
     * Back to this device's own months. The room is untouched and the link
     * still works; this browser just stops watching it.
     *
     * @param {{forget?: boolean}} options forget also drops the cached copy,
     *   the saved key, and the entry in the list of rooms this device knows.
     *   That is the "not on this device any more" button.
     */
    leave(options = {}) {
      const leaving = roomId || pendingRoomId;
      if (!leaving) return { ok: false, error: 'Not in a shared tracker.' };
      if (sync) {
        if (options.forget) sync.discardQueue();
        sync.stop();
      }
      sync = null;
      dataKey = null;
      roomId = null;
      pendingRoomId = null;
      mode = MODE.local;
      status = STATUS.offline;
      usage = null;

      if (options.forget) {
        createStorage(roomKey(leaving)).clear();
        keyStoreFor(leaving).clear();
        forgetRoom(memory, leaving);
      }

      store.rebind(createStorage(LOCAL_KEY));
      if (loc) {
        // Clear the fragment without leaving a bare # in the address bar.
        const base = loc.href.split('#')[0];
        if (typeof history !== 'undefined' && history.replaceState) {
          history.replaceState(null, '', base);
        } else {
          loc.hash = '';
        }
      }
      report();
      return { ok: true, roomId: leaving };
    },

    /**
     * Everything in this device's own months, as ops. Offered when you
     * land in an empty room: it is your data and the room is yours, so
     * copying it across is a one-way push into nothing, with no merge to
     * get wrong.
     */
    localOps() {
      return createStore(createStorage(LOCAL_KEY)).toOps();
    },

    moveLocalDataIn() {
      if (mode !== MODE.room) return { ok: false, error: 'Not in a shared tracker.' };
      const ops = this.localOps();
      if (ops.length === 0) return { ok: false, error: 'There is nothing here to move.' };
      return store.ingestOps(ops);
    },

    knownRoom: (id) => keyStoreFor(id).load() !== null,
    resync: () => sync && sync.resync(),
    reconnect: () => sync && sync.reconnect(),
    report,
  };
}

function codeError(error) {
  if (error === 'used_code') return 'That code has already been used.';
  if (error === 'rate') return 'Too many tries. Wait an hour and try again.';
  if (error === 'bad_code') return 'That code is not one of ours.';
  if (error === 'bad_lock') return 'The browser could not lock the tracker. Try again.';
  return 'The server refused that. Check the code and try again.';
}
