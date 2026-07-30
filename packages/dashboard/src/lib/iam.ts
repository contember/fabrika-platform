// Read-only client for the IAM admin API (`/iam/admin/*`), used by the console overview so the access
// plane is reported next to the delivery plane instead of living only behind its own nav section.
//
// Separate from `lib/api.ts` because it is a different origin path and a different service. It is
// deliberately read-only and deliberately quiet: `@fabrika/iam-ui` owns every access MUTATION and its
// own richer client, and an operator without `iam.admin` must still get a working overview. Callers
// use `iamSnapshot()`, which resolves to null on ANY failure (403, IAM down, network) rather than
// throwing — a missing access panel is correct there, a dead page is not.
//
// The DTO shapes below are hand-mirrored from `@fabrika/iam`'s admin handlers, the same way
// `lib/api.ts` mirrors the control plane's. Only the fields this console reads are declared.

const BASE = '/iam/admin'

export type PrincipalType = 'user' | 'service'
export type PrincipalStatus = 'active' | 'invited' | 'disabled'

export interface IamPrincipalDto {
	id: string
	type: PrincipalType
	label: string
	email: string | null
	externalId: string | null
	status: PrincipalStatus
	createdAt: number
}

export interface IamApiKeyDto {
	principalId: string
	label: string
	status: PrincipalStatus
	grants: unknown[]
	createdAt: number
}

export interface IamShareLinkDto {
	id: string
	label: string
	createdAt: number
}

export interface IamAuditEventDto {
	id: string
	principalId: string
	principalLabel: string | null
	app: string
	action: string
	resourceType: string | null
	resourceId: string | null
	createdAt: number
}

interface Items<T> {
	items: T[]
}

/** Everything the overview reads from IAM, in one shot. */
export interface IamSnapshot {
	principals: IamPrincipalDto[]
	apiKeys: IamApiKeyDto[]
	shareLinks: IamShareLinkDto[]
	audit: IamAuditEventDto[]
}

async function get<T>(path: string): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		credentials: 'include',
		headers: { accept: 'application/json' },
	})
	if (!res.ok) throw new Error(`iam ${path} failed (${res.status})`)
	const text = await res.text()
	return JSON.parse(text.trim() === '' ? 'null' : text)
}

/** Recent audit rows to read for the activity feed and the 24h decision count. */
const AUDIT_WINDOW = 100

/**
 * Read the access plane, or null when this operator can't (no `iam.admin`) or IAM is unreachable. It
 * never redirects to login: a 401 here means the IAM half is gated, not that the console session is
 * gone — `lib/api.ts` already owns the session bounce for the control plane.
 */
export async function iamSnapshot(): Promise<IamSnapshot | null> {
	try {
		const [principals, apiKeys, shareLinks, audit] = await Promise.all([
			get<Items<IamPrincipalDto>>('/principals?limit=200'),
			get<Items<IamApiKeyDto>>('/api-keys'),
			get<Items<IamShareLinkDto>>('/share-links'),
			get<Items<IamAuditEventDto>>(`/audit?limit=${AUDIT_WINDOW}`),
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
