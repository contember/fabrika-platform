// IAM's own key issuance to a machine caller meets the `credentials` mode Control mirrors for each application
// environment (ADR-0083 §8). This is authorization in IAM's own use cases, not an enforcement decision: the proxy stays
// the only one (ADR-0022).

import { appEnvironmentId, isAppEnvironmentPart, parseAppEnvironmentId } from '@fabrika/auth-core'
import type { CredentialsMode } from '@fabrika/iam-contract'
import { PROVISIONING_ADMIN_ID } from './auth'
import { principalStatus } from './db'
import { reachesCrossAppAuthority } from './resolve'
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

/** One environment a target acts in, or a description of where, with the mode it is judged by. */
interface Judged {
	readonly id: string
	readonly mode: CredentialsMode
}

/** The environment every application starts protected in (Control's `defaultProtected`), so it counts before it exists. */
const STARTS_PROTECTED = 'prod'

/**
 * What a machine caller does to what keys hold: issues a key, grants to a key (or edits its grant), changes a role or a
 * named policy keys may hold, re-enables a principal, or widens what a key's issuer covers. Each meets the mode the same
 * way (ADR-0083 §8); only the refusal's wording differs.
 */
export type KeyChange = 'issue' | 'grant' | 'role' | 'enable' | 'cover'

/**
 * Why `issuer` may not make `change` reaching `reach`, or null when it may. A person and the provisioning key, the
 * operator's own credential that Control's workload, membership and connector keys and the bootstrap's first machine
 * caller are issued with, keep their rule. Every other caller meets the strictest mode among the environments the key
 * acts in, an application's `prod` among them; an environment IAM has no mode for, Control not having written one yet,
 * and every application at once read as `person`.
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
		const known = environmentsOf(target, environments).map((id): Judged => ({ id, mode: modes.get(id) ?? 'person' }))
		// IAM cannot know an application registered later, whose `prod` starts protected: a key reaching every application
		// reads as `person`, and so does a target with no environment known, since nothing says it is unprotected.
		const unknown: Judged = { id: describe(target), mode: 'person' }
		const judged = target.kind === 'all' || known.length === 0 ? [...known, unknown] : known
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
	enable: 're-enabling a principal whose keys act',
	cover: 'a grant that widens the keys a principal issued',
}

/**
 * Which of an issuer's keys a change to the issuer widens (`issuerCoverage`, `issuerAuthority`): re-enabling it, or a
 * cross-app grant to it, every one; `iam.admin` at IAM, every key bound to another principal, which keeps its whole set
 * while its issuer holds it; a grant at one application, what they hold there.
 */
export type IssuerCover = { readonly kind: 'all' } | { readonly kind: 'admin' } | { readonly kind: 'app'; readonly app: string }

/**
 * Where the live keys `issuerId` issued for someone else act, as far as `cover` widens them. A key bound to another
 * principal acts where its holder's grants do, inside its own app binding; one whose holder is disabled, missing or a
 * workload holds nothing its issuer decides. An anonymous key acts where its inline grants do. A share link is issued
 * through its mount, which the mode does not judge, so it is not counted.
 */
export async function issuedKeysReach(services: Services, issuerId: string, cover: IssuerCover): Promise<KeyReach[]> {
	const { credentials, principals, workloads, grants } = services.repositories
	const reach: KeyReach[] = []
	for (const key of await credentials.listLiveIssuedForOthers(issuerId)) {
		const bound = key.app
		if (key.principal_id === null) {
			if (cover.kind === 'admin' || bound === null) continue
			for (const row of await credentials.getCredentialGrants(key.id)) reach.push({ app: bound, scope: scopeOf(row.scope_type, row.scope_value) })
			continue
		}
		const holder = await principals.getPrincipalById(key.principal_id)
		if (holder === null || principalStatus(holder) === 'disabled' || (await workloads.getByPrincipal(holder.id)) !== null) continue
		for (const grant of await grants.listGrants(holder.id)) {
			// A key bound to one app acts there alone, with the cross-app grants a platform audience sees.
			const app = bound === null
				? grant.app
				: grant.app === bound || (grant.app === null && reachesCrossAppAuthority(services.config, bound))
				? bound
				: undefined
			if (app !== undefined) reach.push({ app, scope: scopeOf(grant.scope_type, grant.scope_value) })
		}
	}
	if (cover.kind !== 'app') return reach
	// A grant at one application widens a key only there, a key that acts everywhere included.
	return reach.flatMap((entry) => entry.app === cover.app ? [entry] : entry.app === null ? [{ app: cover.app, scope: entry.scope }] : [])
}

function scopeOf(type: string | null, value: string | null): KeyReach['scope'] {
	return type === null || value === null ? null : { type, value }
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

/**
 * The environments a target acts in. Each application among them counts its `prod` as well, existing or not: a key keeps
 * acting in a `prod` created after it, which starts protected, and IAM reads one it holds no mode for as `person`.
 */
function environmentsOf(target: Target, environments: ReadonlySet<string>): string[] {
	if (target.kind === 'env') return [target.id]
	const listed = [...environments].filter((id) => target.kind === 'all' || parseAppEnvironmentId(id)?.app === target.app)
	const apps = target.kind === 'all' ? listed.flatMap((id) => parseAppEnvironmentId(id)?.app ?? []) : [target.app]
	const prods = apps.filter(isAppEnvironmentPart).map((app) => appEnvironmentId(app, STARTS_PROTECTED))
	return [...new Set([...listed, ...prods])]
}

function describe(target: Target): string {
	if (target.kind === 'env') return target.id
	return target.kind === 'app' ? `every environment of ${target.app}` : 'every application'
}
