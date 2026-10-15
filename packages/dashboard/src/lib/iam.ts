import { createRpcClient, RpcError, type RpcFetch } from '@fabrika/app'
import {
	type ApiKeyDto,
	type AuditEventDto,
	type IamAdministrationScope,
	iamAdministrationScope,
	type IamAdminRpcContract,
	type PrincipalListItem,
	type ShareLinkListItem,
} from '@fabrika/iam-contract'

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

export interface SignedInPrincipal {
	id: string
	label: string
}

/** Recent audit rows to read for the activity feed and the 24h decision count. */
const AUDIT_WINDOW = 100

/** For best-effort reads: an IAM refusal never triggers the Delivery login bounce. */
function quietIamClient(fetcher: RpcFetch) {
	return createRpcClient<IamAdminRpcContract>({ baseUrl: RPC_BASE, fetch: fetcher, bounceOnAuth: false })
}

/**
 * Read the access plane, or null when this operator can't or IAM is unreachable. IAM failures never
 * trigger the Delivery login bounce because the overview is deliberately best-effort.
 */
export async function iamSnapshot(fetcher: RpcFetch = fetch): Promise<IamSnapshot | null> {
	const api = quietIamClient(fetcher)
	try {
		const [principals, apiKeys, shareLinks, audit] = await Promise.all([
			api.principals.list({}),
			api.apiKeys.list({}),
			api.shareLinks.list({}),
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

/** IAM's `me` answers an administrator, of the installation or of applications' people, and refuses everyone else with 403. */
export type IamAdministration =
	| { status: 'administrator'; principal: SignedInPrincipal; scope: IamAdministrationScope }
	| { status: 'not-admin' }
	| { status: 'unknown' }

export async function iamAdministration(fetcher: RpcFetch = fetch): Promise<IamAdministration> {
	try {
		const me = await quietIamClient(fetcher).me()
		const scope = iamAdministrationScope(me.permissions)
		return scope === null ? { status: 'not-admin' } : { status: 'administrator', principal: { id: me.id, label: me.label }, scope }
	} catch (cause) {
		return cause instanceof RpcError && cause.httpStatus === 403 ? { status: 'not-admin' } : { status: 'unknown' }
	}
}

/** Whether IAM lists an application whose own people the caller administers; null when IAM does not answer. */
export async function administersPeople(fetcher: RpcFetch = fetch): Promise<boolean | null> {
	try {
		return (await quietIamClient(fetcher).appPeople.apps()).items.length > 0
	} catch {
		return null
	}
}
