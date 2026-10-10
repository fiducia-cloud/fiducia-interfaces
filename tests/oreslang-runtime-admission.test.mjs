import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyUnadmittedOreslangInterfaces} from '../scripts/verify-oreslang-runtime-admission.mjs';

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'oreslang-iface-'));
  try { fn(root); } finally { rmSync(root, {recursive: true, force: true}); }
}
function directory(root, path) {mkdirSync(join(root,path), {recursive: true});}

test('current checkout contains no admitted Oreslang runtime projections', () => {
  assert.equal(verifyUnadmittedOreslangInterfaces(new URL('..', import.meta.url).pathname).status, 'non-admitted');
});

test('allow authored Oreslang source-only module contracts, not executable projections', () => {
  fixture(root => {
    directory(root, 'contracts/routes/v1');
    writeFileSync(join(root,'contracts/routes/v1/RouteContract.ores'), 'pub define contract Route as end\n');
    assert.equal(verifyUnadmittedOreslangInterfaces(root).status, 'non-admitted');
  });
});

test('reject undeclared native, JS, Wasm and hidden runtime entries', () => {
  for (const path of [
    'langs/oreslang', 'generated/ORESlangJS', 'runtime/graal/bridge.ores',
    'clients/rust/codegen.ores', 'adapters/wasm-oreslang', 'generated/.oreslang',
    'contracts/customer/runtime-adapters/oreslang.ores',
    'contracts/customer/generated/native.ores'
  ]) {
    fixture(root => {
      directory(root, path.endsWith('.ores') ? path.slice(0, path.lastIndexOf('/')) : path);
      if (path.endsWith('.ores')) writeFileSync(join(root,path), 'bad');
      assert.throws(() => verifyUnadmittedOreslangInterfaces(root), /not admitted/, path);
    });
  }
});

test('reject symlink escapes under generated/runtime roots', () => {
  fixture(root => {
    directory(root, 'generated');
    symlinkSync(root, join(root,'generated/outside'), 'dir');
    assert.throws(() => verifyUnadmittedOreslangInterfaces(root), /uninspected runtime-source symlink/);
  });
});

test('fail closed on excessively deep runtime trees', () => {
  fixture(root => {
    let path = 'runtime';
    directory(root,path);
    for (let i=0; i<22; i++) {
      path += '/nested' + i;
      directory(root,path);
    }
    assert.throws(() => verifyUnadmittedOreslangInterfaces(root), /depth limit/);
  });
});
