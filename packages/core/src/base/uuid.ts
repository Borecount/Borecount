import { randomBytes } from 'node:crypto';

/** Canonical PostgreSQL UUID text; no version or variant restriction. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value);

/** UUIDv7 creation policy; references may use any canonical PostgreSQL UUID. */
export const isUuidV7 = (value: unknown): value is string =>
  isUuid(value) && value[14] === '7' && /^[89ab]$/i.test(value[19] ?? '');

/** RFC 9562 section 5.7: explicit Unix time and 74 cryptographically random bits. */
export const generateUuidV7 = (now: Date): string => {
  const timestamp = now.getTime();
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
    throw new RangeError('UUIDv7 timestamp must fit an unsigned 48-bit Unix millisecond value');
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(timestamp, 0, 6);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
