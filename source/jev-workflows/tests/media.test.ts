import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import jpeg from 'jpeg-js';
import {MEDIA_MAX_REQUEST_BYTES, MediaValidationError, boxAnswerSchema, validateImageAsset, validateMediaAssets, validateMediaRequest} from '../src/media.js';
import {validJpegBase64, validPngBase64} from './media-fixture.js';

function errorCode(action: () => unknown, code: string): void {
  assert.throws(action, error => error instanceof MediaValidationError && error.code === code);
}

describe('experimental media wire validation', () => {
  it('accepts bounded PNG and JPEG JSON assets', () => {
    assert.equal(validateImageAsset({format: 'png', data_base64: validPngBase64()}).format, 'png');
    assert.equal(validateImageAsset({format: 'jpeg', data_base64: validJpegBase64}).format, 'jpeg');
  });

  it('accepts a real JPEG at the documented maximum dimensions', () => {
    const width = 1568, height = 1568;
    const encoded = jpeg.encode({width, height, data: Buffer.alloc(width * height * 4, 255)}, 70).data;
    assert.equal(validateImageAsset({format: 'jpeg', data_base64: encoded.toString('base64')}).format, 'jpeg');
  });

  it('rejects malformed base64 and mismatched media', () => {
    errorCode(() => validateImageAsset({format: 'png', data_base64: '%%%'}), 'invalid_base64');
    errorCode(() => validateImageAsset({format: 'png', data_base64: validJpegBase64}), 'format_mismatch');
    errorCode(() => validateImageAsset({format: 'gif', data_base64: validPngBase64()}), 'invalid_asset');
    errorCode(() => validateImageAsset({format: 'png', data_base64: validPngBase64().slice(0, -8)}), 'format_mismatch');
    const badSegment = Buffer.from(validPngBase64(), 'base64');
    badSegment.writeUInt32BE(0x7fffffff, 33);
    errorCode(() => validateImageAsset({format: 'png', data_base64: badSegment.toString('base64')}), 'format_mismatch');
  });

  it('enforces documented image dimensions', () => {
    assert.equal(validateImageAsset({format: 'png', data_base64: validPngBase64(256, 307)}).format, 'png');
    errorCode(() => validateImageAsset({format: 'png', data_base64: validPngBase64(256, 256)}), 'invalid_dimensions');
    errorCode(() => validateImageAsset({format: 'png', data_base64: validPngBase64(1569, 1569)}), 'invalid_dimensions');
  });

  it('rejects CRC-correct but undecodable PNG IDAT data', () => {
    const data = Buffer.from(validPngBase64(), 'base64');
    const idatOffset = 33;
    const idatLength = data.readUInt32BE(idatOffset);
    data.fill(0, idatOffset + 8, idatOffset + 8 + idatLength);
    const type = data.subarray(idatOffset + 4, idatOffset + 8);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, data.subarray(idatOffset + 8, idatOffset + 8 + idatLength)])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    data.writeUInt32BE((crc ^ 0xffffffff) >>> 0, idatOffset + 8 + idatLength);
    errorCode(() => validateImageAsset({format: 'png', data_base64: data.toString('base64')}), 'format_mismatch');
  });

  it('bounds inflated PNG scanline output before the decoder', () => {
    const original = Buffer.from(validPngBase64(), 'base64');
    const idatOffset = 33;
    const oldLength = original.readUInt32BE(idatOffset);
    const oversizedBody = deflateSync(Buffer.alloc((280 * 4 + 1) * 280 + 1));
    const type = Buffer.from('IDAT', 'ascii');
    const chunk = Buffer.alloc(oversizedBody.length + 12);
    chunk.writeUInt32BE(oversizedBody.length, 0); type.copy(chunk, 4); oversizedBody.copy(chunk, 8);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, oversizedBody])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, oversizedBody.length + 8);
    const suffix = original.subarray(idatOffset + 12 + oldLength);
    errorCode(() => validateImageAsset({format: 'png', data_base64: Buffer.concat([original.subarray(0, idatOffset), chunk, suffix]).toString('base64')}), 'format_mismatch');
  });

  it('rejects APNG animation chunks', () => {
    const data = Buffer.from(validPngBase64(), 'base64');
    const type = Buffer.from('acTL', 'ascii');
    const body = Buffer.alloc(8);
    const chunk = Buffer.alloc(20);
    chunk.writeUInt32BE(body.length, 0); type.copy(chunk, 4); body.copy(chunk, 8);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, body])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 16);
    const apng = Buffer.concat([data.subarray(0, 33), chunk, data.subarray(33)]);
    errorCode(() => validateImageAsset({format: 'png', data_base64: apng.toString('base64')}), 'format_mismatch');
  });

  it('rejects a JPEG with headers but no decodable entropy stream', () => {
    const fake = '/9j/wAARCAEYARgDAREAAhEAAxEA/9oADAMBAAIAAwAAPwD/2Q==';
    errorCode(() => validateImageAsset({format: 'jpeg', data_base64: fake}), 'format_mismatch');
  });

  it('rejects unused and missing references without exposing content', () => {
    const assets = {photo: {format: 'png', data_base64: validPngBase64()}};
    errorCode(() => validateMediaAssets(assets, []), 'unused_asset');
    errorCode(() => validateMediaAssets(assets, ['missing']), 'unused_asset');
    errorCode(() => validateMediaAssets({}, ['missing']), 'missing_asset');
    assert.equal(validateMediaRequest({state: 'photo', assets}, ['photo']).assets.photo?.format, 'png');
  });

  it('validates Box answer bounds and nullable confidence', () => {
    assert.equal(boxAnswerSchema.safeParse({type: 'box', box: {top: 0, bottom: 1, left: 0.1, right: 0.9}, confidence: null}).success, true);
    assert.equal(boxAnswerSchema.parse({type: 'box', box: {top: 0, bottom: 1, left: 0.1, right: 0.9}}).confidence, null);
    assert.equal(boxAnswerSchema.safeParse({type: 'box', box: {top: 1, bottom: 0, left: 0, right: 1}, confidence: 0.5}).success, false);
  });

  it('bounds encoded size before allocating the decoded image', () => {
    const oversized = 'A'.repeat(Math.ceil(16 * 1024 * 1024 / 3) * 4 + 4);
    errorCode(() => validateImageAsset({format: 'png', data_base64: oversized}), 'image_too_large');
    assert.equal(MEDIA_MAX_REQUEST_BYTES, 32 * 1024 * 1024);
  });

  it('preserves a prototype-like asset reference as data', () => {
    const assets = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(assets, '__proto__', {value: {format: 'png', data_base64: validPngBase64()}, enumerable: true});
    assert.equal(validateMediaAssets(assets, ['__proto__'])['__proto__']?.format, 'png');
  });
});
