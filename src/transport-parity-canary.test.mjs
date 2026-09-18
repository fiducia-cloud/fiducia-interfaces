import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../contracts/transport-parity-canary/', import.meta.url);

async function text(name) {
  return readFile(new URL(name, ROOT), 'utf8');
}

async function json(name) {
  return JSON.parse(await text(name));
}

function modelFieldNames(source, modelName) {
  const escaped = modelName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = source.match(new RegExp(`model\\s+${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'u'));
  assert.ok(match, `missing TypeSpec model ${modelName}`);
  return [...match[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gmu)]
    .map((item) => item[1])
    .sort();
}

function payloadWithoutOperationId(operation) {
  const { operationId: _operationId, ...payload } = operation;
  return payload;
}

function evaluateAdmission(input) {
  return input.shown_to_alex
    && input.approved_by_alex
    && !input.legal_terms_accepted
    && !input.payment_obligation_accepted
    && !input.travel_commitment_accepted
    && !input.recording_publicity_consent_accepted
    && !input.relocation_commitment_accepted;
}

const REQUEST_FIELDS = [
  'approved_by_alex',
  'legal_terms_accepted',
  'payment_obligation_accepted',
  'recording_publicity_consent_accepted',
  'relocation_commitment_accepted',
  'shown_to_alex',
  'travel_commitment_accepted',
];
const RESPONSE_FIELDS = ['admissible', 'violations'];
const OPERATION_ID = 'evaluate_opportunity_admission';
const HTTP_PATH = '/v1/opportunity-admission/evaluate';

test('TypeSpec and authored JSON Schema keep independently authored snake_case model parity', async () => {
  const [typespec, schema] = await Promise.all([text('main.tsp'), json('authored.schema.json')]);

  assert.deepEqual(modelFieldNames(typespec, 'OpportunityAdmissionRequest'), REQUEST_FIELDS);
  assert.deepEqual(modelFieldNames(typespec, 'OpportunityAdmissionResponse'), RESPONSE_FIELDS);
  assert.deepEqual(Object.keys(schema.$defs.OpportunityAdmissionRequest.properties).sort(), REQUEST_FIELDS);
  assert.deepEqual(Object.keys(schema.$defs.OpportunityAdmissionResponse.properties).sort(), RESPONSE_FIELDS);

  for (const name of [...REQUEST_FIELDS, ...RESPONSE_FIELDS]) {
    assert.match(name, /^[a-z][a-z0-9_]*$/u);
  }
});

test('TypeSpec service, behavior authority and OpenAPI preserve one stable operation identity', async () => {
  const [service, behavior, openapi, projection] = await Promise.all([
    text('service.tsp'),
    json('behavior.contract.json'),
    json('openapi.json'),
    json('openapi.projection.json'),
  ]);

  assert.match(service, /op\s+evaluate_opportunity_admission\s*\(/u);
  assert.equal(behavior.operations.length, 1);
  assert.equal(behavior.operations[0].operationId, OPERATION_ID);

  const httpOperation = openapi.paths[HTTP_PATH].post;
  assert.equal(httpOperation.operationId, OPERATION_ID);
  assert.equal(projection.operations.length, 1);
  assert.equal(projection.operations[0].operationId, OPERATION_ID);
  assert.equal(projection.operations[0].method, 'POST');
  assert.equal(projection.operations[0].path, HTTP_PATH);

  const behavioralPayload = payloadWithoutOperationId(behavior.operations[0]);
  assert.deepEqual(httpOperation['x-ores-behavior'], behavioralPayload);
  assert.deepEqual(projection.operations[0].behavior, behavioralPayload);
});

test('OpenAPI request and response bindings point at the independently authored schema peer', async () => {
  const openapi = await json('openapi.json');
  const operation = openapi.paths[HTTP_PATH].post;
  assert.equal(
    operation.requestBody.content['application/json'].schema.$ref,
    './authored.schema.json#/$defs/OpportunityAdmissionRequest',
  );
  assert.equal(
    operation.responses['200'].content['application/json'].schema.$ref,
    './authored.schema.json#/$defs/OpportunityAdmissionResponse',
  );
});

test('Protobuf projection preserves field numbers, snake_case JSON names and RPC shape', async () => {
  const [schema, proto, projection] = await Promise.all([
    json('authored.schema.json'),
    text('service.proto'),
    json('protobuf.projection.json'),
  ]);

  assert.match(proto, /option\s+\(ores\.behavior\.v1\.operation_id\)\s*=\s*"evaluate_opportunity_admission";/u);
  assert.match(proto, /rpc\s+EvaluateOpportunityAdmission\(OpportunityAdmissionRequest\)/u);

  const messages = new Map(projection.messages.map((message) => [message.name, message]));
  const request = messages.get('OpportunityAdmissionRequest');
  const response = messages.get('OpportunityAdmissionResponse');
  assert.ok(request);
  assert.ok(response);
  assert.deepEqual(request.fields.map((field) => field.name).sort(), REQUEST_FIELDS);
  assert.deepEqual(response.fields.map((field) => field.name).sort(), RESPONSE_FIELDS);
  assert.deepEqual(Object.keys(schema.$defs.OpportunityAdmissionRequest.properties).sort(), REQUEST_FIELDS);

  for (const message of [request, response]) {
    const numbers = new Set();
    for (const field of message.fields) {
      assert.equal(field.jsonName, field.name, `${message.name}.${field.name} must retain snake_case JSON name`);
      assert.ok(!numbers.has(field.number), `${message.name} reuses protobuf field number ${field.number}`);
      numbers.add(field.number);
    }
  }

  const service = projection.services.find((item) => item.name === 'OpportunityAdmissionService');
  assert.ok(service);
  assert.deepEqual(service.methods, [{
    name: 'EvaluateOpportunityAdmission',
    inputType: 'OpportunityAdmissionRequest',
    outputType: 'OpportunityAdmissionResponse',
    clientStreaming: false,
    serverStreaming: false,
    errorModel: null,
  }]);
});

test('the admission predicate has exactly one admissible boolean combination', async () => {
  const behavior = await json('behavior.contract.json');
  const operation = behavior.operations[0];
  assert.equal(operation.kind, 'predicate');
  assert.equal(operation.language, 'cel');
  assert.equal(operation.executable, true);
  assert.equal(operation.pure, true);
  assert.equal(operation.deterministic, true);
  assert.equal(operation.idempotent, true);
  assert.deepEqual(operation.effects, []);

  const ordered = [
    'shown_to_alex',
    'approved_by_alex',
    'legal_terms_accepted',
    'payment_obligation_accepted',
    'travel_commitment_accepted',
    'recording_publicity_consent_accepted',
    'relocation_commitment_accepted',
  ];
  let admitted = 0;
  for (let mask = 0; mask < (1 << ordered.length); mask += 1) {
    const input = Object.fromEntries(ordered.map((name, index) => [name, Boolean(mask & (1 << index))]));
    if (evaluateAdmission(input)) admitted += 1;
  }
  assert.equal(admitted, 1);
  assert.equal(evaluateAdmission({
    shown_to_alex: true,
    approved_by_alex: true,
    legal_terms_accepted: false,
    payment_obligation_accepted: false,
    travel_commitment_accepted: false,
    recording_publicity_consent_accepted: false,
    relocation_commitment_accepted: false,
  }), true);
});
