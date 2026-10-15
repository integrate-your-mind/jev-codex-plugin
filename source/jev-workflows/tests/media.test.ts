import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
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
    errorCode(() => validateImageAsset({format: 'png', data_base64: validPngBase64(256, 256)}), 'invalid_dimensions');
    errorCode(() => validateImageAsset({format: 'png', data_base64: validPngBase64(1569, 1569)}), 'invalid_dimensions');
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
