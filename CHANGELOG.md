# Changelog

What changed in Common Expense Tracker, newest first. The project had no
git history before it went on GitHub on 2026-10-16, so the entries up to
then come from the dated work log kept while it was built.

## 2026-10-16 — Open source, and it can sit inside another page

- The source is on GitHub under the MIT license.
- The page used to refuse to load inside any frame. It now allows
  thebarbellengineer.com to show it, so the portfolio can run it live,
  and still refuses every other site.

## 2026-09-26 — Live at expenses.thebarbellengineer.com

- The page and the sharing server run together on one Cloudflare Worker
  on their own domain, so shared trackers work without any setup.
- The admin token that mints invite codes lives in a Worker secret, never
  in the page or the repo.

## 2026-08-30 — Share one tracker live, end-to-end encrypted

- Share a tracker with a link and a password. Two people can edit it from
  different devices, and each change reaches the other one over a
  WebSocket in well under a second.
- Every record is encrypted in the browser (AES-GCM) with a key wrapped by
  your password (PBKDF2-SHA256, 600,000 iterations). The server stores
  only ciphertext and can't read a thing.
- Changes sync one record at a time, so two people editing different
  expenses never overwrite each other.
- Shared trackers are capped at 2 MB, and making a new one needs an
  invite code, so a stranger can't fill the server.
- 125 unit tests, a two-client protocol smoke test, and a UI check that
  drives two headless Chrome profiles as two devices.

## 2026-08-30 — Export, import and a single-file app

- Export any set of months as JSON or CSV. Importing replaces only the
  months in the file and leaves the rest alone.
- `npm run build` inlines everything into one standalone HTML file. Save
  it anywhere and double-click it, no install.

## 2026-08-30 — A balance bar, one list of people, and amounts that fit

- The bottom line shows a bar of what each person paid against the fair
  share, with the amount that changes hands drawn as a hatched band.
- People are one list for the whole tracker, managed from the header, and
  they carry over from month to month.
- Amounts of any size stay inside the summary panel: its type shrinks to
  fit instead of overflowing.
- RON only. The per-month EUR switch is gone.
- "240.924,00" now parses. The amount field accepts only digits and
  separators.
- Light and dark themes.

## 2026-08-30 — First version

- Add each month's shared costs, see who paid what, and get the transfers
  that square everyone up.
- Amounts are stored as whole cents, never floats, so splitting 10,00
  three ways gives 3,34 / 3,33 / 3,33.
- Everything stays in the browser. No account, no server.
