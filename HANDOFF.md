# Where this was left (2026-11-20)

## Done

- **Access requests are live** at https://expenses.thebarbellengineer.com
  (PR #3, Worker version `059fb133`). The Share dialog has "No code? Request
  one". It sends a name and a short message, and no email. An approved
  request's code fills itself in for the requester. See the README and
  `worker/README.md`.
- Before that deploy, the live page was checked to be identical to `main`,
  so nothing that had only been deployed was overwritten.
- Checked live: `/api/health` works, the request link is on the page, an
  empty request gets 400, an unknown request id gets 404, and the request
  list without the admin token gets 403.
- Tests: 134 unit tests pass (`npm test`) and `npm run smoke` passes.
  The request flow was also run end to end in Chrome against `wrangler dev`.

## Not done: the admin token

You need the admin token to list, approve, and decline requests, and to
mint codes. The original was not saved anywhere on this computer
(`worker/.admin-token` is missing). Cloudflare still holds the old one.

Make a new one (this replaces the old one):

```
cd worker
npx wrangler login          # if `npx wrangler whoami` says you're logged out
cd ..
node scripts/set-admin-token.mjs
```

Then:

```
$env:API = "https://expenses.thebarbellengineer.com/api"
$env:ADMIN_TOKEN = Get-Content worker\.admin-token
node scripts/admin.mjs requests
node scripts/admin.mjs approve <id>
```

## Still to check once the token is set

1. On the live site: send a request, approve it, and confirm the code fills
   in on Share.
2. Optional: get a notification when a request arrives.
   `npx wrangler secret put NOTIFY_URL` with an ntfy.sh topic URL. The
   notice says nothing about who asked.

## Hosting

This stays on Cloudflare, not Vercel: the sharing server is a Worker with
Durable Objects, and Vercel can't run those. Each shared tracker gets its
own room, created when an invite code is used, so new groups need no setup.
The repo stays public (MIT).
