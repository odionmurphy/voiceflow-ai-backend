import { query } from '../config/db';
import { BusinessMemberRole } from '../types';

/**
 * Confirms the given user is a member (owner or staff) of the given business.
 * Returns the business row plus the caller's role, or null if not found / not a member.
 */
export async function getBusinessAccess(
  businessId: string,
  userId: string
): Promise<{ business: any; role: BusinessMemberRole } | null> {
  const result = await query(
    `SELECT b.*, bm.role AS member_role
     FROM businesses b
     JOIN business_members bm ON bm.business_id = b.id
     WHERE b.id = $1 AND bm.user_id = $2`,
    [businessId, userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const { member_role, ...business } = row;
  return { business, role: member_role as BusinessMemberRole };
}

// Attaches `role` to a business row for consistent API response shaping.
export function withRole(business: any, role: BusinessMemberRole) {
  return { ...business, role };
}
