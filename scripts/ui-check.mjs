// Two real browsers, two profiles, one room. This is the check that the
// buttons are wired to the thing the unit tests prove works.
//
// Each device gets its own Chrome profile, because the whole point of the
// password is what happens on a machine that has never seen the room.
//
//   terminal one   npm run api
//   terminal two   npm start
//   terminal three npm run ui
//
// Drives Chrome over the DevTools protocol directly, so there is nothing
// to install.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SITE = process.env.SITE ?? 'http://localhost:5173';
const API = process.env.API ?? SITE + '/api';
const ADMIN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const PASSWORD = 'roommates 2026 rent';
const CHROME =
  process.env.CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let failures = 0;
const profiles = [];
const browsers = [];

function check(what, condition, extra) {
  console.log('  ' + (condition ? 'ok  ' : 'FAIL') + '  ' + what);
  if (!condition) {
    failures += 1;
    if (extra !== undefined) console.log('        got: ' + JSON.stringify(extra));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ chrome

async function launch(port) {
  const profile = await mkdtemp(join(tmpdir(), 'cet-'));
  profiles.push(profile);
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  browsers.push(child);

  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (response.ok) return { port, child };
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('Chrome did not start on port ' + port);
}

/** One page, driven by Runtime.evaluate. */
async function openPage(port, url) {
  const created = await fetch(
    'http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url),
    { method: 'PUT' }
  ).then((r) => r.json());

  const socket = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });

  function send(method, params) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  const page = {
    async eval(expression) {
      const result = await send('Runtime.evaluate', {
        expression: '(async () => { ' + expression + ' })()',
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          'page threw: ' +
            (result.exceptionDetails.exception?.description ||
              result.exceptionDetails.text)
        );
      }
      return result.result.value;
    },
    async goto(next) {
      await send('Page.navigate', { url: next });
      await page.ready();
    },
    async ready() {
      await page.waitFor('!!document.getElementById("open-share")', 'the app to load');
      // The app opens its socket and asks the server for the room; nothing
      // below should race that.
      await sleep(400);
    },
    async waitFor(expression, label, timeout = 8000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const value = await page.eval('return (' + expression + ');');
        if (value) return value;
        if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
        await sleep(100);
      }
    },
    close: () => socket.close(),
  };

  await page.ready();
  return page;
}

// ------------------------------------------------------------- the script

const SEED = `
  document.getElementById('open-people').click();
  for (const name of ['Ana', 'Bogdan']) {
    document.getElementById('person-name').value = name;
    document.getElementById('add-person-form').requestSubmit();
  }
  document.getElementById('people-dialog').close('cancel');
  const rows = [['2.400,00', 'rent'], ['89,50', 'gas']];
  for (const [amount, what] of rows) {
    document.getElementById('expense-amount').value = amount;
    document.getElementById('expense-description').value = what;
    document.getElementById('add-expense-form').requestSubmit();
  }
  return document.getElementById('expense-rows').children.length;
`;

async function main() {
  if (!(await fetch(SITE).then((r) => r.ok).catch(() => false))) {
    throw new Error('no site at ' + SITE + '. Run npm start and npm run api first.');
  }

  const minted = await fetch(API + '/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ADMIN },
    body: JSON.stringify({ count: 1, note: 'ui check' }),
  }).then((r) => r.json());
  const code = minted.codes[0];

  console.log('\ndevice one, on its own');
  const one = await launch(9333);
  const a = await openPage(one.port, SITE);

  const seeded = await a.eval(SEED);
  check('local months can be entered with no room in sight', seeded === 2, seeded);

  await a.eval("document.getElementById('open-share').click(); return true;");
  const sections = await a.eval(`
    const box = (id) => {
      const el = document.getElementById(id);
      return getComputedStyle(el).display !== 'none';
    };
    return { create: box('share-create'), join: box('share-join'), active: box('share-active') };
  `);
  check('the create panel shows and the in-a-room panel does not', sections.create && !sections.active, sections);

  console.log('\nmaking a room');
  await a.eval(`
    document.getElementById('invite-code').value = ${JSON.stringify(code)};
    document.getElementById('new-password').value = ${JSON.stringify(PASSWORD)};
    document.getElementById('new-password-again').value = ${JSON.stringify(PASSWORD)};
    document.getElementById('create-room-form').requestSubmit();
    return true;
  `);

  await a.waitFor("document.getElementById('recovery-dialog').open", 'the recovery key');
  const made = await a.eval(`
    return {
      key: document.getElementById('recovery-key').textContent.replace(/[^a-z2-7]/g, '').length,
      hash: location.hash,
      dot: !document.getElementById('sync-dot').hidden,
    };
  `);
  check('the recovery key is a whole 256-bit key', made.key === 52, made.key);
  check('the link picks up the room id', /^#s=[a-z2-7]{32}$/.test(made.hash), made.hash);
  check('the header says it is connected', made.dot);

  await a.eval("document.getElementById('recovery-dialog').close('cancel'); return true;");
  await a.waitFor("document.getElementById('sync-dot').dataset.status === 'online'", 'the socket');

  const fresh = await a.eval(`
    return {
      people: document.getElementById('people-count').textContent,
      rows: document.getElementById('expense-rows').children.length,
      localStillThere: (localStorage.getItem('common-expense-tracker/v1') || '').includes('rent'),
    };
  `);
  check('a new room starts empty rather than swallowing your months', fresh.people === '0' && fresh.rows === 0, fresh);
  check('and your own months are still on the device, untouched', fresh.localStillThere);

  console.log('\nmoving your own months in');
  await a.eval("document.getElementById('open-share').click(); return true;");
  await a.waitFor("getComputedStyle(document.getElementById('move-local')).display !== 'none'", 'the offer');
  await a.eval("document.getElementById('move-local').click(); return true;");
  await a.waitFor("document.getElementById('confirm-dialog').open", 'the confirm');
  await a.eval("document.getElementById('confirm-accept').click(); return true;");

  await a.waitFor("document.getElementById('expense-rows').children.length === 2", 'the months to land');
  const moved = await a.eval(`
    return {
      people: document.getElementById('people-count').textContent,
      total: document.getElementById('summary-total').textContent,
      link: document.getElementById('share-link').value,
    };
  `);
  check('the roster and the months are in the room now', moved.people === '2', moved);
  check('the link has no key in it', !moved.link.includes('&k='), moved.link);
  const link = moved.link;

  console.log('\ndevice two, which has never seen this room');
  const two = await launch(9334);
  const b = await openPage(two.port, link);

  await b.waitFor("document.getElementById('unlock-dialog').open", 'the lock screen');
  check('a link on a new device asks for the password', true);

  await b.eval(`
    document.getElementById('unlock-password').value = 'not the password';
    document.getElementById('unlock-form').requestSubmit();
    return true;
  `);
  await b.waitFor("document.getElementById('unlock-error').textContent.length > 0", 'the refusal');
  const refused = await b.eval(`
    return {
      error: document.getElementById('unlock-error').textContent,
      stillLocked: document.getElementById('unlock-dialog').open,
      rows: document.getElementById('expense-rows').children.length,
    };
  `);
  check('a wrong password gets nothing', refused.stillLocked && refused.rows === 0, refused);

  await b.eval(`
    document.getElementById('unlock-error').textContent = '';
    document.getElementById('unlock-password').value = ${JSON.stringify(PASSWORD)};
    document.getElementById('unlock-form').requestSubmit();
    return true;
  `);
  await b.waitFor("!document.getElementById('unlock-dialog').open", 'the unlock');
  await b.waitFor("document.getElementById('expense-rows').children.length === 2", 'the room');

  const opened = await b.eval(`
    return {
      people: document.getElementById('people-count').textContent,
      total: document.getElementById('summary-total').textContent,
      names: [...document.querySelectorAll('#expense-rows tr')].map((tr) => tr.children[1].textContent),
    };
  `);
  check('the right password brings the whole room across', opened.people === '2', opened);
  check('amounts survive the round trip through the server', opened.total === moved.total, opened.total);
  check('so do descriptions', opened.names.includes('rent') && opened.names.includes('gas'), opened.names);

  console.log('\nboth at once');
  await b.eval(`
    document.getElementById('expense-amount').value = '15,00';
    document.getElementById('expense-description').value = 'coffee';
    document.getElementById('add-expense-form').requestSubmit();
    return true;
  `);
  await a.waitFor(
    "[...document.querySelectorAll('#expense-rows tr')].some((tr) => tr.children[1].textContent === 'coffee')",
    'the live update on device one'
  );
  check('what device two adds appears on device one', true);

  await a.eval(`
    const row = [...document.querySelectorAll('#expense-rows tr')].find((tr) => tr.children[1].textContent === 'rent');
    [...row.querySelectorAll('.link-btn')].find((b) => b.textContent === 'Delete').click();
    return true;
  `);
  await a.waitFor("document.getElementById('confirm-dialog').open", 'the delete confirm');
  await a.eval("document.getElementById('confirm-accept').click(); return true;");

  await b.waitFor(
    "![...document.querySelectorAll('#expense-rows tr')].some((tr) => tr.children[1].textContent === 'rent')",
    'the delete on device two'
  );
  check('and a delete on device one clears it on device two', true);

  console.log('\nleaving');
  await a.eval("document.getElementById('open-share').click(); return true;");
  await a.eval("document.getElementById('leave-room').click(); return true;");
  await a.waitFor("document.getElementById('confirm-dialog').open", 'the leave confirm');
  await a.eval("document.getElementById('confirm-accept').click(); return true;");
  await a.waitFor("location.hash === ''", 'the fragment to go');

  const left = await a.eval(`
    return {
      rows: document.getElementById('expense-rows').children.length,
      names: [...document.querySelectorAll('#expense-rows tr')].map((tr) => tr.children[1].textContent),
      keys: Object.keys(localStorage).filter((k) => k.includes('/key/')).length,
      dot: document.getElementById('sync-dot').hidden,
    };
  `);
  check('leaving hands back your own months', left.names.includes('rent'), left);
  check('and forgets the key on this device', left.keys === 0, left.keys);
  check('and stops saying it is live', left.dot);

  const stillThere = await b.eval("return document.getElementById('expense-rows').children.length;");
  check('while the room itself carries on for the other person', stillThere === 2, stillThere);

  console.log('\nthe single file you hand out');
  // Fourteen modules flattened into one scope. If two of them ever declare
  // the same top-level name the build catches it, but only running the thing
  // catches the rest.
  const bundle = await openPage(two.port, SITE + '/common-expense-tracker.html');
  const ran = await bundle.eval(`
    ${SEED}
  `);
  check('the built bundle runs and takes an expense', ran === 2, ran);
  const inlined = await bundle.eval(`
    document.getElementById('open-share').click();
    await new Promise((r) => setTimeout(r, 200));
    return {
      external: document.querySelectorAll('script[src], link[rel=stylesheet]').length,
      // The space before the unit is non-breaking, so it never wraps off.
      total: document.getElementById('summary-total').textContent.replace(/\\s/g, ' '),
      shareOpens: document.getElementById('share-dialog').open,
    };
  `);
  check('with nothing left to fetch from outside itself', inlined.external === 0, inlined.external);
  check('and the settlement still adds up', inlined.total === '2.489,50 RON', inlined.total);
  check('and the share dialog still opens', inlined.shareOpens);

  a.close();
  b.close();
  bundle.close();
  console.log('\n' + (failures === 0 ? 'all good' : failures + ' failed'));
}

try {
  await main();
} catch (error) {
  console.error('\n' + error.message);
  failures += 1;
} finally {
  for (const child of browsers) child.kill();
  await sleep(300);
  for (const profile of profiles) await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}
