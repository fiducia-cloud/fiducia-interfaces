import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../contracts/transport-parity-canary/', import.meta.url);
const OPERATION_ID = 'evaluate_opportunity_admission';

async function json(name) {
  return JSON.parse(await readFile(new URL(name, ROOT), 'utf8'));
}

test('normalized Protobuf behavior binding resolves the real RPC and behavioral authority', async () => {
  const [projection, bindings, behavior] = await Promise.all([
    json('protobuf.projection.json'),
    json('protobuf.behavior-bindings.json'),
    json('behavior.contract.json'),
  ]);

  assert.equal(bindings.schema, 'ores.typespec-json-schema-validator.protobuf-behavior-bindings/v1');
  assert.equal(bindings.package, projection.package);
  assert.equal(bindings.bindings.length, 1);

  const binding = bindings.bindings[0];
  assert.equal(binding.operationId, OPERATION_ID);
  assert.ok(behavior.operations.some((operation) => operation.operationId === binding.operationId));

  const service = projection.services.find((item) => item.name === binding.service);
  assert.ok(service, `missing protobuf service ${binding.service}`);
  assert.ok(
    service.methods.some((method) => method.name === binding.method),
    `missing protobuf method ${binding.service}.${binding.method}`,
  );
});
