// A job's and a webhook's authority (ADR-0022 "Principal kinds"): Control reconciles one `px_` key per workload from
// the approved snapshot and writes it as `FABRIKA_<KIND>_<NAME>_KEY`; IAM signs a token from it carrying the actions
// the reconciled schema declares. The framework mints a capability only for an action that token carries, so the
// authority comes from IAM, not from the application's own copy of the contract.

import {
	API_KEY_PREFIX,
	type ContractArtifact,
	type MintFromKeyResult,
	type PermissionEntry,
	TOKEN_REFRESH_SKEW_SECONDS,
	WORKLOAD_TOKEN_PATH,
	workloadKeyVariable,
} from '@fabrika/auth-core'
import type { TokenVerifier } from '@fabrika/jwks'
import { z } from 'zod/v4'

export type WorkloadKindOf = 'job' | 'webhook'

/** Where a workload exchanges its key for a token: IAM's public `WORKLOAD_TOKEN_PATH`, or a stand-in in a test. */
export interface WorkloadTokenSource {
	exchange(input: { readonly app: string; readonly key: string }): Promise<MintFromKeyResult>
}

/** The token exchange is a cold path, once per token lifetime; it is still bounded. */
const EXCHANGE_TIMEOUT_MS = 5_000

const mintResultSchema = z.union([
	z.strictObject({ ok: z.literal(true), token: z.string().min(1), expiresAt: z.number() }),
	z.strictObject({ ok: z.literal(false), reason: z.enum(['invalid_key', 'unknown_principal', 'disabled', 'token_too_large']) }),
])

/** IAM's token exchange at its public origin. An answer that is not IAM's decided outcome throws: "IAM could not be asked". */
export function issuerWorkloadTokens(
	issuer: string,
	fetcher: (request: Request) => Promise<Response> = (request) => fetch(request),
): WorkloadTokenSource {
	return {
		async exchange(input) {
			const response = await fetcher(
				new Request(new URL(WORKLOAD_TOKEN_PATH, issuer), {
					method: 'POST',
					headers: { authorization: `Bearer ${input.key}`, 'content-type': 'application/json' },
					body: JSON.stringify({ app: input.app }),
					redirect: 'manual',
					signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
				}),
			)
			const parsed = response.status === 200 ? mintResultSchema.safeParse(await response.json()) : null
			if (parsed === null || !parsed.success) {
				throw new Error(`IAM answered the workload token exchange with ${response.status}`)
			}
			return parsed.data
		},
	}
}

/** What the workload may do now, or why it may do nothing. */
export type WorkloadAuthority =
	/** `token` is the bearer IAM signed: what a job that issues links presents to IAM. */
	| { readonly ok: true; readonly perms: readonly PermissionEntry[]; readonly token: string }
	/** IAM refused the key, or signed a token that is not this workload's: a decided negative. */
	| { readonly ok: false; readonly reason: 'refused' }
	/** IAM or its keys could not be reached. */
	| { readonly ok: false; readonly reason: 'unavailable' }

export interface WorkloadCredentialOptions {
	readonly kind: WorkloadKindOf
	readonly name: string
	readonly key: string
	/** This application's IAM id, `<app>@<env>`: the token's audience. */
	readonly audience: string
	readonly source: WorkloadTokenSource
	readonly verifier: TokenVerifier
}

/** One workload's key, exchanged for a token when none is cached or the cached one is about to expire. */
export class WorkloadCredential {
	readonly #options: WorkloadCredentialOptions
	#cached: { readonly perms: readonly PermissionEntry[]; readonly token: string; readonly exp: number } | null = null
	#pending: Promise<WorkloadAuthority> | null = null

	constructor(options: WorkloadCredentialOptions) {
		this.#options = options
	}

	authority(): Promise<WorkloadAuthority> {
		const cached = this.#cached
		if (cached !== null && cached.exp - Math.floor(Date.now() / 1000) > TOKEN_REFRESH_SKEW_SECONDS) {
			return Promise.resolve({ ok: true, perms: cached.perms, token: cached.token })
		}
		this.#pending ??= this.#exchange().finally(() => {
			this.#pending = null
		})
		return this.#pending
	}

	async #exchange(): Promise<WorkloadAuthority> {
		const { kind, name, key, audience, source, verifier } = this.#options
		let minted: MintFromKeyResult
		try {
			minted = await source.exchange({ app: audience, key })
		} catch {
			// The error may quote IAM's URL or a transport detail; the line names the workload only.
			console.error(`fabrika: the ${kind} '${name}' could not exchange its key at IAM: iam_unavailable`)
			return { ok: false, reason: 'unavailable' }
		}
		if (!minted.ok) {
			console.error(`fabrika: IAM refused the key of the ${kind} '${name}': ${minted.reason}`)
			return { ok: false, reason: 'refused' }
		}
		const verified = await verifier.verify(minted.token, audience)
		if (!verified.ok) {
			return verified.reason === 'unavailable' ? { ok: false, reason: 'unavailable' } : { ok: false, reason: 'refused' }
		}
		const { claims } = verified
		if (claims.ptype !== kind || claims.workload !== name) {
			console.error(`fabrika: IAM signed a token for the key of the ${kind} '${name}' that is not this workload's`)
			return { ok: false, reason: 'refused' }
		}
		const perms = Object.freeze(claims.perms.map((entry) => Object.freeze({ ...entry })))
		this.#cached = { perms, token: minted.token, exp: claims.exp }
		return { ok: true, perms, token: minted.token }
	}
}

export interface WorkloadCredentialsInput {
	readonly artifact: ContractArtifact
	readonly framework: Readonly<Record<string, string>>
	readonly audience: string
	readonly source: WorkloadTokenSource | undefined
	readonly verifier: TokenVerifier
}

/** `job:<name>` and `webhook:<name>` → the workload's credential, or why one cannot start to `problems`. */
export function workloadCredentials(input: WorkloadCredentialsInput, problems: string[]): ReadonlyMap<string, WorkloadCredential> {
	const workloads: [WorkloadKindOf, string][] = [
		...Object.keys(input.artifact.jobs).map((name): [WorkloadKindOf, string] => ['job', name]),
		...Object.entries(input.artifact.mounts).flatMap((
			[name, mount],
		): [WorkloadKindOf, string][] => (mount.kind === 'webhook' ? [['webhook', name]] : [])),
	]
	const credentials = new Map<string, WorkloadCredential>()
	if (workloads.length > 0 && input.source === undefined) {
		problems.push('the contract declares jobs or webhooks, and the runtime adapter supplies no IAM token exchange for their keys')
	}
	for (const [kind, name] of workloads) {
		const variable = workloadKeyVariable(kind, name)
		const key = input.framework[variable]?.trim() ?? ''
		if (!key.startsWith(API_KEY_PREFIX) || key.length <= API_KEY_PREFIX.length) {
			problems.push(`${variable} is not set to a px_ key; Control writes the credential of the ${kind} '${name}' into every deploy`)
		} else if (input.source !== undefined) {
			credentials.set(
				`${kind}:${name}`,
				new WorkloadCredential({ kind, name, key, audience: input.audience, source: input.source, verifier: input.verifier }),
			)
		}
	}
	return credentials
}
