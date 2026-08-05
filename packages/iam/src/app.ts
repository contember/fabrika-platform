import { type AuthContext, defineApp, type RequestExecutionContext, route } from '@fabrika/app'
import type { ResolvedAdmin } from './admin/router'
import { handleAdmin } from './admin/router'
import { adminRpcAuth, adminRpcRouter } from './admin/rpc'
import { handleAuth } from './auth/routes'
import { readClientAddress } from './client-address'
import type { Env } from './env'
import { requestId } from './request-id'
import { createIamRpc } from './rpc'
import { handleMintHttp, handleRpcHttp, isMintPath, isRpcPath } from './rpc-http'
import { buildServices, type Services } from './services'

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
	/** Process liveness is mounted explicitly because the public Worker does not expose it. */
	readonly health?: boolean
	/**
	 * The ONE header this composition's ingress overwrites with the observed client address. Omitted
	 * means this installation cannot see its clients and keeps only the account and deployment-wide
	 * buckets — never a guess. See `src/client-address.ts`.
	 */
	readonly clientAddressHeader?: string
}

/**
 * Build IAM as a runtime-neutral Fabrika application.
 *
 * The native Cloudflare service-binding RPC remains on the WorkerEntrypoint. The optional HTTP
 * transports are mounted by the Bun composition because their shared-secret boundary is process-only.
 */
export function createIamApp(options: IamAppOptions = {}) {
	return defineApp<Env, IamAppContext>({
		context: (env, request, exec) => ({
			env,
			request,
			exec,
			services: buildServices(env),
			requestId: requestId(request),
			clientAddress: readClientAddress(request, options.clientAddressHeader),
			auth: anonymousAuth(),
			admin: null,
		}),
		routes: [
			...(options.health === true
				? [route.all<IamAppContext, '/healthz'>('/healthz', () => Response.json({ status: 'ok' }))]
				: []),
			route.all('/.well-known/jwks.json', (ctx) => handleAuth(ctx.request, ctx.services, ctx.env, ctx.exec, ctx.clientAddress)),
			route.all('/auth', (ctx) => handleIamAuth(ctx, options)),
			route.all('/auth/*path', (ctx) => handleIamAuth(ctx, options)),
			route.rpc('/admin/rpc', adminRpcRouter, { use: [adminRpcAuth] }),
			route.all('/admin', (ctx) => handleAdmin(ctx.request, ctx.services, ctx.env, ctx.exec)),
			route.all('/admin/*path', (ctx) => handleAdmin(ctx.request, ctx.services, ctx.env, ctx.exec)),
			route.all('/rpc', (ctx) => handleIamRpc(ctx, options)),
			route.all('/rpc/*method', (ctx) => handleIamRpc(ctx, options)),
			route.all('/*path', () =>
				new Response('not found', {
					status: 404,
					headers: { 'content-type': 'text/plain; charset=utf-8' },
				})),
		],
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

async function handleIamAuth(ctx: IamAppContext, options: IamAppOptions): Promise<Response> {
	const pathname = new URL(ctx.request.url).pathname
	if (isMintPath(pathname)) {
		return handleMintHttp(ctx.request, createIamRpc(ctx.env, ctx.exec), options.proxyKey ?? '')
	}
	return handleAuth(ctx.request, ctx.services, ctx.env, ctx.exec, ctx.clientAddress)
}

function handleIamRpc(ctx: IamAppContext, options: IamAppOptions): Promise<Response> {
	const pathname = new URL(ctx.request.url).pathname
	if (!isRpcPath(pathname)) {
		return Promise.resolve(new Response('not found', { status: 404 }))
	}
	return handleRpcHttp(ctx.request, createIamRpc(ctx.env, ctx.exec), options.rpcKey ?? '')
}

/**
 * The bare application, with no composition options at all — routing only. Neither entrypoint serves
 * it: `src/index.ts` and `src/node/server.ts` each build their own, because each has to name the one
 * header its own ingress guarantees (see `IamAppOptions.clientAddressHeader`).
 */
export const iamApp = createIamApp()
