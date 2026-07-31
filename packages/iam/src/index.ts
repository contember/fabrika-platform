import type {
	AuditInput,
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
import { iamApp } from './app'
import { pruneAuthLog } from './cron'
import { createIamRepositories } from './db'
import type { Env } from './env'
import { createIamRpc } from './rpc'

/**
 * The IAM Worker — the CLOUDFLARE entrypoint, and nothing more. A single `WorkerEntrypoint` whose
 * default export carries BOTH the RPC methods (apps reach them over the `env.IAM` service binding,
 * which does not traverse any public edge) and `fetch()` (`/admin/*` + `/auth/*`).
 *
 * There is no logic here. Every method delegates: the RPC surface to `createIamRpc` (src/rpc.ts),
 * `fetch` to `iamApp`, `scheduled` to `pruneAuthLog` (src/cron.ts) — the same
 * three functions the Bun entrypoint (src/node/server.ts) calls. This file's whole job is to bind
 * `cloudflare:workers` to them, and it is the ONLY file in the package that imports it: the Bun
 * process must never load this module, and it must never load `bun:*`/`node:*`.
 * `src/__tests__/entrypoint-isolation.test.ts` walks both import graphs and enforces exactly that.
 *
 * `this.ctx` (an `ExecutionContext`) satisfies `RequestContext` structurally, so it is passed
 * straight through with no adapter.
 */
export interface WorkerBindings extends Omit<Env, 'DB' | 'REPOSITORIES'> {
	DB: D1Database
}

/** Present native Worker bindings as the runtime-neutral IAM environment. */
export function iamEnv(bindings: WorkerBindings): Env {
	return {
		...bindings,
		DB: bindings.DB,
		REPOSITORIES: createIamRepositories(bindings.DB),
	}
}

export class Propustka extends WorkerEntrypoint<WorkerBindings> implements IamRpc {
	private get iam(): Env {
		return iamEnv(this.env)
	}

	private get rpc(): IamRpc {
		return createIamRpc(this.iam, this.ctx)
	}

	mintToken(input: MintTokenInput): Promise<MintTokenResult> {
		return this.rpc.mintToken(input)
	}

	mintFromKey(input: MintFromKeyInput): Promise<MintFromKeyResult> {
		return this.rpc.mintFromKey(input)
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
		return iamApp.fetch(request, this.iam, this.ctx)
	}

	/**
	 * Daily cron (see `triggers.crons`): prune old `auth_log` rows (retention: weeks).
	 * `WorkerEntrypoint.scheduled` receives only the controller; `env`/`ctx` come from `this`.
	 */
	override scheduled(_controller: ScheduledController): Promise<void> {
		pruneAuthLog(this.iam, this.ctx)
		return Promise.resolve()
	}
}

export default Propustka
