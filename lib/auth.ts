export const passwordRequirements =
  'Use at least 8 characters with an uppercase letter, a lowercase letter, and a number.';

export function validatePassword(password: string) {
  if (password.length < 8) return passwordRequirements;
  if (!/[A-Z]/.test(password)) return passwordRequirements;
  if (!/[a-z]/.test(password)) return passwordRequirements;
  if (!/\d/.test(password)) return passwordRequirements;
  return null;
}

export function normalizeDisplayName(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

export function authRedirectUrl(origin: string, path: string) {
  return new URL(path, origin).toString();
}
