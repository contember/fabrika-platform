import { defineApp, Worker } from '@fabrika/config'

const stateNamespaceUrl = 'https://api.cloudflare.com/client/v4/accounts/smoke-account/storage/kv/namespaces'

const smokeFetch = Object.assign(
	async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
		const request = new Request(input, init)

		if (request.method === 'GET' && request.url === `${stateNamespaceUrl}?per_page=1000`) {
			return Response.json({
				success: true,
				result: [{ title: 'smoke-app-state', id: 'smoke-state-namespace' }],
			})
		}

		if (request.method === 'POST' && request.url === `${stateNamespaceUrl}/smoke-state-namespace/bulk/get`) {
			return Response.json({ success: true, result: { values: {} } })
		}

		return new Response(`Unexpected network request in runner smoke fixture: ${request.method} ${request.url}`, { status: 500 })
	},
	{ preconnect: globalThis.fetch.preconnect },
)

globalThis.fetch = smokeFetch

export default defineApp({
	id: 'smoke-app',
	resources: ({ env }) =>
		new Worker({
			dir: '.',
			name: 'smoke-app',
			main: 'src/index.ts',
			compatibility_flags: ['nodejs_compat'],
			bindings: {},
			vars: { ENVIRONMENT: env },
		}),
})
