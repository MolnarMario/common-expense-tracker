// Where a room id lives: in the fragment of the URL.
//
// The fragment, not a query string, and that is deliberate. Browsers never
// put the part after # in the HTTP request, and it is stripped from the
// Referer header on any link out of the page. So the id stays out of the
// web server's access logs and out of anyone else's. Since the id is the
// only thing standing between a stranger and the room, that matters.

/** 160 bits, Crockford-ish base32. Minted by the server, never guessed. */
export const ROOM_ID = /^[a-z2-7]{32}$/;

export function isRoomId(value) {
  return typeof value === 'string' && ROOM_ID.test(value);
}

/** @param {string} hash location.hash, with or without the leading #. */
export function readRoomId(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const id = params.get('s');
  return isRoomId(id) ? id : null;
}

/** The link you send someone. Absolute, because it goes into a chat app. */
export function roomUrl(roomId, base) {
  const url = new URL(base);
  url.hash = 's=' + roomId;
  return url.toString();
}

/**
 * Where the sync API lives. Same origin as the page by default, which is
 * how it runs on a real domain: the site and the Worker share a hostname,
 * so there is no CORS in the picture at all.
 *
 * A page opened straight off disk has no origin to speak of and cannot
 * reach anything, so sharing is switched off rather than left to fail one
 * request at a time.
 */
export function syncEndpoint(doc, loc) {
  const override = doc && doc.querySelector('meta[name="sync-endpoint"]');
  if (override && override.content) return override.content.replace(/\/+$/, '');
  if (!loc || loc.protocol === 'file:') return null;
  return loc.origin + '/api';
}

/** http(s) endpoint to the ws(s) one the socket needs. */
export function socketUrl(endpoint, roomId) {
  const url = new URL(endpoint + '/rooms/' + roomId + '/socket');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

// ------------------------------------------------------- rooms this device knows

const MAX_REMEMBERED = 12;

/**
 * Losing the link loses the room, so every room this browser has opened is
 * kept in a list it can offer back. It is a convenience, not a backup:
 * clearing site data clears this too, which is what the export is for.
 */
export function knownRooms(memory) {
  const list = memory.read().rooms;
  return Array.isArray(list) ? list.filter((r) => r && isRoomId(r.id)) : [];
}

export function rememberRoom(memory, roomId, patch = {}) {
  if (!isRoomId(roomId)) return knownRooms(memory);
  const rooms = knownRooms(memory).filter((r) => r.id !== roomId);
  const previous = knownRooms(memory).find((r) => r.id === roomId) || {};
  rooms.unshift({
    id: roomId,
    label: patch.label || previous.label || '',
    seenAt: patch.seenAt || Date.now(),
  });
  const kept = rooms.slice(0, MAX_REMEMBERED);
  memory.write(Object.assign(memory.read(), { rooms: kept }));
  return kept;
}

export function forgetRoom(memory, roomId) {
  const kept = knownRooms(memory).filter((r) => r.id !== roomId);
  memory.write(Object.assign(memory.read(), { rooms: kept }));
  return kept;
}
