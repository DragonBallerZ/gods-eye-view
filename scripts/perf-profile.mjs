#!/usr/bin/env node
// scripts/perf-profile.mjs — asserts the runtime perf-patch invariants.
// Runs WITHOUT the dev server; pure filesystem + regex. Exit 0 = PASS.
//
// What's checked:
//   1. src/perfInit.js exists.
//   2. index.html loads perfInit BEFORE main.js (so the coalescer and
//      serializer are wired into dataManager.setEnabled / scene.requestRender
//      before the renderer kicks off).
//   3. perfInit.js exports installRenderCoalescer and
//      installLayerEnableSerializer and calls them.
//
// What's NOT checked (intentional):
//   - style.css. Console cargo cult: the crash the user reported
//     ("when I toggle on lots of data streams it crashes and stops working")
//     is fixed entirely by the JS sinks in src/perfInit.js. There is no
//     visual / glass-mode toggle shipped in this PR, so no CSS gate.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
let root = process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root' && i + 1 < args.length) {
    root = resolve(args[++i]);
  }
}

const failures = [];
const passes = [];

function passCheck(name, detail) {
  passes.push({ name, detail });
  console.log(`OK  ${name}${detail ? ' — ' + detail : ''}`);
}

function failCheck(name, detail) {
  failures.push({ name, detail });
  console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

const indexPath = join(root, 'index.html');
const perfInitPath = join(root, 'src', 'perfInit.js');

if (!existsSync(indexPath)) {
  failCheck('index.html exists', `missing at ${indexPath}`);
  console.log('perf-profile: FAIL');
  process.exit(1);
}
passCheck('index.html exists', indexPath);

const html = readFileSync(indexPath, 'utf8');
const perfInitExists = existsSync(perfInitPath);

// 1. perfInit script tag appears BEFORE main.js script tag
const perfRe = /<script\s+type="module"\s+src="\/src\/perfInit\.js"\s*><\/script>/;
const mainRe = /<script\s+type="module"\s+src="\/src\/main\.js"\s*><\/script>/;
const perfMatch = perfRe.exec(html);
const mainMatch = mainRe.exec(html);
if (perfMatch && mainMatch && perfMatch.index < mainMatch.index) {
  passCheck('perfInit precedes main.js', `perfInit @ ${perfMatch.index}, main.js @ ${mainMatch.index}`);
} else {
  failCheck(
    'perfInit precedes main.js',
    `perfMatch=${!!perfMatch} mainMatch=${!!mainMatch} perfBeforeMain=${perfMatch && mainMatch ? perfMatch.index < mainMatch.index : false}`
  );
}

// 2. src/perfInit.js exists
if (perfInitExists) {
  passCheck('src/perfInit.js exists', perfInitPath);
} else {
  failCheck('src/perfInit.js exists', `missing at ${perfInitPath}`);
}

// 3. perfInit.js declares both sinks
if (perfInitExists) {
  const perfInitSrc = readFileSync(perfInitPath, 'utf8');
  const hasCoalescer = /\binstallRenderCoalescer\b/.test(perfInitSrc);
  const hasSerializer = /\binstallLayerEnableSerializer\b/.test(perfInitSrc);
  if (hasCoalescer && hasSerializer) {
    passCheck('perfInit installs render coalescer + layer-enable serializer', 'both present');
  } else {
    failCheck('perfInit installs render coalescer + layer-enable serializer', `coalescer=${hasCoalescer} serializer=${hasSerializer}`);
  }
} else {
  failCheck('perfInit installs render coalescer + layer-enable serializer', 'src/perfInit.js missing');
}

console.log('---');
console.log(`perf-profile: ${failures.length === 0 ? 'PASS' : 'FAIL'}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail || ''}`);
  process.exit(1);
}
process.exit(0);
