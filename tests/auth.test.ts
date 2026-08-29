import { describe, expect, it } from 'vitest';

import {
  authRedirectUrl,
  normalizeDisplayName,
  validatePassword,
} from '../lib/auth';

describe('authentication helpers', () => {
  it('requires a reasonably strong password', () => {
    expect(validatePassword('short')).toBeTruthy();
    expect(validatePassword('alllowercase1')).toBeTruthy();
    expect(validatePassword('ALLUPPERCASE1')).toBeTruthy();
    expect(validatePassword('NoNumbersHere')).toBeTruthy();
    expect(validatePassword('StrongPass1')).toBeNull();
  });

  it('normalizes display names', () => {
    expect(normalizeDisplayName('  Linh   Nguyen  ')).toBe('Linh Nguyen');
  });

  it('keeps authentication redirects on the selected origin', () => {
    expect(
      authRedirectUrl(
        'https://myplan.trungvanle.workers.dev',
        '/reset-password',
      ),
    ).toBe('https://myplan.trungvanle.workers.dev/reset-password');
  });
});
