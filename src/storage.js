// The only place that knows data lives in localStorage.
//
// Two kinds of data live here under two kinds of key. Your own months sit
// under LOCAL_KEY and never leave the browser. A shared room gets its own
// key, so joining one does not touch what you already had and leaving one
// hands it straight back. That is also the cache: the app opens on the
// last thing it saw, then the socket corrects it.

export const LOCAL_KEY = 'common-expense-tracker/v1';

/** Where a room's own cached copy lives on this device. */
export function roomKey(roomId) {
  return 'common-expense-tracker/room/' + roomId;
}

function memoryBackend() {
  let value = null;
  return {
    read: () => value,
    write: (raw) => {
      value = raw;
    },
    remove: () => {
      value = null;
    },
  };
}

function localBackend(key) {
  return {
    read: () => window.localStorage.getItem(key),
    write: (raw) => window.localStorage.setItem(key, raw),
    remove: () => window.localStorage.removeItem(key),
  };
}

function pickBackend(key) {
  try {
    const probe = key + '/probe';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return localBackend(key);
  } catch {
    // Private mode, blocked site data, or no window at all. The app still
    // works for the session, it just forgets on reload.
    return memoryBackend();
  }
}

/**
 * @param {string|{read:Function,write:Function,remove?:Function}} keyOrBackend
 *   A key names a slot in localStorage. A backend object is for tests.
 */
export function createStorage(keyOrBackend = LOCAL_KEY) {
  const backend =
    typeof keyOrBackend === 'string' ? pickBackend(keyOrBackend) : keyOrBackend;

  return {
    load() {
      try {
        const raw = backend.read();
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    },
    save(state) {
      try {
        backend.write(JSON.stringify(state));
        return true;
      } catch {
        // Quota, or storage switched off mid-session. Losing the cache is
        // survivable; in a room the server still has everything.
        return false;
      }
    },
    clear() {
      try {
        if (backend.remove) backend.remove();
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Small key-value corner for things that are about this browser rather
 * than about any month: which rooms it has opened, mostly.
 */
export function createDeviceMemory(key = 'common-expense-tracker/device') {
  const store = createStorage(key);
  return {
    read() {
      const value = store.load();
      return value && typeof value === 'object' ? value : {};
    },
    write(value) {
      return store.save(value);
    },
  };
}
