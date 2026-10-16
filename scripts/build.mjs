// Folds the app into a single HTML file you can email to someone.
//
// The modules are concatenated into one classic script rather than kept as
// ES modules, because an inline module is still a module: some browsers
// refuse to run one from a file:// page. A plain script inside an IIFE
// runs everywhere, including from a Downloads folder with no server.
//
// Flattening puts every module in one scope, so the build fails loudly if
// two of them declare the same top-level name.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = 'common-expense-tracker.html';

// Dependency order. money and months depend on nothing; app depends on
// everything.
const MODULES = [
  'src/money.js',
  'src/months.js',
  'src/records.js',
  'src/crypto.js',
  'src/storage.js',
  'src/ops.js',
  'src/envelope.js',
  'src/room-link.js',
  'src/sync.js',
  'src/settlement.js',
  'src/transfer.js',
  'src/state.js',
  'src/sharing.js',
  'src/app.js',
];

const IMPORT_LINE = /^import\s[^;]*;[ \t]*\r?\n/gm;
const EXPORT_KEYWORD = /^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm;
const DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

async function read(relative) {
  return readFile(join(root, relative), 'utf8');
}

function flatten(source, file) {
  if (/^export\s*[{*]/m.test(source) || /^export\s+default\b/m.test(source)) {
    throw new Error(file + ' uses an export form the build cannot flatten.');
  }
  return source.replace(IMPORT_LINE, '').replace(EXPORT_KEYWORD, '');
}

function declarationsIn(source) {
  return [...source.matchAll(DECLARATION)].map((m) => m[1]);
}

/**
 * Every id the script reaches for has to exist in the markup. A typo in
 * either file otherwise ships as a null at load time and takes the whole
 * app down, and there is no bundler here to notice.
 */
function checkIdsResolve(html, appSource) {
  const present = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...appSource.matchAll(/\$\('([^']+)'\)/g)]
    .map((m) => m[1])
    .filter((id) => !present.has(id));
  if (missing.length > 0) {
    throw new Error('index.html has no element with id: ' + [...new Set(missing)].join(', '));
  }
}

async function build() {
  const [html, css] = await Promise.all([read('index.html'), read('styles.css')]);
  checkIdsResolve(html, await read('src/app.js'));

  const seen = new Map();
  const parts = [];

  for (const file of MODULES) {
    const source = await read(file);

    for (const name of declarationsIn(source)) {
      if (seen.has(name)) {
        throw new Error(
          `${file} and ${seen.get(name)} both declare "${name}". ` +
            'Flattened into one scope that is a collision, so rename one of them.'
        );
      }
      seen.set(name, file);
    }

    parts.push('// ' + '='.repeat(66) + '\n// ' + file + '\n\n' + flatten(source).trim());
  }

  const script =
    "(function () {\n  'use strict';\n\n" +
    parts.join('\n\n').replace(/^/gm, '  ').replace(/^\s+$/gm, '') +
    '\n})();';

  let out = html;

  out = replaceOnce(
    out,
    /^[ \t]*<link rel="stylesheet" href="styles\.css" \/>\r?\n/m,
    '    <style>\n' + css.trim() + '\n    </style>\n'
  );

  out = replaceOnce(
    out,
    /^[ \t]*<script type="module" src="src\/app\.js"><\/script>\r?\n/m,
    '    <script>\n' + script + '\n    </script>\n'
  );

  // A file with no server has no relative anything left to fetch.
  const leftovers = [...out.matchAll(/(?:src|href)="(?!data:|#)([^"]+)"/g)].map((m) => m[1]);
  if (leftovers.length > 0) {
    throw new Error('These still point outside the file: ' + leftovers.join(', '));
  }

  await writeFile(join(root, OUT), out, 'utf8');

  const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(0);
  console.log(`${OUT} written, ${kb} KB, ${MODULES.length} modules inlined.`);
}

function replaceOnce(text, pattern, replacement) {
  if (!pattern.test(text)) {
    throw new Error('index.html no longer matches ' + pattern + ', so the build cannot patch it.');
  }
  return text.replace(pattern, () => replacement);
}

build().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
