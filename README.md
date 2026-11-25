<h1 align="center">Common Expense Tracker</h1>

<p align="center">
  <b>Split shared monthly costs and see who owes whom.</b><br>
  For flatmates, couples and anyone who shares bills: add each month's
  expenses and it works out the payments that square everyone up. No
  account. Optionally share one tracker live between two devices, encrypted
  so the server can't read it.
</p>

<p align="center">
  <a href="https://expenses.thebarbellengineer.com/"><b>Open the app</b></a> ·
  <a href="https://thebarbellengineer.com/projects/expense-tracker/">Project page</a> ·
  <a href="#get-started">Get started</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="LICENSE">MIT license</a>
</p>

<p align="center">
  <img src="https://thebarbellengineer.com/assets/img/expense-1600.webp" alt="A month of shared expenses with the balance bar and who owes whom" width="720">
</p>

## Why

Splitting a flat's bills usually ends in a spreadsheet nobody trusts, or an
app that wants everyone to sign up and holds your spending on its servers.
This tracker does one job: shared costs in, fair transfers out. It runs in
the browser with no account, keeps money as whole cents so the totals always
add up, and when two people want the same tracker on their phones, the
server in between only ever sees ciphertext.

## What it does

### Settle up

- **Who owes whom, worked out.** Add each month's shared costs and it shows
  the transfers that square everyone up, never more than one fewer than the
  number of people.
- **A balance bar** shows the month in one picture: who paid what, the
  fair-share line, and exactly the money that has to change hands.
- **Money that adds up.** Amounts are stored as whole cents, never floats.
  Splitting 10,00 three ways gives 3,34 / 3,33 / 3,33, and "42,50", "42.50"
  and "240.924,00" all parse correctly.

### Keep the months

- **One month at a time**, with one roster of people shared by every month.
  Removing someone checks every month they ever paid in, and asks whether to
  move or delete their expenses.
- **Amounts are in Romanian lei (RON).** Balances say "owes", "gets back"
  or "settled" in words, not by colour alone.
- **Export any set of months** as JSON or CSV, and import them back. An
  import replaces only the months the file names, and shows you exactly what
  it will replace first.

### Share it, privately

- **Share one tracker live.** One person makes it and sends the other a link
  and a password. A change on a phone shows up on the other laptop in well
  under a second, and edits made offline sync when the connection returns.
- **The server can't read it.** Every record is encrypted in the browser with
  a 256-bit key, wrapped by a key derived from your password. Neither leaves
  your device.
- **Invite only.** Making a shared tracker takes an invite code. No code?
  Ask for one from the Share dialog with just a name and a line about who you
  are.

### Take it anywhere

- **One file you can hand to someone.** `common-expense-tracker.html` is the
  whole app in about 220 KB. Save it anywhere and double-click it. Sharing is
  off in that copy, since a page opened from disk has no server to talk to.
- **Light and dark**, following your system until you choose.

## Get started

1. Open **https://expenses.thebarbellengineer.com/**.
2. Open **People** in the header and add everyone who shares the costs.
3. Add each expense with its amount, who paid, the date and a description.
4. At the end of the month, open the bottom line to see the balances and the
   payments that settle them.
5. To use one tracker from two devices, click **Share**, make a tracker and
   send the link and password to the other person. Keep the recovery key it
   shows you: a forgotten password cannot be recovered by anyone.

Your own months live in this browser's storage. Use **Data** to export a
backup now and then; it is the copy that survives a cleared browser.

## Sharing

The Share button turns your months into a tracker two people can both edit, live.
One person makes it, sends the other a link and a password, and from then on
adding an expense on a phone shows up on the other person's laptop in well under
a second.

Your own months and a shared tracker are separate piles of data in separate
places on the device. Making a tracker does not consume what you had, and
leaving hands it straight back. The one bridge between them is a button offered
only into a tracker that is still empty, because pushing your months into one
somebody else has already filled is a merge, and a merge is the thing this
design refuses to guess at.

### The server cannot read any of it

Every record is encrypted in the browser with a 256-bit key before it goes
anywhere. That key is itself encrypted with a key derived from the password by
PBKDF2-SHA256 at 600,000 iterations, and only that wrapped blob and a random
salt reach the server. Neither the password nor the key ever leaves the device.
A new device fetches the wrapped blob, asks for the password once, unwraps the
key, and keeps it.

Two keys instead of one is what makes changing the password cheap. The password
wraps one small blob, so changing it re-wraps that blob rather than
re-encrypting every expense you ever entered.

Be precise about what this does and does not cover. Encryption kills the
content, not the shape. Whoever runs the server can still see how many records
a tracker holds, how big each one is, when each was last written, and which
addresses connect and when. They cannot see the amounts, the names, the
descriptions, the dates, or even which month an expense belongs to: all of that
is inside the sealed blob. It is a real improvement over holding everything in
the clear, and it is not zero knowledge.

It also does not protect this device. The unlocked key and the decrypted cache
both sit in localStorage, because that is what typing the password once per
device means. Anyone who can use your unlocked browser profile can read the
tracker.

A forgotten password is unrecoverable. Not "unrecoverable until you email
someone", genuinely gone, since nobody holds a copy. Hence the recovery key
shown once when a tracker is made, and hence keeping export as the real backup.

### One op per record, never one document

The store emits an op for every change to shared data, and each op is an
absolute write to exactly one record. That is the reason two people can work at
the same time at all. Syncing the whole state as one document would mean
last-write-wins across the entire app: you add an expense at 19:02, she deletes
a duplicate at 19:02, and one of those writes replaces the other's whole
document silently.

Because puts are absolute rather than deltas, applying one twice does nothing
the second time. Delivery only has to be at-least-once, which is the easy kind
to build, and re-sending a batch after a connection dies mid-flight is free.

Within one record the newer timestamp wins. Deletes leave a tombstone so a
phone that was offline for a week cannot push a deleted expense back in.
Tombstones older than 90 days are swept up, because nothing is still carrying
an op that old.

Not everything syncs. Your theme, which month is on screen, and whether the
bottom line is folded stay on the device. Otherwise the other person switching
to July would yank your screen to July.

### Offline

Writes never wait on the network. A change is applied on screen at once and its
ops go into a queue that drains whenever a connection exists. The queue is
saved to disk, so closing a tab on the underground with three unsent expenses in
it loses nothing. The header dot says whether you are live, and the Share dialog
counts what is still waiting.

### Getting in

Making a tracker takes an invite code or the admin token only you have.
Someone without a code can ask for one from the Share dialog: they leave a
name and a line about who they are, and nothing else, no email and no
account. You approve or decline with `node scripts/admin.mjs`, and an
approved request's code fills itself in the next time they open Share in
that browser, so it never has to be sent by hand. See
[`worker/README.md`](worker/README.md) for deploying the server, minting
codes, and answering requests.

If you fork this to host it yourself, change the hostname in the `routes` entry
of [`worker/wrangler.toml`](worker/wrangler.toml) first. It points at the
maintainer's domain, which your Cloudflare account does not own, so the deploy
fails until you swap in one of yours.

The link carries only the tracker id, in the fragment after `#`. Browsers never
put that part in the HTTP request and strip it from the `Referer` header, so it
stays out of the web server's logs and out of anyone else's.

## Export and import

The Data button in the header opens one dialog for both. Tick the months you
want, pick JSON or CSV, and the browser saves the file. Nothing is uploaded
anywhere; the file is built in the page and handed to the download machinery,
which is why it works with no server behind it.

Your own months are kept in the localStorage of whichever browser opened the
page, so Chrome and Firefox on the same laptop hold two separate sets, and
clearing site data wipes one. Sharing is the way to have one set follow you
across devices. Export is the backup, and it is the only copy that survives a
forgotten password or a server that has gone away, which is why the button
stays in the footer either way.

JSON is the exact copy. It carries the whole people list, so someone who paid
for nothing that month still travels, and amounts stay integer bani:

```json
{
  "app": "common-expense-tracker",
  "people": ["Ana", "Dan"],
  "months": {
    "2026-07": {
      "expenses": [
        { "date": "2026-07-03", "description": "groceries", "paidBy": "Ana", "amount": 4250 }
      ]
    }
  }
}
```

CSV is one row per expense, columns `month,date,description,paid_by,amount_ron`,
with lei written `42.50`. A spreadsheet opens it directly.

Import replaces months, one at a time, and only the months the file names. A
file holding July and August cannot touch a June you already filled in. The
confirmation lists every month with what it replaces, names the people about to
join the roster, and names the months being left alone, so you can see what you
are agreeing to before anything is overwritten. There is no undo, which is why
the button turns red when the answer is not simply "add".

Both formats identify people by name rather than by id. A name survives being
edited in a spreadsheet where a uuid does not, the roster already forbids two
people sharing one, and matching is case-insensitive, so importing your own
export back does not clone the list.

The importer is more forgiving than the exporter. It reads semicolon and tab
files as well as commas, matches column headers by a handful of aliases in
English and Romanian rather than by position, takes `1.234,56` and `1234.56`
alike, falls back to the date when there is no month column, and counts the
rows it could not read instead of dropping them quietly. A raw copy of what the
app saves to localStorage imports as well.

## Not in this version

Custom splits, categories, recurring expenses, exchange rates, and marking a
settlement as paid. Section 4 of the PRD rules them out of the MVP.

There is no merge on import: a month in the file replaces the month here rather
than adding to it. Two people each logging half a month and combining the
result would need one of them to paste rows into the other's CSV first, or to
share a tracker instead, which is what sharing is for.

Sharing has no merge either, for the same reason. Moving your own months into a
shared tracker is offered only while that tracker is still empty.

## Development

Needs Node.js 22 or newer. The app itself has no dependencies; the sync
server is a Cloudflare Worker in `worker/`.

### Build the file you hand out

```
npm run build
```

Writes `common-expense-tracker.html` in the project root: the markup, the CSS,
and all fourteen modules folded into one file that runs from `file://` with no
server.

`scripts/build.mjs` strips the `import` and `export` keywords and concatenates
the modules in dependency order inside one IIFE, rather than keeping them as an
inline ES module, because some browsers refuse to run a module from a `file://`
page. Flattening puts every module in one scope, so the build fails if two of
them declare the same top-level name, and it fails if `src/app.js` reaches for
an element id that `index.html` does not have.

### Work on it

```
npm start          # the page on 5173
npm run api        # the sync Worker on 8787, only if you are touching sharing
```

Open http://localhost:5173, served from the unbundled `index.html` and `src/`
by `scripts/serve.mjs`. It also forwards `/api` to the Worker, WebSocket
upgrades included, so local development runs on one origin exactly like
production does. Edit, reload, and run `npm run build` when you want the single
file again.

### Test it

```
npm test           # 134 unit tests, no dependencies, no browser
npm run smoke      # two clients through the real protocol, needs npm run api
npm run ui         # two headless Chrome profiles through the real UI
```

The unit tests cover the settlement math, money parsing and formatting, month
arithmetic, the export and import formats, every store action including each
acceptance scenario from section 12 of the PRD, the encryption, the op merge
rules, the offline queue, and the server's conflict resolution driven directly
with a stand-in for Durable Object storage.

The other two need the Worker running. `smoke` drives two clients through the
wire protocol and checks, among other things, that the same bytes read with the
wrong key decrypt to nothing. `ui` launches two separate Chrome profiles as two
devices, makes a room in one, unlocks it in the other with the password, and
watches an edit cross between them.

### Host it yourself

`npm run deploy` builds the single file and deploys the Worker. Change the
hostname in the `routes` entry of [`worker/wrangler.toml`](worker/wrangler.toml)
first: it points at the maintainer's domain, which your Cloudflare account
does not own. [`worker/README.md`](worker/README.md) covers deploying,
minting invite codes and answering access requests.

## How it works

The amount field takes digits and separators only; anything else you type or
paste is dropped. It reads "42,50", "42.50", and "240.924,00" alike: the last
separator is the decimal point when one or two digits follow it, and a
thousands separator when exactly three do.

Every amount is an integer number of bani or cents. Nothing is ever stored or
added as a float, so 0,1 + 0,2 can never turn into 0,30000000000000004 in
someone's balance.

The month's total is split with `splitEvenly`, which hands the leftover minor
units one at a time to the first people in the list. Three people splitting
10,00 RON get 3,34 / 3,33 / 3,33, and the shares always add back up to the
total.

The balance bar in the bottom line is the same numbers as one picture. The
whole bar is the month's spending, and each person holds a slice as wide as
what they paid, overpayers on the left. The bold tick is the fair-share line.
With two people it lands dead centre. The colour boundary always ends up right
of that tick, and the hatched strip along the floor between the two is exactly
the money that has to change hands. `balanceBar()` in `src/settlement.js`
returns the geometry as fractions of the total, so the renderer never does any
arithmetic of its own.

Colours are one hue per person, handed out in roster order. The first two
are a periwinkle blue and a muted purple, both cool and neither carrying a
verdict: red and green read as "good" and "bad", and nobody in a shared flat
is the bad one. The part of a slice past the fair-share line is the same hue
at 30% over the track, hatched, so it reads as that person's money on loan
rather than as a colour of its own. The balance table underneath repeats
every colour as a labelled swatch, so identity never rests on hue.

Those two hues sit close together. Run through the separation check they
score a normal-vision delta E of 10.2 against a floor of 15, and 2.9 for
red-blind viewers, which means they are hard to tell apart when the two
slices touch. The direct labels on the bar and the swatches in the table are
what carry identity here.

Settlement pairs the largest debtor with the largest creditor, repeatedly. The
provably minimal set of transfers is an NP-hard problem, so this greedy pass
does not always find it, but it never emits more than `people - 1` transfers and
it lands on the obvious answer for the shapes a household actually hits. Tests
assert that applying every transfer leaves all balances at exactly zero.

## Files

```
common-expense-tracker.html   the built file, for anyone who just wants the app
index.html                    markup and the ten dialogs
styles.css                    light and dark palettes, responsive down to 360px
src/money.js                  parsing and formatting, minor-unit integers
src/settlement.js             pure math, no DOM, no storage
src/months.js                 "YYYY-MM" ids and the arithmetic on them
src/records.js                what a person and an expense are, and the limits
src/crypto.js                 keys, the password lock, sealing records
src/storage.js                the only file that knows about localStorage
src/ops.js                    one op per record, and folding one into a state
src/envelope.js               the line between plain ops and blobs on the wire
src/room-link.js              the id in the fragment, and rooms this device knows
src/sync.js                   the socket, the retries, the offline queue
src/transfer.js               reading and writing the JSON and CSV formats
src/state.js                  the store: roster, months, expenses, validation
src/sharing.js                joining, unlocking, leaving, being in a tracker
src/access.js                 asking for an invite code, and picking it up
src/app.js                    rendering and event wiring
worker/src/index.js           the API, and who is allowed to make a room
worker/src/room.js            one room: its records and its sockets
worker/src/registry.js        invite codes and the list of rooms
scripts/build.mjs             folds everything into the single file
scripts/serve.mjs             dev server, forwards /api to the Worker
scripts/admin.mjs             minting codes and rooms
scripts/smoke.mjs             two clients through the real protocol
scripts/ui-check.mjs          two headless Chromes through the real UI
test/                         node:test suites
```

Edit the files under `src/`, never `common-expense-tracker.html`. The build
overwrites it.

`src/settlement.js` imports nothing. `src/state.js` takes its storage as an
argument, so the tests hand it a plain object instead of a browser.

`src/records.js` and `src/ops.js` are imported by both the browser and the
Worker, and neither touches the DOM or a Cloudflare API. A record the client
will send is exactly a record the server will accept, because one file says
what a record is.

## License

[MIT](LICENSE). Built by Mario Molnar.
