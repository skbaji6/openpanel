import { useAppParams } from '@/hooks/use-app-params';
import { useOrganizationAccess } from '@/hooks/use-organization-access';

export const NOT_ADMIN_NOTE = 'Only owners and admins can do this';

export function useMarketingRole(): { isAdmin: boolean } {
  const { organizationId } = useAppParams();
  const { isAdmin } = useOrganizationAccess(organizationId);
  return { isAdmin };
}
