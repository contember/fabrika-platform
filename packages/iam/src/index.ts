import type {
	AuditInput,
	ExchangeAuthCodeInput,
	ExchangeAuthCodeResult,
	IamHandoffRpc,
	IamRpc,
	IssueJwtInput,
	IssueJwtResult,
	IssueKeyInput,
	IssueKeyResult,
	Jwks,
	ListPrincipalsInput,
	ListPrincipalsResult,
	MintFromKeyInput,
	MintFromKeyResult,
	MintTokenInput,
	MintTokenResult,
	RevokeKeyInput,
	RevokeKeyResult,
} from '@fabrika/auth-core'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { createIamApp } from './app'
import { runIamMaintenance } from './cron'
import { createIamRepositories } from './db'
import type { Env } from './env'
import { createIamRpc } from './rpc'

/**
 * The IAM Worker — the CLOUDFLARE entrypoint, and nothing more. A single `WorkerEntrypoint` whose
 * default export carries BOTH the RPC methods (apps reach them over the `env.IAM` service binding,
 * which does not traverse any public edge) and `fetch()` (`/admin/*` + `/auth/*`).
 *
 * There is no logic here. Every method delegates: the RPC surface to `createIamRpc` (src/rpc.ts),
 * `fetch` to `workerApp`, `scheduled` to `runIamMaintenance` (src/cron.ts) — the same
 * three functions the Bun entrypoint (src/node/server.ts) calls. This file's whole job is to bind
 * `cloudflare:workers` to them, and it is the ONLY file in the package that imports it: the Bun
 * process must never load this module, and it must never load `bun:*`/`node:*`.
 * `src/__tests__/entrypoint-isolation.test.ts` walks both import graphs and enforces exactly that.
 *
 * `this.ctx` (an `ExecutionContext`) satisfies `RequestContext` structurally, so it is passed
 * straight through with no adapter.
 */

/**
 * The one composition fact this root supplies: which header carries the client address.
 *
 * IAM's Worker holds its OWN Custom Domain — it is not behind a proxy Worker — so the hop in front of
 * it is Cloudflare's edge, which writes `CF-Connecting-IP` on every request and replaces a caller's.
 * That makes it the only address here a limiter may key on; see `src/client-address.ts` for why IAM
 * refuses to pick one itself.
 */
const workerApp = createIamApp({ clientAddressHeader: 'CF-Connecting-IP' })
export interface WorkerBindings
	extends Omit<Env, 'DB' | 'REPOSITORIES' | 'FABRIKA_IAM_SIGNING_KEYS' | 'FABRIKA_IAM_PROVISIONING_KEY' | 'EMAIL_API_KEY'>
{
	DB: D1Database
	FABRIKA_IAM_SIGNING_KEYS?: string
	FABRIKA_IAM_PROVISIONING_KEY?: string
	FABRIKA_EMAIL_RESEND_API_KEY?: string
}

/** Present native Worker bindings as the runtime-neutral IAM environment. */
export function iamEnv(bindings: WorkerBindings): Env {
	return {
		...bindings,
		DB: bindings.DB,
		REPOSITORIES: createIamRepositories(bindings.DB),
		FABRIKA_IAM_SIGNING_KEYS: bindings.FABRIKA_IAM_SIGNING_KEYS ?? '',
		FABRIKA_IAM_PROVISIONING_KEY: bindings.FABRIKA_IAM_PROVISIONING_KEY ?? '',
		EMAIL_API_KEY: bindings.FABRIKA_EMAIL_RESEND_API_KEY ?? '',
	}
}

export class Propustka extends WorkerEntrypoint<WorkerBindings> implements IamRpc, IamHandoffRpc {
	private get iam(): Env {
		return iamEnv(this.env)
	}

	private get rpc(): IamRpc & IamHandoffRpc {
		return createIamRpc(this.iam, this.ctx)
	}

	mintToken(input: MintTokenInput): Promise<MintTokenResult> {
		return this.rpc.mintToken(input)
	}

	mintFromKey(input: MintFromKeyInput): Promise<MintFromKeyResult> {
		return this.rpc.mintFromKey(input)
	}

	/**
	 * Cross-host handoff redemption (ADR-0021). Present on the binding, absent from `IamRpc`: the
	 * proxy Worker narrows this entrypoint structurally, so it reaches this method while an SDK
	 * consumer typed against `IamRpc` never sees it.
	 */
	exchangeAuthCode(input: ExchangeAuthCodeInput): Promise<ExchangeAuthCodeResult> {
		return this.rpc.exchangeAuthCode(input)
	}

	getJwks(): Promise<Jwks> {
		return this.rpc.getJwks()
	}

	audit(event: AuditInput): Promise<void> {
		return this.rpc.audit(event)
	}

	listPrincipals(input: ListPrincipalsInput): Promise<ListPrincipalsResult> {
		return this.rpc.listPrincipals(input)
	}

	revokeKey(input: RevokeKeyInput): Promise<RevokeKeyResult> {
		return this.rpc.revokeKey(input)
	}

	issueKey(input: IssueKeyInput): Promise<IssueKeyResult> {
		return this.rpc.issueKey(input)
	}

	issueJwt(input: IssueJwtInput): Promise<IssueJwtResult> {
		return this.rpc.issueJwt(input)
	}

	override fetch(request: Request): Promise<Response> {
		return workerApp.fetch(request, this.iam, this.ctx)
	}

	/**
	 * Daily cron (see `triggers.crons`): prune old auth-log and password-transient rows.
	 * `WorkerEntrypoint.scheduled` receives only the controller; `env`/`ctx` come from `this`.
	 */
	override scheduled(_controller: ScheduledController): Promise<void> {
		runIamMaintenance(this.iam, this.ctx)
		return Promise.resolve()
	}
}

export default Propustka
