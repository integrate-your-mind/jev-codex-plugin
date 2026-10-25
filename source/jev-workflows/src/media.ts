import {z} from 'zod';
import {inflateSync} from 'node:zlib';
import {PNG} from 'pngjs';
import jpeg from 'jpeg-js';

export const MEDIA_MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MEDIA_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const MEDIA_MIN_DIMENSION = 256;
export const MEDIA_MAX_DIMENSION = 1568;
export const MEDIA_MIN_PIXELS = 78_400;
export const MEDIA_MAX_PIXELS = 2_458_624;

const formatSchema = z.enum(['png', 'jpg', 'jpeg']);
export const imageAssetSchema = z.strictObject({
  type: z.literal('image').optional(),
  format: formatSchema,
  data_base64: z.string(),
});
export type ImageAsset = z.output<typeof imageAssetSchema>;

const contentSchema = z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(z.unknown()), z.record(z.string(), z.unknown()),
]);
export const boxQuestionSchema = z.strictObject({
  type: z.literal('box'),
  instructions: contentSchema,
});
export type BoxQuestion = z.output<typeof boxQuestionSchema>;

export const boxCoordinatesSchema = z.strictObject({
  top: z.number().finite().min(0).max(1),
  bottom: z.number().finite().min(0).max(1),
  left: z.number().finite().min(0).max(1),
  right: z.number().finite().min(0).max(1),
}).superRefine((value, context) => {
  if (value.left >= value.right) context.addIssue({code: 'custom', message: 'box left must be less than right'});
  if (value.top >= value.bottom) context.addIssue({code: 'custom', message: 'box top must be less than bottom'});
});

export const boxAnswerSchema = z.strictObject({
  type: z.literal('box'),
  box: boxCoordinatesSchema,
  confidence: z.number().finite().min(0).max(1).nullable().optional().default(null),
});
export type BoxAnswer = z.output<typeof boxAnswerSchema>;

export type MediaErrorCode =
  | 'invalid_asset'
  | 'invalid_base64'
  | 'format_mismatch'
  | 'unsupported_format'
  | 'image_too_large'
  | 'invalid_dimensions'
  | 'request_too_large'
  | 'unused_asset'
  | 'missing_asset';

export class MediaValidationError extends Error {
  constructor(public readonly code: MediaErrorCode) {
    super(code);
    this.name = 'MediaValidationError';
  }
}

function fail(code: MediaErrorCode): never {
  throw new MediaValidationError(code);
}

function decodeBase64(value: string): Buffer {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('invalid_base64');
  if (value.length > Math.ceil(MEDIA_MAX_IMAGE_BYTES / 3) * 4) fail('image_too_large');
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length || decoded.toString('base64') !== value) fail('invalid_base64');
  return decoded;
}

function dimensions(data: Buffer, format: ImageAsset['format']): {width: number; height: number} {
  const png = data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (format === 'png') {
    if (!png) fail('format_mismatch');
    let offset = 8;
    let width: number | undefined;
    let height: number | undefined;
    let bitDepth: number | undefined;
    let colorType: number | undefined;
    let interlace: number | undefined;
    let idat = false;
    const idatParts: Buffer[] = [];
    let iend = false;
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > data.length) fail('format_mismatch');
      const type = data.toString('ascii', offset + 4, offset + 8);
      const body = data.subarray(offset + 8, offset + 8 + length);
      const crc = data.readUInt32BE(offset + 8 + length);
      if (crc32(Buffer.from(type + body.toString('binary'), 'binary')) !== crc) fail('format_mismatch');
      if (type === 'IHDR') {
        if (length !== 13 || width !== undefined) fail('format_mismatch');
        width = body.readUInt32BE(0);
        height = body.readUInt32BE(4);
        bitDepth = body[8];
        colorType = body[9];
        interlace = body[12];
        if (body[10] !== 0 || body[11] !== 0 || ![0, 1].includes(interlace!)) fail('format_mismatch');
      } else if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') fail('format_mismatch');
      else if (type === 'IDAT') { idat = true; idatParts.push(body); }
      else if (type === 'IEND') {
        if (length !== 0) fail('format_mismatch');
        iend = true;
        if (end !== data.length) fail('format_mismatch');
        break;
      }
      offset = end;
    }
    if (width === undefined || height === undefined || bitDepth === undefined || colorType === undefined || interlace === undefined || !idat || !iend) fail('format_mismatch');
    const legalDepths: Record<number, readonly number[]> = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
    if (!legalDepths[colorType]?.includes(bitDepth)) fail('format_mismatch');
    validateDimensions(width, height);
    try {
      const channels: Record<number, number> = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};
      const bitsPerPixel = channels[colorType]! * bitDepth;
      const passSizes = interlace === 0
        ? [{width, height}]
        : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]].map(([x, y, dx, dy]) => ({
          width: width > x! ? Math.ceil((width - x!) / dx!) : 0,
          height: height > y! ? Math.ceil((height - y!) / dy!) : 0,
        }));
      const expectedInflated = passSizes.reduce((total, pass) => total + (pass.width ? Math.ceil(pass.width * bitsPerPixel / 8) + 1 : 0) * pass.height, 0);
      const inflated = inflateSync(Buffer.concat(idatParts), {maxOutputLength: expectedInflated});
      if (inflated.length !== expectedInflated) fail('format_mismatch');
      PNG.sync.read(data, {checkCRC: true});
    } catch {
      fail('format_mismatch');
    }
    return {width, height};
  }
  // Parse the JPEG header first so decoder allocation is bounded by provider dimensions.
  if (png || data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) fail('format_mismatch');
  let found: {width: number; height: number} | undefined;
  let sawScan = false;
  for (let offset = 2; offset + 1 < data.length;) {
    while (offset < data.length && data[offset] === 0xff) offset++;
    if (offset >= data.length) break;
    const marker = data[offset++]!;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) { sawScan = true; break; }
    if (offset + 2 > data.length) fail('format_mismatch');
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) fail('format_mismatch');
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (length < 7) fail('format_mismatch');
      found = {height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5)};
    }
    offset += length;
  }
  if (!found || !sawScan || data.length < 2 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) fail('format_mismatch');
  validateDimensions(found.width, found.height);
  try {
    const decoded = jpeg.decode(data, {
      maxResolutionInMP: MEDIA_MAX_PIXELS / 1_000_000,
      // Bound decoder allocations while allowing maximum-size RGB and CMYK JPEGs.
      maxMemoryUsageInMB: 128,
      tolerantDecoding: false,
    });
    if (decoded.width !== found.width || decoded.height !== found.height) fail('format_mismatch');
  } catch {
    fail('format_mismatch');
  }
  return found;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < MEDIA_MIN_DIMENSION || height < MEDIA_MIN_DIMENSION ||
      width > MEDIA_MAX_DIMENSION || height > MEDIA_MAX_DIMENSION || width * height < MEDIA_MIN_PIXELS || width * height > MEDIA_MAX_PIXELS) {
    fail('invalid_dimensions');
  }
}

export function validateImageAsset(raw: unknown): ImageAsset {
  const parsed = imageAssetSchema.safeParse(raw);
  if (!parsed.success) fail('invalid_asset');
  const data = decodeBase64(parsed.data.data_base64);
  if (data.length > MEDIA_MAX_IMAGE_BYTES) fail('image_too_large');
  const {width, height} = dimensions(data, parsed.data.format);
  validateDimensions(width, height);
  return parsed.data;
}

export function validateMediaAssets(
  assets: Record<string, unknown>,
  referencedAssets?: readonly string[],
): Record<string, ImageAsset> {
  const validated: Record<string, ImageAsset> = Object.create(null) as Record<string, ImageAsset>;
  for (const [reference, raw] of Object.entries(assets)) {
    if (!reference.trim()) fail('invalid_asset');
    const asset = validateImageAsset(raw);
    validated[reference] = asset;
  }
  let totalBytes = 0;
  if (referencedAssets) {
    const names = new Set(referencedAssets);
    for (const reference of Object.keys(validated)) if (!names.has(reference)) fail('unused_asset');
    for (const reference of names) if (!Object.hasOwn(validated, reference)) fail('missing_asset');
    for (const reference of referencedAssets) totalBytes += Buffer.byteLength(validated[reference]!.data_base64, 'base64');
  } else {
    for (const asset of Object.values(validated)) totalBytes += Buffer.byteLength(asset.data_base64, 'base64');
  }
  if (totalBytes > MEDIA_MAX_REQUEST_BYTES) fail('request_too_large');
  return validated;
}

export function validateMediaRequest(request: {assets?: Record<string, unknown>; state?: unknown; questions?: unknown}, referencedAssets?: readonly string[]) {
  const assets = validateMediaAssets(request.assets ?? {}, referencedAssets);
  const bodyBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
  if (bodyBytes > MEDIA_MAX_REQUEST_BYTES) fail('request_too_large');
  return {assets, request};
}
