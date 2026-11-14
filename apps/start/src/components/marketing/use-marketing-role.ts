import { useAppParams } from '@/hooks/use-app-params';
import { useOrganizationAccess } from '@/hooks/use-organization-access';

export function useMarketingRole(): { isAdmin: boolean } {
  const { organizationId } = useAppParams();
  const { isAdmin } = useOrganizationAccess(organizationId);
  return { isAdmin };
}
