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
import { pruneAuthLog } from './cron'
import type { Env } from './env'
import { handleFetch } from './routes'
import { createIamRpc } from './rpc'

/**
 * The IAM Worker — the CLOUDFLARE entrypoint, and nothing more. A single `WorkerEntrypoint` whose
 * default export carries BOTH the RPC methods (apps reach them over the `env.IAM` service binding,
 * which does not traverse any public edge) and `fetch()` (`/admin/*` + `/auth/*`).
 *
 * There is no logic here. Every method delegates: the RPC surface to `createIamRpc` (src/rpc.ts),
 * `fetch` to `handleFetch` (src/routes.ts), `scheduled` to `pruneAuthLog` (src/cron.ts) — the same
 * three functions the Bun entrypoint (src/node/server.ts) calls. This file's whole job is to bind
 * `cloudflare:workers` to them, and it is the ONLY file in the package that imports it: the Bun
 * process must never load this module, and it must never load `bun:*`/`node:*`.
 * `src/__tests__/entrypoint-isolation.test.ts` walks both import graphs and enforces exactly that.
 *
 * `this.ctx` (an `ExecutionContext`) satisfies `RequestContext` structurally, so it is passed
 * straight through with no adapter.
 */
export class Propustka extends WorkerEntrypoint<Env> implements IamRpc {
	private get rpc(): IamRpc {
		return createIamRpc(this.env, this.ctx)
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
		return handleFetch(request, this.env, this.ctx)
	}

	/**
	 * Daily cron (see `triggers.crons`): prune old `auth_log` rows (retention: weeks).
	 * `WorkerEntrypoint.scheduled` receives only the controller; `env`/`ctx` come from `this`.
	 */
	override scheduled(_controller: ScheduledController): Promise<void> {
		pruneAuthLog(this.env, this.ctx)
		return Promise.resolve()
	}
}

export default Propustka
