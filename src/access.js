// Asking for an invite code, from the browser that will use it.
//
// The request carries a name and a line about who is asking, nothing more.
// The server answers with an id and a secret, and this browser keeps both.
// Coming back later, it asks how the request went; once it is approved,
// the answer carries the code and the Share dialog fills it in. The code
// never has to travel by email, and the server never learns an address.

import { createStorage } from './storage.js';

export const ACCESS_KEY = 'common-expense-tracker/access-request';
export const ACCESS_LIMITS = { name: 60, message: 500 };

export const ACCESS = {
  none: 'none',
  pending: 'pending',
  approved: 'approved',
  declined: 'declined',
};

/**
 * @param {{ endpoint: string, request?: Function, storage?: ReturnType<typeof createStorage> }} config
 */
export function createAccessRequests(config) {
  const {
    endpoint,
    request = typeof fetch === 'undefined' ? null : fetch,
    storage = createStorage(ACCESS_KEY),
  } = config;

  async function post(path, body) {
    const response = await request(endpoint + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload: payload || {} };
  }

  function saved() {
    const value = storage.load();
    return value && typeof value.id === 'string' && typeof value.secret === 'string' ? value : null;
  }

  return {
    /** What this browser last knew, without asking the server. */
    current() {
      const value = saved();
      if (!value) return { status: ACCESS.none };
      return { status: value.status || ACCESS.pending, sentAt: value.sentAt, code: value.code || null };
    },

    async send(name, message) {
      const cleanName = String(name || '').trim().slice(0, ACCESS_LIMITS.name);
      const cleanMessage = String(message || '').trim().slice(0, ACCESS_LIMITS.message);
      if (!cleanMessage) return { ok: false, error: 'Say who you are and who you will share it with.' };

      let answer;
      try {
        answer = await post('/requests', { name: cleanName, message: cleanMessage });
      } catch {
        return { ok: false, error: 'Could not reach the server. Check the connection and try again.' };
      }
      if (!answer.ok) return { ok: false, error: requestError(answer.payload.error) };

      storage.save({
        id: answer.payload.id,
        secret: answer.payload.secret,
        sentAt: Date.now(),
        status: ACCESS.pending,
        code: null,
      });
      return { ok: true };
    },

    /** Ask the server how the request went, and remember the answer. */
    async check() {
      const value = saved();
      if (!value) return { status: ACCESS.none };

      let answer;
      try {
        answer = await post('/requests/status', { id: value.id, secret: value.secret });
      } catch {
        // Offline: say what we knew last.
        return this.current();
      }
      if (answer.status === 404) {
        // Swept after 30 days, or the server was reset. Either way it is gone.
        storage.clear();
        return { status: ACCESS.none, expired: true };
      }
      if (!answer.ok) return this.current();

      const status = Object.values(ACCESS).includes(answer.payload.status)
        ? answer.payload.status
        : ACCESS.pending;
      const next = Object.assign({}, value, { status, code: answer.payload.code || null });
      storage.save(next);
      return { status, sentAt: next.sentAt, code: next.code };
    },

    /** Done with it: the code was used, or a decline was read. */
    forget() {
      storage.clear();
    },
  };
}

function requestError(error) {
  if (error === 'rate') return 'You have sent a few requests today already. Try again tomorrow.';
  if (error === 'busy') return 'Too many requests are waiting right now. Try again in a few days.';
  if (error === 'bad_request') return 'Say who you are and who you will share it with.';
  return 'The server did not take that request. Try again later.';
}
