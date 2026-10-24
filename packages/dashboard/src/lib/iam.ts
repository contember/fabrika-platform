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
export interface SignedInPrincipal {
	id: string
	label: string
}

/** For best-effort reads: an IAM refusal never triggers the Delivery login bounce. */
function quietIamClient(fetcher: RpcFetch) {
	return createRpcClient<IamAdminRpcContract>({ baseUrl: RPC_BASE, fetch: fetcher, bounceOnAuth: false })
}

/** Reads of the admin API are audited too (`iam.admin.access`); on a feed of what changed they are noise. */
export const AUDIT_READ_ACTIONS: ReadonlySet<string> = new Set(['iam.admin.access'])

/** The most audit rows one call returns, and how many such pages the feed reads looking for changes. */
const AUDIT_PAGE = 200
const AUDIT_PAGES = 3

/**
 * The newest changes in the audit log, reads left out. IAM audits every admin read, the console's own
 * included, so the changes can sit a few hundred rows back; the read stops after `AUDIT_PAGES` pages. IAM cannot
 * leave the reads out itself yet (docs/backlog/191); once it can, this is one call.
 * Null when this operator can't read the log or IAM is unreachable.
 */
export async function recentAuditChanges(wanted: number, fetcher: RpcFetch = fetch): Promise<IamAuditEventDto[] | null> {
	try {
		return (await recentAuditChangePage(wanted, fetcher)).items
	} catch {
		return null
	}
}

/** A bounded scan is not an empty history. The overview shows when reads exhausted the scan budget. */
export async function recentAuditChangePage(wanted: number, fetcher: RpcFetch = fetch) {
	const api = quietIamClient(fetcher)
	const changes: IamAuditEventDto[] = []
	let before: string | undefined
	for (let page = 0; page < AUDIT_PAGES; page++) {
		const list = await api.audit.list({ limit: AUDIT_PAGE, ...(before === undefined ? {} : { before }) })
		changes.push(...list.items.filter((event) => !AUDIT_READ_ACTIONS.has(event.action)))
		if (changes.length >= wanted || list.nextCursor === null) return { items: changes.slice(0, wanted), limited: false }
		before = list.nextCursor
	}
	return { items: changes, limited: true }
}

/**
 * The installation's people, for the overview's count; `null` when IAM refuses or cannot be reached. Only
 * what the page shows is read: IAM audits every admin read (`iam.admin.access`), so a read the page throws away is
 * also a row that pushes the real changes further down the log.
 */
export async function iamPrincipals(fetcher: RpcFetch = fetch): Promise<IamPrincipalDto[] | null> {
	try {
		return (await quietIamClient(fetcher).principals.list({ type: 'user' })).items
	} catch {
		return null
	}
}

/**
 * The people whose name, email or external id holds `query`, as IAM searches them (`principals.list` with `q`), for the
 * command palette. Asked of IAM rather than filtered from a first page, so the person past the first fifty is found.
 * `null` when IAM refuses or cannot be reached.
 */
export async function findPeople(query: string, limit: number, fetcher: RpcFetch = fetch): Promise<IamPrincipalDto[] | null> {
	try {
		return (await quietIamClient(fetcher).principals.list({ type: 'user', q: query, limit })).items
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
