// Explicit transport/codec admission boundary. Supports JSON and raw bytes
// only; CBOR, MessagePack and Protobuf are declared but disabled until real
// codecs, generated DTOs and cross-language vectors land.
import { TextDecoder } from 'node:util';
import { Buffer } from 'node:buffer';

const MAX = 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const MIME = new Map([
  ['application/json', 'json'],
  ['application/msgpack', 'messagepack'],
  ['application/cbor', 'cbor'],
  ['application/x-protobuf', 'protobuf'],
  ['application/octet-stream', 'raw']
]);
const ACTIVE = new Set(['json', 'raw']);
function check(condition, message) {
  if (!condition) throw new TypeError('RPC codec refused: ' + message);
}
function bytes(data) {
  check(Buffer.isBuffer(data) || data instanceof Uint8Array, 'expected bytes');
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
function limit(n) {
  check(Number.isSafeInteger(n) && n >= 0 && n <= MAX, 'byte limit exceeded');
}
export function resolveContentType(value) {
  check(typeof value === 'string', 'missing content-type');
  const normalized = value.toLowerCase().trim();
  const [media, ...params] = normalized.split(';').map(s => s.trim());
  check(params.length === 0 || (media === 'application/json'
    && params.length === 1 && params[0] === 'charset=utf-8'),
    'unsupported content-type parameters');
  const codec = MIME.get(media);
  check(codec && ACTIVE.has(codec), 'unsupported or unimplemented content-type');
  return codec;
}
export function admitHttp({ contentType, accept, expectsBytes = false }) {
  const requestCodec = resolveContentType(contentType);
  check(typeof accept === 'string', 'missing Accept header');
  const responseCodec = resolveContentType(accept);
  // A single expectsBytes flag describes BOTH sides of this reference
  // exchange. Do not admit mixed JSON/raw negotiation with one ambiguous
  // flag; directional contracts require separately declared policies.
  check(typeof expectsBytes === 'boolean', 'invalid bytes contract');
  check((requestCodec === 'raw') === expectsBytes
    && (responseCodec === 'raw') === expectsBytes,
    'HTTP codec conflicts with explicit bytes contract');
  return Object.freeze({ requestCodec, responseCodec });
}
export function encodePayload(value, { codec = 'json', expectsBytes = false } = {}) {
  check(ACTIVE.has(codec), 'codec not implemented');
  if (codec === 'raw') {
    check(expectsBytes, 'raw codec requires explicit bytes contract');
    const output = bytes(value);
    limit(output.length);
    return Buffer.from(output);
  }
  check(!expectsBytes, 'bytes contract requires raw codec');
  check(!Buffer.isBuffer(value) && !(value instanceof Uint8Array),
    'implicit bytes-to-JSON conversion');
  let output;
  try {
    output = Buffer.from(JSON.stringify(value), 'utf8');
  } catch {
    throw new TypeError('RPC codec refused: invalid JSON value');
  }
  check(output.length > 0, 'invalid JSON value');
  limit(output.length);
  return output;
}
export function decodePayload(payload, {
  codec = 'json', expectsBytes = false, validate
} = {}) {
  check(ACTIVE.has(codec), 'codec not implemented');
  const raw = bytes(payload);
  limit(raw.length);
  if (codec === 'raw') {
    check(expectsBytes, 'raw codec requires explicit bytes contract');
    return Buffer.from(raw);
  }
  check(!expectsBytes, 'bytes contract requires raw codec');
  check(typeof validate === 'function', 'missing postdecode semantic validator');
  let result;
  try {
    result = JSON.parse(decoder.decode(raw));
  } catch {
    throw new TypeError('RPC codec refused: malformed JSON or UTF-8');
  }
  check(validate(result) === true, 'postdecode semantic validation failed');
  return result;
}
export function encodeTcpFrame(value, {
  codec = 'json', mode = 'length32', expectsBytes = false
} = {}) {
  const payload = encodePayload(value, { codec, expectsBytes });
  if (mode === 'ndjson') {
    check(codec === 'json', 'NDJSON is JSON-only');
    const output = Buffer.concat([payload, Buffer.from('\n')]);
    check(output.length <= MAX + 1, 'NDJSON frame too large');
    return output;
  }
  check(mode === 'length32', 'unsupported TCP framing');
  const output = Buffer.allocUnsafe(4 + payload.length);
  output.writeUInt32BE(payload.length, 0);
  payload.copy(output, 4);
  return output;
}
export function decodeTcpFrame(frame, {
  codec = 'json', mode = 'length32', expectsBytes = false, validate
} = {}) {
  const raw = bytes(frame);
  let payload;
  if (mode === 'ndjson') {
    check(codec === 'json', 'NDJSON is JSON-only');
    check(raw.length > 1 && raw.length <= MAX + 1
      && raw[raw.length - 1] === 10, 'missing/oversized NDJSON line');
    payload = raw.subarray(0, -1);
    check(!payload.includes(10) && !payload.includes(13), 'multiple NDJSON records');
  } else {
    check(mode === 'length32' && raw.length >= 4 && raw.length <= MAX + 4,
      'invalid or oversized length frame');
    const declared = raw.readUInt32BE(0);
    limit(declared);
    check(declared === raw.length - 4, 'truncated/trailing frame bytes');
    payload = raw.subarray(4);
  }
  return decodePayload(payload, { codec, expectsBytes, validate });
}
export function websocketBinaryPayload(frame, opts) {
  // This boundary intentionally forbids coercing byte frames to text.
  return decodePayload(frame, opts);
}
