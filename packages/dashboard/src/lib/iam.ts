// Read-only client for the IAM admin API (`/iam/admin/*`), used by the console overview so the access
// plane is reported next to the delivery plane instead of living only behind its own nav section.
//
// Separate from `lib/api.ts` because it is a different origin path and a different service. It is
// deliberately read-only and deliberately quiet: `@fabrika/iam-ui` owns every access MUTATION and its
// own richer client, and an operator without `iam.admin` must still get a working overview. Callers
// use `iamSnapshot()`, which resolves to null on ANY failure (403, IAM down, network) rather than
// throwing — a missing access panel is correct there, a dead page is not.
//
// DTOs come from the runtime-neutral IAM contract; this client only aliases the names used by the overview.

import type { ApiKeyDto, AuditEventDto, ListResponse, PrincipalListItem, ShareLinkListItem } from '@fabrika/iam-contract'

const BASE = '/iam/admin'

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
			get<ListResponse<IamPrincipalDto>>('/principals?limit=200'),
			get<ListResponse<IamApiKeyDto>>('/api-keys'),
			get<ListResponse<IamShareLinkDto>>('/share-links'),
			get<ListResponse<IamAuditEventDto>>(`/audit?limit=${AUDIT_WINDOW}`),
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
