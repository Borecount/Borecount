import { describe, expect, it } from 'bun:test';
import { generateUuidV7, isUuid, isUuidV7 } from './uuid';

describe('UUIDv7 creation', () => {
  it('encodes the supplied timestamp and generates distinct version/variant-correct IDs', () => {
    const now = new Date('2026-11-05T12:34:56.789Z');
    const ids = Array.from({ length: 100 }, () => generateUuidV7(now));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(isUuidV7(id)).toBe(true);
      expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(now.getTime());
    }
  });
  it('supports the timestamp boundaries and rejects out-of-range times', () => {
    for (const time of [0, 0xffffffffffff])
      expect(isUuidV7(generateUuidV7(new Date(time)))).toBe(true);
    for (const time of [-1, NaN, 0x1000000000000]) {
      expect(() => generateUuidV7(new Date(time))).toThrow(RangeError);
    }
  });
  it('requires v7 only for creation, while references accept any canonical UUID', () => {
    for (const id of [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-7000-0000-000000000001',
    ]) {
      expect(isUuid(id)).toBe(true);
      expect(isUuidV7(id)).toBe(false);
    }
    for (const value of [undefined, null, 7, '', 'not-a-uuid']) expect(isUuidV7(value)).toBe(false);
    expect(isUuidV7('019A5555-ABCD-7FFF-BFFF-0123456789AB')).toBe(true);
  });
});
