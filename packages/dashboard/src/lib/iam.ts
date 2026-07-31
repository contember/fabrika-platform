import { createRpcClient, type RpcFetch } from '@fabrika/app'
import type { ApiKeyDto, AuditEventDto, IamAdminRpcContract, PrincipalListItem, ShareLinkListItem } from '@fabrika/iam-contract'

const RPC_BASE = '/iam/admin/rpc'

export type IamPrincipalDto = PrincipalListItem
export type IamApiKeyDto = ApiKeyDto
export type IamShareLinkDto = ShareLinkListItem
export type IamAuditEventDto = AuditEventDto

/** Everything the overview reads from IAM, in one shot. */
export interface IamSnapshot {
	principals: IamPrincipalDto[]
	apiKeys: IamApiKeyDto[]
	shareLinks: IamShareLinkDto[]
	audit: IamAuditEventDto[]
}

/** Recent audit rows to read for the activity feed and the 24h decision count. */
const AUDIT_WINDOW = 100

/**
 * Read the access plane, or null when this operator can't or IAM is unreachable. IAM failures never
 * trigger the Delivery login bounce because the overview is deliberately best-effort.
 */
export async function iamSnapshot(fetcher: RpcFetch = fetch): Promise<IamSnapshot | null> {
	const api = createRpcClient<IamAdminRpcContract>({ baseUrl: RPC_BASE, fetch: fetcher, bounceOnAuth: false })
	try {
		const [principals, apiKeys, shareLinks, audit] = await Promise.all([
			api.principals.list({}),
			api.apiKeys.list(),
			api.shareLinks.list(),
			api.audit.list({ limit: AUDIT_WINDOW }),
		])
		return {
			principals: principals.items,
			apiKeys: apiKeys.items,
			shareLinks: shareLinks.items,
			audit: audit.items,
		}
	} catch {
		return null
	}
}
