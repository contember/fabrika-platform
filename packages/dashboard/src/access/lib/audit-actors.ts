import type { AuditEventDto, PrincipalListItem } from '@fabrika/iam-contract'

/** Who an audit row says acted, as the page shows it. */
export type AuditActor =
	| { kind: 'credential'; credentialId: string }
	| { kind: 'principal'; principalId: string; label: string; isUser: boolean }
	| { kind: 'label'; label: string }

/**
 * The principals a page of audit rows names by id alone. IAM writes no address into an audit row, so a user's label
 * there is its id; a service's is its key name already.
 */
export function actorIdsToResolve(events: readonly AuditEventDto[]): string[] {
	const ids = new Set<string>()
	for (const event of events) {
		if (event.credentialId === null && event.principalId !== null && event.principalLabel === event.principalId) {
			ids.add(event.principalId)
		}
	}
	return [...ids]
}

/** One lookup per distinct principal; one that cannot be read is left out and its rows keep the id. */
export async function resolveActors(
	principalIds: readonly string[],
	getPrincipal: (principalId: string) => Promise<PrincipalListItem>,
): Promise<Map<string, PrincipalListItem>> {
	const settled = await Promise.allSettled(principalIds.map(getPrincipal))
	const resolved = new Map<string, PrincipalListItem>()
	for (const result of settled) {
		if (result.status === 'fulfilled') resolved.set(result.value.id, result.value)
	}
	return resolved
}

export function auditActor(event: AuditEventDto, resolved: ReadonlyMap<string, PrincipalListItem>): AuditActor {
	if (event.credentialId !== null) return { kind: 'credential', credentialId: event.credentialId }
	if (event.principalId === null) return { kind: 'label', label: event.principalLabel }
	const principal = resolved.get(event.principalId)
	if (principal === undefined) return { kind: 'principal', principalId: event.principalId, label: event.principalLabel, isUser: false }
	return { kind: 'principal', principalId: principal.id, label: principal.label, isUser: principal.type === 'user' }
}
