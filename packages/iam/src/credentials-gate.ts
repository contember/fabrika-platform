// IAM's own key issuance to a machine caller meets the `credentials` mode Control mirrors for each application
// environment (ADR-0083 §8). This is authorization in IAM's own use cases, not an enforcement decision: the proxy stays
// the only one (ADR-0022).

import { parseAppEnvironmentId } from '@fabrika/auth-core'
import type { CredentialsMode } from '@fabrika/iam-contract'
import { PROVISIONING_ADMIN_ID } from './auth'
import type { Services } from './services'

/** One grant of a key: the IAM application it holds actions at (null: every application) and its scope there. */
export interface KeyReach {
	readonly app: string | null
	/** Null for a global grant at the application. */
	readonly scope: { readonly type: string; readonly value: string } | null
}

/** Who issues a key. A person in a signed-in session is their own evidence (ADR-0083 §6). */
export interface KeyIssuer {
	readonly id: string
	readonly person: boolean
}

/** Where one grant acts: one environment, every environment of one application, or every application. */
type Target = { readonly kind: 'env'; readonly id: string } | { readonly kind: 'app'; readonly app: string } | { readonly kind: 'all' }

const RANK: Readonly<Record<CredentialsMode, number>> = { off: 0, person: 1, refuse: 2 }

/**
 * What a machine caller does to what keys hold: issues a key, grants to a key (or edits its grant), or changes a role or
 * a named policy keys may hold. Each meets the mode the same way (ADR-0083 §8); only the refusal's wording differs.
 */
export type KeyChange = 'issue' | 'grant' | 'role'

/**
 * Why `issuer` may not make `change` reaching `reach`, or null when it may. A person and the provisioning key, the
 * operator's own credential that Control's workload, membership and connector keys and the bootstrap's first machine
 * caller are issued with, keep their rule. Every other caller meets the strictest mode among the environments the key
 * acts in; an environment IAM has no mode for, Control not having written one yet, reads as `person`.
 */
export async function credentialsRefusal(
	services: Services,
	issuer: KeyIssuer,
	reach: readonly KeyReach[],
	change: KeyChange = 'issue',
): Promise<string | null> {
	if (issuer.person || issuer.id === PROVISIONING_ADMIN_ID) return null
	const targets = reach.flatMap((grant) => {
		const target = targetOf(services, grant)
		return target === null ? [] : [target]
	})
	if (targets.length === 0) return null
	const { grantRequests, appSchema } = services.repositories
	const modes = await grantRequests.credentialsModes()
	const environments = new Set([...modes.keys(), ...(await appSchema.listKnownApps()).filter((id) => parseAppEnvironmentId(id) !== null)])
	let strictest: CredentialsMode = 'off'
	const at = new Set<string>()
	for (const target of targets) {
		const ids = environmentsOf(target, environments)
		// No environment known for the target: nothing says it is unprotected, so it reads as `person`.
		const judged = ids.length === 0 ? [{ id: describe(target), mode: 'person' as const }] : ids.map((id) => ({ id, mode: modes.get(id) ?? 'person' }))
		for (const { id, mode } of judged) {
			if (RANK[mode] > RANK[strictest]) {
				strictest = mode
				at.clear()
			}
			if (mode === strictest) at.add(id)
		}
	}
	if (strictest === 'off') return null
	const where = [...at].slice(0, 3).join(', ') + (at.size > 3 ? ` and ${at.size - 3} more` : '')
	const subject = SUBJECT[change]
	if (strictest === 'refuse') return `${subject} is refused to a machine caller at ${where}, whose \`credentials\` mode is \`refuse\``
	return change === 'issue'
		? `a key at ${where} takes a person's approval under its \`credentials\` mode, so a machine caller does not issue it here: `
			+ 'ask through Control, with `approvals.requests.create` of kind `iam.apiKeys.provision` or `fabrika control access request-key`'
		: `${subject} at ${where} takes a person under its \`credentials\` mode, so a machine caller does not make it here: a person makes it in the console`
}

const SUBJECT: Readonly<Record<KeyChange, string>> = {
	issue: 'a key',
	grant: 'a grant to a key',
	role: 'a change of a role or policy keys may hold',
}

/**
 * Where a grant acts. An application environment id is one environment; a grant at Control's console audience acts in
 * every environment of the application its `app` scope names, or of every application under any other scope; a
 * cross-app grant acts everywhere. IAM itself, Operations and any other plain id are not an application: installation
 * administration keeps its rule (ADR-0083 §9).
 */
function targetOf(services: Services, grant: KeyReach): Target | null {
	if (grant.app === null) return { kind: 'all' }
	if (parseAppEnvironmentId(grant.app) !== null) return { kind: 'env', id: grant.app }
	if (!services.config.adminAudiences.has(grant.app)) return null
	return grant.scope?.type === 'app' ? { kind: 'app', app: grant.scope.value } : { kind: 'all' }
}

function environmentsOf(target: Target, environments: ReadonlySet<string>): string[] {
	if (target.kind === 'env') return [target.id]
	if (target.kind === 'all') return [...environments]
	return [...environments].filter((id) => parseAppEnvironmentId(id)?.app === target.app)
}

function describe(target: Target): string {
	if (target.kind === 'env') return target.id
	return target.kind === 'app' ? `every environment of ${target.app}` : 'every application'
}
