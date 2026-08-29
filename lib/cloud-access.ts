export type AccessStatus = 'pending' | 'approved' | 'rejected' | 'suspended';
export type CloudAccess = {
  user_id: string;
  email: string;
  status: AccessStatus;
  is_admin: boolean;
  record_limit: number | null;
  // Only the admin list computes usage; periodic access checks stay lightweight.
  records_used?: number;
};
export function parseRecordLimit(value: string): number | null {
  if (!value.trim()) return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 1_000_000)
    throw new Error(
      'Use a whole number from 1 to 1,000,000, or leave blank for unlimited.',
    );
  return result;
}
