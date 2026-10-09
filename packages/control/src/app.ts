import type { AuthContext, FetchService, RequestExecutionContext } from '@fabrika/app'
import { dispatchRpcRequest, serveService, type ServiceHandler } from '@fabrika/app/service'
import type { ControlProvider } from '@fabrika/provider-contract'
import { type ControlEndpointId, controlServiceContract } from '../fabrika.service'
import { builderPublicResponse } from './builder-bootstrap'
import { controlRpcRouter } from './control-rpc'
import type { Env } from './env'
import { SourceConnectionWorkflowError } from './github/connections/errors'
import { manifestCallback, manifestHandoff } from './github/connections/manifest'
import type { SourceConnectionPort } from './github/connections/port'
import { handleWebhook } from './github/triggers/webhook'
import { error } from './http'
import { controlAuthenticator } from './iam'
import { forwardIamAdmin } from './iam-admin'
import { forwardOperationsApi } from './operations-gateway'
import { connectionWebhookVerifier, repositories } from './services'

export interface ControlAppEnv {
	readonly env: Env
	readonly provider: ControlProvider
	readonly sourceConnection: SourceConnectionPort
}

export interface ControlAppContext {
	auth?: AuthContext | null
	readonly env: Env
	readonly provider: ControlProvider
	readonly sourceConnection: SourceConnectionPort
	readonly request: Request
}

/** The MCP endpoint (ADR-0049); only the Bun process serves one. */
export type McpRoute = (request: Request) => Promise<Response>

/**
 * Delivery as a first-party service: `serveService` over the console's service contract, which its proxy decides
 * from on both providers. With an MCP route the table carries the `oauth` row for `/mcp`; without one, `/mcp` is a
 * session-only row that answers 404. Provider and runtime ports are supplied by the composition root.
 */
export function createControlApp(mcp: McpRoute | null): FetchService<ControlAppEnv> {
	type Handle = (ctx: ControlAppContext, params: Readonly<Record<string, string>>) => Response | Promise<Response>
	const serve = (handle: Handle): ServiceHandler<ControlAppEnv> => ({ request, params, env: { env, provider, sourceConnection }, exec }) =>
		handle({ env: withRequestExecution(env, exec), provider, sourceConnection, request }, params)
	/** A credentialed row: the caller from the injected token. The proxy admitted a session's state change already. */
	const authenticated = (handle: Handle): ServiceHandler<ControlAppEnv> =>
		serve(async (ctx, params) => {
			const caller = await controlAuthenticator(ctx.env)(ctx.request)
			if (!caller.ok) return caller.response
			return handle({ ...ctx, auth: caller.auth }, params)
		})
	const notFound = serve(() => error(404, 'not found'))
	const builder = serve((ctx) => builderPublicResponse(ctx.request, ctx.env, ctx.provider.id) ?? error(404, 'not found'))
	const handlers: { readonly [Id in ControlEndpointId]: ServiceHandler<ControlAppEnv> } = {
		'health': () => Response.json({ status: 'ok' }),
		'api-health': () => Response.json({ status: 'ok', service: 'vozka', milestone: 'M4' }),
		'builder-discovery': builder,
		'builder-connect': builder,
		'github-webhook': serve((ctx, params) => webhook(ctx, params['connectionId'] ?? '')),
		'webhooks-root': notFound,
		'github-manifest': authenticated((ctx, params) => sourceConnectionBrowserCall(ctx, (deps) => manifestHandoff(deps, params['connectionId'] ?? ''))),
		'github-callback': authenticated((ctx) => sourceConnectionBrowserCall(ctx, manifestCallback)),
		'rpc': authenticated((ctx) => dispatchRpcRequest({ router: controlRpcRouter, ctx, request: ctx.request })),
		'api-root': notFound,
		'iam-admin-rpc': serve(iamAdmin),
		'iam-admin-root': notFound,
		'operations-rpc': serve(operationsApi),
		'operations-api-root': notFound,
		'console': serve((ctx) => ctx.env.ASSETS.fetch(ctx.request)),
		'mcp': mcp === null ? notFound : serve((ctx) => mcpRequest(mcp, ctx.request)),
	}
	return serveService(controlServiceContract({ mcp: mcp !== null }), handlers, {
		onError(cause) {
			console.error('control request failed:', cause instanceof Error ? cause.message : 'unknown error')
			return new Response('internal error', {
				status: 500,
				headers: { 'content-type': 'text/plain; charset=utf-8' },
			})
		},
	})
}

/** The console without MCP: what the Cloudflare Worker serves. */
export const controlApp: FetchService<ControlAppEnv> = createControlApp(null)

async function mcpRequest(mcp: McpRoute, request: Request): Promise<Response> {
	try {
		return await mcp(request)
	} catch (cause) {
		console.error('mcp request failed:', cause instanceof Error ? cause.message : 'unknown error')
		return new Response('internal error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
	}
}

function webhook(ctx: ControlAppContext, connectionId: string): Promise<Response> {
	return handleWebhook(ctx.request, {
		repositories: repositories(ctx.env),
		verifier: connectionWebhookVerifier(ctx.env, connectionId),
		queue: ctx.env.DEPLOY_QUEUE,
		connectionId,
	})
}

function sourceConnectionBrowserCall(
	ctx: ControlAppContext,
	handler: (deps: Parameters<typeof manifestHandoff>[0]) => Promise<Response>,
): Promise<Response> {
	if (ctx.auth === undefined || ctx.auth === null) return Promise.resolve(secureBrowserResponse(error(401, 'authentication required')))
	return handler({ env: ctx.env, source: ctx.sourceConnection, auth: ctx.auth, request: ctx.request })
		.then(secureBrowserResponse)
		.catch((cause: unknown) => {
			if (cause instanceof SourceConnectionWorkflowError) return secureBrowserResponse(error(cause.httpStatus, cause.message))
			if (cause instanceof DOMException && cause.name === 'AbortError') return secureBrowserResponse(error(499, 'request cancelled'))
			console.error('source connection request failed')
			return secureBrowserResponse(error(500, 'internal error'))
		})
}

function secureBrowserResponse(response: Response): Response {
	const headers = new Headers(response.headers)
	headers.set('cache-control', 'no-store')
	headers.set('referrer-policy', 'no-referrer')
	headers.set('x-content-type-options', 'nosniff')
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function withRequestExecution(env: Env, exec: RequestExecutionContext): Env {
	return { ...env, WAIT_UNTIL: (promise) => exec.waitUntil(promise) }
}

function iamAdmin(ctx: ControlAppContext): Promise<Response> {
	const gateway = ctx.env.IAM_ADMIN
	if (gateway === undefined) {
		return Promise.resolve(Response.json({ error: 'IAM admin gateway unavailable' }, { status: 503 }))
	}
	return forwardIamAdmin(ctx.request, {
		gateway,
		...(ctx.env.FABRIKA_IAM_ISSUER === undefined ? {} : { publicIamUrl: ctx.env.FABRIKA_IAM_ISSUER }),
	})
}

function operationsApi(ctx: ControlAppContext): Promise<Response> {
	const gateway = ctx.env.OPERATIONS
	if (gateway === undefined) {
		return Promise.resolve(Response.json({ error: 'operations unavailable' }, { status: 503 }))
	}
	return forwardOperationsApi(ctx.request, {
		gateway,
		...(ctx.env.FABRIKA_IAM_ISSUER === undefined ? {} : { publicIamUrl: ctx.env.FABRIKA_IAM_ISSUER }),
	})
}
