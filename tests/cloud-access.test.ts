import { describe, expect, it } from 'vitest';
import { parseRecordLimit } from '../lib/cloud-access';
describe('record limit configuration', () => {
  it('accepts explicit limits or an intentionally unlimited account', () => {
    expect(parseRecordLimit('')).toBeNull();
    expect(parseRecordLimit('  ')).toBeNull();
    expect(parseRecordLimit('1000')).toBe(1000);
  });
  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '1000001'])(
    'rejects an invalid limit: %s',
    (value) => expect(() => parseRecordLimit(value)).toThrow(),
  );
});
