import { createRpcClient } from '@fabrika/app'
import type { ControlRpcContract } from '@fabrika/control-contract'
import type { NamespaceCli, NamespaceControl } from '@fabrika/provider-contract/app-cli'
import { z } from 'zod'
import { namespaceLine, namespacePlanLines } from './control'

export const NAMESPACE_USAGE = `fabrika namespace — deployment namespaces

Usage:
  fabrika namespace <plan|create|adopt|reconcile> --provider=<name> [provider options] [--json]

The commands and their options are the provider's: \`fabrika namespace --provider=<name> --help\` prints them.
`

export interface NamespaceCommandDependencies {
	readonly source: Readonly<Record<string, string | undefined>>
	readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
	readonly write: (value: string) => void
}

const required = (value: string | undefined, label: string): string => {
	if (value === undefined || value.trim() === '') {
		throw new Error(`${label} is required`)
	}
	return value.trim()
}

const outputJson = (value: unknown): string => `${JSON.stringify(value, null, '\t')}\n`

const CONTROL_URL_OPTION = '--control-url='

const controlCoordinates = (
	controlUrl: string | undefined,
	source: Readonly<Record<string, string | undefined>>,
): { baseUrl: URL; token: string } => {
	const value = required(controlUrl ?? source['FABRIKA_CONTROL_URL'], '--control-url or FABRIKA_CONTROL_URL')
	const token = required(source['FABRIKA_CONTROL_TOKEN'], 'FABRIKA_CONTROL_TOKEN')
	let baseUrl: URL
	try {
		baseUrl = new URL(value)
	} catch {
		throw new Error('--control-url or FABRIKA_CONTROL_URL must be an absolute URL')
	}
	if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
		throw new Error('--control-url or FABRIKA_CONTROL_URL must use http or https')
	}
	return { baseUrl, token }
}

const controlClient = (
	deps: NamespaceCommandDependencies,
	coordinates: { baseUrl: URL; token: string },
) =>
	createRpcClient<ControlRpcContract>({
		baseUrl: new URL('/api/rpc', coordinates.baseUrl).href,
		fetch: async (input, init) => {
			const headers = new Headers(init?.headers)
			headers.set('authorization', `Bearer ${coordinates.token}`)
			const response = await deps.fetch(input, { ...init, headers, redirect: 'manual' })
			if (!response.ok) {
				const body: unknown = await response.clone().json().catch(() => null)
				if (typeof body !== 'object' || body === null || !('error' in body)) {
					return Response.json({ error: { type: 'transport', message: `Control API request failed (${response.status})` } }, { status: response.status })
				}
			}
			return response
		},
	})

const namespaceControl = (deps: NamespaceCommandDependencies, controlUrl: string | undefined): NamespaceControl => {
	const client = controlClient(deps, controlCoordinates(controlUrl, deps.source))
	return {
		create: (namespace) =>
			client.namespaces.create({
				id: namespace.id,
				env: namespace.env,
				...(namespace.exclusiveAppId === undefined ? {} : { exclusiveAppId: namespace.exclusiveAppId }),
				target: namespace.target,
			}),
		adopt: (namespace) =>
			client.namespaces.adopt({
				namespaceId: namespace.id,
				namespace: {
					env: namespace.env,
					...(namespace.exclusiveAppId === undefined ? {} : { exclusiveAppId: namespace.exclusiveAppId }),
					target: namespace.target,
				},
			}),
		reconcile: (namespaceId) => client.namespaces.reconcile({ namespaceId }),
	}
}

// Passthrough on purpose: `--json` shows the operator the whole namespace detail, this only checks it is one.
const namespaceResponseSchema = z.object({
	id: z.string(),
	env: z.string(),
	state: z.enum(['pending', 'provisioning', 'ready', 'failed']),
	exclusiveAppId: z.string().nullable(),
}).passthrough()

/**
 * Run one provider's namespace command and print what it answers. `--json` and `--control-url` are this area's own
 * options, so they are taken out before the provider's parser, which refuses unknown options.
 */
export const runNamespaceCommand = async (
	cli: NamespaceCli,
	subcommand: string,
	argv: readonly string[],
	deps: NamespaceCommandDependencies,
): Promise<void> => {
	const json = argv.includes('--json')
	const controlUrl = argv.filter((arg) => arg.startsWith(CONTROL_URL_OPTION)).at(-1)?.slice(CONTROL_URL_OPTION.length)
	const providerArgv = argv.filter((arg) => arg !== '--json' && !arg.startsWith(CONTROL_URL_OPTION))
	// The Control credential stays here: the provider plans with the rest of the environment.
	const { FABRIKA_CONTROL_TOKEN: _token, ...source } = deps.source
	const result = await cli.run(subcommand, providerArgv, { source, control: () => namespaceControl(deps, controlUrl) })
	if ('plan' in result) {
		deps.write(json ? outputJson(result.plan) : `${namespacePlanLines(result.plan).join('\n')}\n`)
		return
	}
	const parsed = namespaceResponseSchema.safeParse(result.namespace)
	if (!parsed.success) {
		throw new Error('Control API returned an invalid namespace')
	}
	deps.write(json ? outputJson(parsed.data) : `${namespaceLine(parsed.data)}\n`)
}
