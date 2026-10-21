import type { AuthContext, FetchService, RequestExecutionContext } from '@fabrika/app'
import { dispatchRpcRequest, serveService, type ServiceHandler } from '@fabrika/app/service'
import { WORKLOAD_TOKEN_PATH } from '@fabrika/auth-core'
import type { ResolvedAdmin } from './admin/router'
import { handleAdmin } from './admin/router'
import { adminRpcAuth, adminRpcRouter } from './admin/rpc'
import { handleAuth } from './auth/routes'
import { readClientAddress } from './client-address'
import { handleDeviceAuthorization } from './device-http'
import type { Env } from './env'
import { handleMembershipTransport } from './membership-http'
import { handleOAuth } from './oauth-http'
import { proxyProof, UNPROVEN_CLIENT_ADDRESS } from './proxy-proof'
import { generateRequestId, readRequestId } from './request-id'
import { createIamRpc } from './rpc'
import { handleMintHttp, handleRpcHttp } from './rpc-http'
import { type IamEndpointId, iamServiceContract, type IamServiceOptions } from './service'
import { buildServices, type Services } from './services'
import { handleWorkloadToken } from './workload-token'

export interface IamAppContext {
	readonly env: Env
	readonly request: Request
	readonly exec: RequestExecutionContext
	readonly services: Services
	readonly requestId: string
	/** What this composition's ingress says the client is, or `null` when it cannot see one. */
	readonly clientAddress: string | null
	auth: AuthContext
	admin: ResolvedAdmin | null
}

export interface IamAppOptions {
	/** Shared secret for the process-only management transport. Empty disables the surface. */
	readonly rpcKey?: string
	/** Shared secret for the process-only proxy mint transport. Empty disables the surface. */
	readonly proxyKey?: string
	/**
	 * Mount the membership transport (`src/membership-http.ts`) for applications that have no IAM service binding. Each
	 * call is authenticated by its application's own key, not by a composition secret.
	 */
	readonly membershipTransport?: boolean
	/** Process liveness is mounted explicitly because the public Worker does not expose it. */
	readonly health?: boolean
	/**
	 * The ONE header this composition's ingress overwrites with the observed client address. Omitted
	 * means this installation cannot see its clients and keeps only the account and deployment-wide
	 * buckets — never a guess. See `src/client-address.ts`.
	 */
	readonly clientAddressHeader?: string
	/**
	 * The ONE header this composition's ingress overwrites with its own correlation id. Omitted means
	 * every request gets a generated id. See `src/request-id.ts`.
	 */
	readonly requestIdHeader?: string
	/**
	 * The secret the proxy sends in `PROXY_SECRET_HEADER` to prove it wrote the two headers above. Set, a request without
	 * it keys on `UNPROVEN_CLIENT_ADDRESS` and gets a generated id; omitted or empty, the headers are read as they arrive.
	 * See `src/proxy-proof.ts`.
	 */
	readonly proxySecret?: string
}

/** The service contract this composition serves: a switched-off transport has no row (`IamServiceOptions`). */
export function iamServiceOptions(options: IamAppOptions): IamServiceOptions {
	return {
		health: options.health === true,
		managementRpc: (options.rpcKey ?? '').trim() !== '',
		mintRpc: (options.proxyKey ?? '').trim() !== '',
		membershipTransport: options.membershipTransport === true,
	}
}

/**
 * Build IAM as a runtime-neutral service: `serveService` over IAM's service contract, which is also what the
 * platform proxy decides from on Zerops. Every row authenticates itself.
 *
 * The native Cloudflare service-binding RPC remains on the WorkerEntrypoint. The optional HTTP
 * transports are mounted by the Bun composition because their shared-secret boundary is process-only.
 */
export function createIamApp(options: IamAppOptions = {}): FetchService<Env> {
	const proven = proxyProof(options.proxySecret ?? '')
	const context = async (request: Request, env: Env, exec: RequestExecutionContext): Promise<IamAppContext> => {
		const attributed = await proven(request)
		return {
			env,
			request,
			exec,
			services: buildServices(env),
			requestId: attributed ? readRequestId(request, options.requestIdHeader) : generateRequestId(),
			clientAddress: attributed ? readClientAddress(request, options.clientAddressHeader) : UNPROVEN_CLIENT_ADDRESS,
			auth: anonymousAuth(),
			admin: null,
		}
	}
	const serve = (handle: (ctx: IamAppContext) => Response | Promise<Response>): ServiceHandler<Env> => async ({ request, env, exec }) =>
		handle(await context(request, env, exec))
	const auth = serve((ctx) => handleAuth(ctx.request, ctx.services, ctx.env, ctx.exec, ctx.clientAddress, ctx.requestId))
	const oauth = serve((ctx) => handleOAuth(ctx.request, ctx.services, ctx.env, ctx.requestId))
	const admin = serve((ctx) => handleAdmin(ctx.request, ctx.services, ctx.env, ctx.exec, ctx.requestId))
	const mint = serve((ctx) => handleMintHttp(ctx.request, createIamRpc(ctx.env, ctx.exec), options.proxyKey ?? ''))
	const rpc = serve((ctx) => handleRpcHttp(ctx.request, createIamRpc(ctx.env, ctx.exec), options.rpcKey ?? ''))
	return serveService<IamEndpointId, Env>(iamServiceContract(iamServiceOptions(options)), {
		'health': () => Response.json({ status: 'ok' }),
		'jwks': auth,
		'oauth-metadata': oauth,
		'oauth': oauth,
		'auth-root': serve(handleIamAuth),
		'auth': serve(handleIamAuth),
		'mint-session': mint,
		'mint-key': mint,
		'mint-exchange': mint,
		'mint-delegation': mint,
		'admin-rpc': serve((ctx) => adminRpcAuth(ctx.request, ctx, () => dispatchRpcRequest({ router: adminRpcRouter, ctx, request: ctx.request }))),
		'admin-root': admin,
		'admin': admin,
		'membership': serve((ctx) => handleMembershipTransport(ctx.request, ctx.services, createIamRpc(ctx.env, ctx.exec))),
		'rpc-root': rpc,
		'rpc': rpc,
	}, {
		onError(error) {
			console.error('iam request failed:', error instanceof Error ? error.message : 'unknown error')
			return new Response('internal error', {
				status: 500,
				headers: { 'content-type': 'text/plain; charset=utf-8' },
			})
		},
	})
}

function anonymousAuth(): AuthContext {
	return {
		ok: true,
		principal: null,
		can: () => false,
		scopedTo: () => [],
		audit: () => Promise.resolve(),
	}
}

/** The mint transport has rows of its own under the reserved `/auth/mint`, so no mint path arrives here. */
async function handleIamAuth(ctx: IamAppContext): Promise<Response> {
	const pathname = new URL(ctx.request.url).pathname
	if (pathname.startsWith('/auth/device/')) {
		return handleDeviceAuthorization(ctx.request, ctx.services, ctx.clientAddress, ctx.requestId)
	}
	if (pathname === WORKLOAD_TOKEN_PATH) {
		return handleWorkloadToken(ctx.request, ctx.services, ctx.env, ctx.exec, ctx.requestId, ctx.clientAddress)
	}
	return handleAuth(ctx.request, ctx.services, ctx.env, ctx.exec, ctx.clientAddress, ctx.requestId)
}

/**
 * The bare application, with no composition options at all — routing only. Neither entrypoint serves
 * it: `src/index.ts` and `src/node/server.ts` each build their own, because each has to name the one
 * headers its own ingress guarantees (see `IamAppOptions.clientAddressHeader` and `requestIdHeader`).
 */
export const iamApp = createIamApp()
