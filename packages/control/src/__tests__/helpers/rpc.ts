import { dispatchRpcRequest } from '@fabrika/app/service'
import { createControlRpcRouter } from '../../control-rpc'
import type { Env } from '../../env'
import type { ControlRpcDeps } from '../../services'
import { unusedSourceConnection } from './source-connection'

export function rpcRequest(method: string, input: unknown = null, signal?: AbortSignal): Request {
	return new Request('https://control.test/api/rpc', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ method, input }),
		...(signal === undefined ? {} : { signal }),
	})
}

/** Exercise the real RPC parser and ACL, then expose its domain result for persistence assertions. */
export async function rpcResult(request: Request, deps: ControlRpcDeps): Promise<Response> {
	const env: Env = {
		DB: {
			prepare: () => {
				throw new Error('RPC tests must use the injected repositories')
			},
			batch: () => Promise.reject(new Error('RPC tests must use the injected repositories')),
		},
		REPOSITORIES: deps.repositories,
		ASSETS: { fetch: () => Promise.reject(new Error('RPC tests must not serve assets')) },
		RUN_LOGS: {
			...deps.logs,
			put: () => Promise.reject(new Error('RPC must not write run logs')),
			delete: () => Promise.reject(new Error('RPC must not delete run logs')),
		},
		DEPLOY_QUEUE: deps.queue,
		WAIT_UNTIL: () => {},
		ENVIRONMENT: 'local',
	}
	const response = await dispatchRpcRequest({
		router: createControlRpcRouter(() => deps),
		ctx: { auth: deps.auth, request, env, provider: deps.provider, sourceConnection: unusedSourceConnection(deps.provider.id) },
		request,
	})
	const body: unknown = await response.json()
	if (typeof body !== 'object' || body === null) throw new Error('expected an RPC envelope')
	if ('result' in body) return Response.json(body.result, { status: response.status })
	if ('error' in body && typeof body.error === 'object' && body.error !== null && 'message' in body.error) {
		return Response.json({ error: body.error.message }, { status: response.status })
	}
	throw new Error('expected an RPC result or error')
}
