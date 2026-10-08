import type {
	ApproveDeviceAuthorizationInput,
	ApproveDeviceAuthorizationResult,
	AssignMemberInput,
	AssignMemberResult,
	AuditInput,
	CreateScopeInput,
	CreateScopeResult,
	DenyDeviceAuthorizationResult,
	ExchangeAuthCodeInput,
	ExchangeAuthCodeResult,
	IamHandoffRpc,
	IamMembershipRpc,
	IamRpc,
	InspectDeviceAuthorizationInput,
	InspectDeviceAuthorizationResult,
	IssueKeyInput,
	IssueKeyResult,
	IssueLinkInput,
	IssueLinkResult,
	Jwks,
	ListMembersInput,
	ListMembersResult,
	ListOwnDeviceAuthorizationsInput,
	ListOwnDeviceAuthorizationsResult,
	ListPrincipalsInput,
	ListPrincipalsResult,
	MintFromKeyInput,
	MintFromKeyResult,
	MintTokenInput,
	MintTokenResult,
	RequestDelegationInput,
	RequestDelegationResult,
	RevokeKeyInput,
	RevokeKeyResult,
	RevokeLinkInput,
	RevokeLinkResult,
	RevokeMemberInput,
	RevokeMemberResult,
} from '@fabrika/auth-core'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { createIamApp } from './app'
import { runIamMaintenance } from './cron'
import { createIamRepositories } from './db'
import type { Env } from './env'
import { createIamRpc } from './rpc'

/**
 * The IAM Worker — the CLOUDFLARE entrypoint, and nothing more. Two `WorkerEntrypoint`s, reached over
 * `env.IAM` service bindings, which do not traverse any public edge: `PropustkaApplication`, the
 * subset an application calls, and the default export `Propustka`, which adds key issuing, device
 * approval, `fetch()` (`/admin/*` + `/auth/*`) and the cron for platform components.
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
 * The composition facts this root supplies: which headers carry the client address and the request id.
 *
 * IAM's Worker holds its OWN Custom Domain — it is not behind a proxy Worker — so the hop in front of
 * it is Cloudflare's edge, which writes `CF-Connecting-IP` and `cf-ray` on every request and replaces
 * a caller's. No proxy strips `X-Request-Id` here, so it is caller-chosen and never trusted. See
 * `src/client-address.ts` and `src/request-id.ts` for why IAM refuses to pick either itself.
 */
const workerApp = createIamApp({ clientAddressHeader: 'CF-Connecting-IP', requestIdHeader: 'cf-ray' })
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

/** Every call builds its surface from the Worker's own bindings; see `PropustkaApplication` for why it is no getter. */
function iamRpc(bindings: WorkerBindings, ctx: ExecutionContext): IamRpc & IamHandoffRpc & IamMembershipRpc {
	return createIamRpc(iamEnv(bindings), ctx)
}

/**
 * What an application's Workers call over `IAM`: the proxy mints and redeems, the SDK verifies, lists and
 * audits, and the framework requests membership operations on its caller's behalf.
 */
export type IamApplicationRpc = Pick<IamRpc, 'getJwks' | 'mintToken' | 'mintFromKey' | 'listPrincipals' | 'audit'> & IamHandoffRpc & IamMembershipRpc

/**
 * The entrypoint every application Worker and its proxy bind (`@fabrika/provider-cloudflare` refuses any
 * other). It holds no getter or field: workerd serves every prototype member over RPC, and a getter
 * returning the env or the RPC object would hand a caller IAM's secrets and every method withheld here.
 */
export class PropustkaApplication extends WorkerEntrypoint<WorkerBindings> implements IamApplicationRpc {
	mintToken(input: MintTokenInput): Promise<MintTokenResult> {
		return iamRpc(this.env, this.ctx).mintToken(input)
	}

	mintFromKey(input: MintFromKeyInput): Promise<MintFromKeyResult> {
		return iamRpc(this.env, this.ctx).mintFromKey(input)
	}

	/** Cross-host handoff redemption (ADR-0022), absent from `IamRpc`: the proxy Worker narrows this binding structurally. */
	exchangeAuthCode(input: ExchangeAuthCodeInput): Promise<ExchangeAuthCodeResult> {
		return iamRpc(this.env, this.ctx).exchangeAuthCode(input)
	}

	getJwks(): Promise<Jwks> {
		return iamRpc(this.env, this.ctx).getJwks()
	}

	audit(event: AuditInput): Promise<void> {
		return iamRpc(this.env, this.ctx).audit(event)
	}

	listPrincipals(input: ListPrincipalsInput): Promise<ListPrincipalsResult> {
		return iamRpc(this.env, this.ctx).listPrincipals(input)
	}

	requestDelegation(input: RequestDelegationInput): Promise<RequestDelegationResult> {
		return iamRpc(this.env, this.ctx).requestDelegation(input)
	}

	createScope(input: CreateScopeInput): Promise<CreateScopeResult> {
		return iamRpc(this.env, this.ctx).createScope(input)
	}

	assignMember(input: AssignMemberInput): Promise<AssignMemberResult> {
		return iamRpc(this.env, this.ctx).assignMember(input)
	}

	revokeMember(input: RevokeMemberInput): Promise<RevokeMemberResult> {
		return iamRpc(this.env, this.ctx).revokeMember(input)
	}

	listMembers(input: ListMembersInput): Promise<ListMembersResult> {
		return iamRpc(this.env, this.ctx).listMembers(input)
	}

	issueLink(input: IssueLinkInput): Promise<IssueLinkResult> {
		return iamRpc(this.env, this.ctx).issueLink(input)
	}

	revokeLink(input: RevokeLinkInput): Promise<RevokeLinkResult> {
		return iamRpc(this.env, this.ctx).revokeLink(input)
	}
}

/** The default export: the whole `IamRpc`, `/admin/*` + `/auth/*`, and the cron. Only platform components bind it. */
export class Propustka extends PropustkaApplication implements IamRpc, IamHandoffRpc {
	inspectDeviceAuthorization(input: InspectDeviceAuthorizationInput): Promise<InspectDeviceAuthorizationResult> {
		return iamRpc(this.env, this.ctx).inspectDeviceAuthorization(input)
	}

	approveDeviceAuthorization(input: ApproveDeviceAuthorizationInput): Promise<ApproveDeviceAuthorizationResult> {
		return iamRpc(this.env, this.ctx).approveDeviceAuthorization(input)
	}

	denyDeviceAuthorization(input: InspectDeviceAuthorizationInput): Promise<DenyDeviceAuthorizationResult> {
		return iamRpc(this.env, this.ctx).denyDeviceAuthorization(input)
	}

	listOwnDeviceAuthorizations(input: ListOwnDeviceAuthorizationsInput): Promise<ListOwnDeviceAuthorizationsResult> {
		return iamRpc(this.env, this.ctx).listOwnDeviceAuthorizations(input)
	}

	revokeKey(input: RevokeKeyInput): Promise<RevokeKeyResult> {
		return iamRpc(this.env, this.ctx).revokeKey(input)
	}

	issueKey(input: IssueKeyInput): Promise<IssueKeyResult> {
		return iamRpc(this.env, this.ctx).issueKey(input)
	}

	override fetch(request: Request): Promise<Response> {
		return workerApp.fetch(request, iamEnv(this.env), this.ctx)
	}

	/**
	 * Daily cron (see `triggers.crons`): prune old auth-log and password-transient rows.
	 * `WorkerEntrypoint.scheduled` receives only the controller; `env`/`ctx` come from `this`.
	 */
	override scheduled(_controller: ScheduledController): Promise<void> {
		runIamMaintenance(iamEnv(this.env), this.ctx)
		return Promise.resolve()
	}
}

export default Propustka
