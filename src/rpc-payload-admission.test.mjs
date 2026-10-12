import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  admitHttp, resolveContentType, encodePayload, decodePayload,
  encodeTcpFrame, decodeTcpFrame, websocketBinaryPayload
} from './rpc-payload-admission.mjs';

const valid = value => value !== null && typeof value === 'object'
  && typeof value.count === 'number' && value.count === 3;
test('contract default is implemented; future binary codecs cannot be advertised', async () => {
  const policy = JSON.parse(await readFile(
    new URL('../contracts/rpc-payload-codecs/v1/policy.json', import.meta.url), 'utf8'));
  assert.equal(policy.default_codec, 'json');
  assert.deepEqual(policy.codecs.filter(c => c.enabled).map(c => c.id), ['json', 'raw']);
  assert.equal(resolveContentType('application/json; charset=UTF-8'), 'json');
  for (const contentType of ['application/msgpack', 'application/cbor',
    'application/x-protobuf', '*/*', 'text/plain', 'application/json; q=0.5']) {
    assert.throws(() => resolveContentType(contentType));
  }
});
test('JSON TCP NDJSON and binary length framing are strictly bounded and validated', () => {
  const sample = { count: 3, name: 'safe' };
  const ndjson = encodeTcpFrame(sample, { mode: 'ndjson' });
  assert.equal(ndjson.toString('utf8').endsWith('\n'), true);
  assert.deepEqual(decodeTcpFrame(ndjson, { mode: 'ndjson', validate: valid }), sample);
  const framed = encodeTcpFrame(sample, {});
  assert.equal(framed.readUInt32BE(0), framed.length - 4);
  assert.deepEqual(decodeTcpFrame(framed, { validate: valid }), sample);
  assert.throws(() => decodeTcpFrame(framed), /semantic validator/);
  assert.throws(() => decodeTcpFrame(framed, { validate: () => false }), /semantic validation/);
  assert.throws(() => decodeTcpFrame(framed.subarray(0, -1), { validate: valid }));
  assert.throws(() => decodeTcpFrame(Buffer.concat([framed, Buffer.from([0])]), { validate: valid }));
  assert.throws(() => decodeTcpFrame(Buffer.from([255, 255, 255, 255]), { validate: valid }));
  assert.throws(() => decodeTcpFrame(Buffer.from([0, 0, 0, 2, 0xff, 0xfe]), { validate: valid }));
  assert.throws(() => decodeTcpFrame(Buffer.from('{"count":3}\n{"count":3}\n'), {
    mode: 'ndjson', validate: valid
  }));
  assert.throws(() => encodeTcpFrame(Buffer.from([0]), { codec: 'raw', mode: 'ndjson', expectsBytes: true }));
});
test('raw byte payload roundtrip preserves zero, invalid UTF8 and newline with explicit opt-in', () => {
  const input = Buffer.from([0, 255, 0, 10, 13, 128]);
  const frame = encodeTcpFrame(input, { codec: 'raw', expectsBytes: true });
  assert.deepEqual(decodeTcpFrame(frame, { codec: 'raw', expectsBytes: true }), input);
  assert.deepEqual(websocketBinaryPayload(input, { codec: 'raw', expectsBytes: true }), input);
  const decoded = websocketBinaryPayload(input, { codec: 'raw', expectsBytes: true });
  decoded[1] = 0; // return a copy, never expose caller buffer alias
  assert.equal(input[1], 255);
  assert.throws(() => encodePayload(input, { codec: 'raw' }));
  assert.throws(() => encodePayload(input));
  assert.throws(() => decodePayload(input, { codec: 'raw' }));
  assert.throws(() => encodePayload(input, { codec: 'cbor', expectsBytes: true }));
  assert.throws(() => admitHttp({
    contentType: 'application/octet-stream', accept: 'application/json'
  }));
  assert.deepEqual(admitHttp({
    contentType: 'application/octet-stream', accept: 'application/octet-stream',
    expectsBytes: true
  }), { requestCodec: 'raw', responseCodec: 'raw' });
  assert.throws(() => admitHttp({ contentType: 'application/json', accept: '*/*' }));
});
test('oversized frames reject before allocation or semantic acceptance', () => {
  const oversized = Buffer.alloc(1024 * 1024 + 1);
  assert.throws(() => encodePayload(oversized, { codec: 'raw', expectsBytes: true }));
  const malicious = Buffer.from([0x00, 0x10, 0x00, 0x01]);
  assert.throws(() => decodeTcpFrame(malicious, { validate: valid }));
});
