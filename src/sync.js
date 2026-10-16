// The socket to a room, and the queue in front of it.
//
// Writes never wait on the network. A local change is applied on screen at
// once and its ops go into a queue that drains whenever a connection
// exists. The queue is saved to disk, so closing a tab on the underground
// with three unsent expenses in it loses nothing.
//
// Every op is an absolute write to one record, so re-sending a batch after
// a connection dies mid-flight is harmless. That is the property the whole
// retry story leans on: delivery only has to be at-least-once.

import { createStorage } from './storage.js';
import { socketUrl } from './room-link.js';
import { LIMITS } from './records.js';

export const STATUS = {
  offline: 'offline',
  connecting: 'connecting',
  online: 'online',
  blocked: 'blocked',
};

/**
 * What a socket does when nothing is encrypting anything: hand the ops
 * through untouched. Only tests run this way. The app always passes a real
 * codec, because a room without a key is a room nobody can read.
 */
const passthrough = {
  sealOps: async (ops) => ops,
  openOps: async (ops) => ops,
  openSnapshot: async (items) => ({ people: [], expenses: [], items }),
};

const FIRST_RETRY_MS = 600;
const MAX_RETRY_MS = 15000;
const PING_EVERY_MS = 25000;
/** No traffic at all for this long means the socket is dead but pretending. */
const SILENCE_LIMIT_MS = 60000;

/**
 * @param {object} config
 * @param {string} config.endpoint  e.g. "https://example.com/api"
 * @param {string} config.roomId
 * @param {(snapshot: object, meta: object) => void} config.onSnapshot
 * @param {(ops: object[]) => void} config.onOps
 * @param {(status: string, detail: object) => void} config.onStatus
 * @param {(notice: {kind: string, message: string}) => void} config.onNotice
 */
export function createSync(config) {
  const {
    endpoint,
    roomId,
    onSnapshot = () => {},
    onOps = () => {},
    onStatus = () => {},
    onNotice = () => {},
    codec = passthrough,
    WebSocketImpl = typeof WebSocket === 'undefined' ? null : WebSocket,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
  } = config;

  const queueStore = createStorage('common-expense-tracker/queue/' + roomId);
  /** @type {{seq: number, ops: object[]}[]} */
  let queue = loadQueue();
  let nextSeq = queue.reduce((max, batch) => Math.max(max, batch.seq), 0) + 1;

  let socket = null;
  let status = STATUS.offline;
  let attempt = 0;
  let retryHandle = null;
  let pingHandle = null;
  let lastMessageAt = 0;
  let stopped = false;
  let usage = null;
  /** Snapshot chunks in flight, or null between handovers. */
  let incoming = null;
  /** Batch seqs already on the wire, so a flush does not send them twice. */
  const inFlight = new Set();

  function loadQueue() {
    const saved = queueStore.load();
    return Array.isArray(saved && saved.batches) ? saved.batches : [];
  }

  function saveQueue() {
    queueStore.save({ batches: queue });
  }

  function setStatus(next, detail = {}) {
    if (status === next && !detail.force) return;
    status = next;
    onStatus(next, Object.assign({ pending: pendingOps(), usage }, detail));
  }

  function pendingOps() {
    return queue.reduce((total, batch) => total + batch.ops.length, 0);
  }

  // ------------------------------------------------------------ connecting

  function connect() {
    if (stopped || !WebSocketImpl) return;
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;

    setStatus(STATUS.connecting);
    let opened;
    try {
      opened = new WebSocketImpl(socketUrl(endpoint, roomId));
    } catch {
      scheduleRetry();
      return;
    }
    socket = opened;

    opened.onopen = () => {
      attempt = 0;
      lastMessageAt = now();
      setStatus(STATUS.online);
      flush();
      startPinging();
    };

    opened.onmessage = (event) => {
      lastMessageAt = now();
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      handle(message);
    };

    opened.onclose = (event) => {
      stopPinging();
      // Whatever was mid-flight never got an ack, so it goes again.
      inFlight.clear();
      if (socket === opened) socket = null;
      // 4403 is the server saying this room is not yours to open. Retrying
      // that forever would just be noise, so the app is told instead.
      if (event && event.code === 4403) {
        setStatus(STATUS.blocked, { reason: event.reason || 'This room is not available.' });
        return;
      }
      if (!stopped) {
        setStatus(STATUS.offline);
        scheduleRetry();
      }
    };

    opened.onerror = () => {
      // onclose always follows, and that is where the retry lives.
    };
  }

  function scheduleRetry() {
    if (stopped || retryHandle) return;
    const base = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * Math.pow(2, attempt));
    // Jitter keeps two devices waking from sleep together from knocking in
    // lockstep for as long as the outage lasts.
    const wait = Math.round(base * (0.6 + Math.random() * 0.6));
    attempt += 1;
    retryHandle = setTimer(() => {
      retryHandle = null;
      connect();
    }, wait);
  }

  function startPinging() {
    stopPinging();
    pingHandle = setTimer(function beat() {
      if (stopped) return;
      // A phone that slept through a network change keeps a socket that
      // looks open and delivers nothing. Silence is the only tell.
      if (now() - lastMessageAt > SILENCE_LIMIT_MS) {
        reconnectNow();
        return;
      }
      send({ type: 'ping' });
      pingHandle = setTimer(beat, PING_EVERY_MS);
    }, PING_EVERY_MS);
  }

  function stopPinging() {
    if (pingHandle) clearTimer(pingHandle);
    pingHandle = null;
  }

  function reconnectNow() {
    if (stopped) return;
    if (retryHandle) {
      clearTimer(retryHandle);
      retryHandle = null;
    }
    attempt = 0;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* already gone */
      }
      socket = null;
    }
    connect();
  }

  // -------------------------------------------------------------- messages

  function handle(message) {
    switch (message.type) {
      case 'hello':
        usage = message.usage || null;
        // A room arrives in pieces, so nothing is handed over until the
        // last one lands. Half a room on screen would be worse than none.
        incoming = [];
        break;

      case 'records': {
        if (!incoming) incoming = [];
        for (const item of message.items || []) incoming.push(item);
        if (!message.last) break;
        const items = incoming;
        incoming = null;
        codec.openSnapshot(items).then((snapshot) => {
          onSnapshot(snapshot, { usage });
          setStatus(STATUS.online, { force: true });
          // The snapshot is the server's state without our unsent work in
          // it, so put that back on top rather than letting it disappear.
          flush();
        });
        break;
      }

      case 'ops':
        if (!Array.isArray(message.ops) || message.ops.length === 0) break;
        codec.openOps(message.ops).then((ops) => {
          if (ops.length > 0) onOps(ops);
        });
        break;

      case 'ack':
        usage = message.usage || usage;
        inFlight.delete(message.seq);
        queue = queue.filter((batch) => batch.seq !== message.seq);
        saveQueue();
        setStatus(status, { force: true });
        break;

      case 'reject':
        usage = message.usage || usage;
        inFlight.delete(message.seq);
        queue = queue.filter((batch) => batch.seq !== message.seq);
        saveQueue();
        onNotice({ kind: message.reason || 'rejected', message: message.message || '' });
        // Whatever we drew optimistically was refused, so go back to what
        // the room actually holds instead of showing a change nobody has.
        send({ type: 'resync' });
        break;

      case 'error':
        onNotice({ kind: 'error', message: message.message || '' });
        break;

      default:
        break;
    }
  }

  function send(message) {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The queue holds plain ops and they are sealed on the way out, one
   * batch at a time. Sealing on send rather than on queue keeps push()
   * synchronous, and costs nothing in safety: the queue lives in this
   * browser's own storage, next to the decrypted cache and the key itself.
   *
   * Batches can finish sealing out of order. That is fine, because every
   * op is an absolute write stamped with a time, and the server keeps the
   * newer stamp whichever order the two arrive in.
   */
  /**
   * Send everything queued that is not already on its way.
   *
   * The in-flight set is what keeps a batch from going out twice when a
   * fresh write and a reconnect flush overlap. A seq joins it before the
   * sealing starts, not after, because sealing is where the overlap
   * happens. Losing the connection empties the set, so anything that was
   * mid-flight when the socket died goes again on the next one.
   */
  async function flush() {
    for (const batch of queue.slice()) {
      if (inFlight.has(batch.seq)) continue;
      inFlight.add(batch.seq);
      try {
        const sealed = await codec.sealOps(batch.ops);
        if (!send({ type: 'push', seq: batch.seq, ops: sealed })) inFlight.delete(batch.seq);
      } catch {
        // Sealing failed, so the key went away. The batch stays queued and
        // the next unlock sends it.
        inFlight.delete(batch.seq);
      }
    }
    setStatus(status, { force: true });
  }

  // ----------------------------------------------------------------- public

  return {
    start() {
      stopped = false;
      connect();
    },

    stop() {
      stopped = true;
      stopPinging();
      if (retryHandle) clearTimer(retryHandle);
      retryHandle = null;
      if (socket) {
        try {
          socket.close(1000, 'left');
        } catch {
          /* already gone */
        }
      }
      socket = null;
      setStatus(STATUS.offline);
    },

    /** Queue local ops and try to send them. Never throws, never blocks. */
    push(ops) {
      if (!Array.isArray(ops) || ops.length === 0) return;
      for (let i = 0; i < ops.length; i += LIMITS.batchOps) {
        queue.push({ seq: nextSeq++, ops: ops.slice(i, i + LIMITS.batchOps) });
      }
      saveQueue();
      flush();
    },

    /** Ask for the room again, e.g. after coming back from a long sleep. */
    resync() {
      if (!send({ type: 'resync' })) reconnectNow();
    },

    reconnect: reconnectNow,
    getStatus: () => status,
    getPending: pendingOps,
    getUsage: () => usage,

    /** Leaving a room for good: the unsent queue goes with it. */
    discardQueue() {
      queue = [];
      inFlight.clear();
      saveQueue();
    },
  };
}
