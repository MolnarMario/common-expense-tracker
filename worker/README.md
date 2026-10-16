# The sync server

A Cloudflare Worker with two Durable Object classes. One room is one object,
holding that room's records and the sockets currently watching them. That is
why live updates are so little code: the object that decides a write is the
object holding the listeners to tell about it.

It cannot read any of it. Records arrive already encrypted by the browser that
wrote them, and this side only ever sees an opaque string, a random id, and a
timestamp.

## Deploy

```
npm install
npx wrangler login
npx wrangler secret put ADMIN_TOKEN     # paste a long random string
npx wrangler deploy
```

Then point it at your domain. In `wrangler.toml`, uncomment the route and fill
in your hostname:

```toml
[[routes]]
pattern = "expenses.example.com/api/*"
zone_name = "example.com"
```

Serve the page itself from that same hostname, whether that is Cloudflare Pages,
a bucket, or anything else. Same origin means no CORS, and one less thing that
breaks on somebody's phone for reasons you cannot reproduce. If the page really
must live somewhere else, set `ALLOWED_ORIGIN` in `[vars]` to its exact origin,
and nothing else will be allowed through.

Generate the admin token with something like `openssl rand -base64 32`. It is
the only thing standing between a stranger and the ability to mint rooms, and
it lives in Cloudflare's secret store, never in the repo.

## Letting people in

Nobody can make a room by asking. It takes the admin token, which only you
have, or an invite code, which you minted and handed over. The client-side
`scripts/admin.mjs` in the parent directory drives both:

```
export API=https://expenses.example.com/api
export ADMIN_TOKEN=...

node ../scripts/admin.mjs mint 5 "for the flat"   # codes to hand out
node ../scripts/admin.mjs room "<password>" "Ana" # a room made here and now
node ../scripts/admin.mjs rooms                   # what exists
node ../scripts/admin.mjs codes                   # what is spent
```

`mint` is the one that scales. You hand someone a code, they type it into the
page, and it burns itself making their room. `room` is the hands-on version:
it makes the key here, locks it with the password you pass, and prints the
link. Send the link one way and the password another.

## Routes

```
GET  /api/health
POST /api/rooms                    admin token, or an invite code, plus a lock
GET  /api/rooms                    admin token
POST /api/invites                  admin token
GET  /api/invites                  admin token
GET  /api/rooms/:id/lock           public: the wrapped key, useless on its own
POST /api/rooms/:id/lock           needs proof you hold the data key
GET  /api/rooms/:id/usage
GET  /api/rooms/:id/socket         the WebSocket
```

## Limits

Set in `src/records.js`, shared with the browser so the client never sends
something the server will refuse.

| | |
|---|---|
| room | 2 MB, about 7,000 expenses, sixty years at a hundred a month |
| record | 2 KB sealed |
| batch | 400 ops per message |
| rate | 240 ops per 10s per connection |
| sockets | 16 per room |
| invite guesses | 12 per hour per address |

A batch that would burst the room is refused whole rather than half applied,
and the client is told to export before deleting rather than just failing.

## Costs

SQLite-backed Durable Objects are included in the free plan, and a household
room is kilobytes. The Spark plan has no card attached, so the worst a flood
can do is hit a ceiling and stop, not run up a bill.

## Local development

```
npm run dev              # this directory, port 8787
```

From the parent directory, `npm start` serves the page on 5173 and forwards
`/api` here, WebSocket upgrades included, so local development runs on one
origin exactly like production does.

```
npm run smoke            # two clients through the real protocol
npm run ui               # two headless Chrome profiles through the real UI
```
