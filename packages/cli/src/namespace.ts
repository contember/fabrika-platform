import { createRpcClient } from '@fabrika/app'
import type { AdoptDeploymentNamespaceRequest, ControlRpcContract, CreateDeploymentNamespaceRequest } from '@fabrika/control-contract'
import type { JsonValue, ProviderDeploymentNamespace, ProviderNamespacePlan } from '@fabrika/provider-contract'
import {
	createZeropsNamespaceOperator,
	decodeZeropsNamespaceProxySource,
	parseZeropsCliArgs,
	verifyZeropsNamespaceProxySource,
	type ZeropsCliArgs,
	type ZeropsNamespacePostgres,
	zeropsNamespacePostgresSchema,
	zeropsNamespaceTargetCodec,
} from '@fabrika/provider-zerops'
import { z } from 'zod'

export const NAMESPACE_USAGE = `fabrika namespace — Zerops deployment namespaces

Usage:
  fabrika namespace plan --provider=zerops --id=<id> --env=<env> --preset=<cheap|mid|full> [namespace options]
  fabrika namespace create --provider=zerops --id=<id> --env=<env> --preset=<cheap|mid|full> [namespace options] [--control-url=<url>]
  fabrika namespace adopt --provider=zerops --id=<id> --env=<env> --preset=<cheap|mid|full> --project-id=<id> [namespace options] [--control-url=<url>]
  fabrika namespace reconcile --provider=zerops --id=<id> [--control-url=<url>]

Options:
  --id=<id>                      Namespace id.
  --env=<env>                    Environment.
  --preset=<cheap|mid|full>      Provider-owned namespace preset.
  --exclusive-app=<id>           App reserved by a full namespace.
  --project-id=<id>              Existing Zerops project id for adoption.
  --project-name=<name>          Zerops project name (default: namespace id).
  --core-package=<tier>          LIGHT or SERIOUS.
  --public-access=<mode>         custom-domain or zerops-subdomain.
  --postgres-type=<type>         Cheap-tier PostgreSQL type.
  --postgres-profile=<profile>   Cheap-tier PostgreSQL profile.
  --control-url=<url>            Control origin; or FABRIKA_CONTROL_URL.
  -h, --help                     Show this help.

Mutating namespace commands read the Bearer credential from FABRIKA_CONTROL_TOKEN.
Plan/create/adopt require FABRIKA_ZEROPS_PROXY_SOURCE_JSON:
  {"repository":{"owner":"...","name":"..."},"commitSha":"...","descriptor":{"path":"zerops.yaml","contents":"...","sha256":"..."}}
Reconcile uses the persisted namespace source. Legacy sources are not automatically pinned.
--proxy-build-from-git and FABRIKA_ZEROPS_PROXY_BUILD_FROM_GIT are no longer supported.
`

export interface ZeropsNamespaceCommandDependencies {
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

const postgres = (args: ZeropsCliArgs): ZeropsNamespacePostgres | undefined => {
	const type = args.postgresType
	const profile = args.postgresProfile
	if (type === undefined && profile === undefined) return undefined
	if (type === undefined) {
		throw new Error('--postgres-type is required with --postgres-profile')
	}
	const result = zeropsNamespacePostgresSchema.safeParse({ type, profile })
	if (result.success) return result.data
	if (result.error.issues[0]?.path[0] === 'type') throw new Error('--postgres-type must be postgresql:ha@18 or postgresql:single@18')
	throw new Error(`--postgres-profile ${profile} is not supported by ${type}`)
}

const planOptions = (args: ZeropsCliArgs): { [key: string]: JsonValue } | undefined => {
	const values: { [key: string]: JsonValue } = {}
	if (args.projectName !== undefined) values['projectName'] = required(args.projectName, '--project-name')
	if (args.corePackage !== undefined) values['corePackage'] = required(args.corePackage, '--core-package')
	if (args.publicAccess !== undefined) values['publicAccess'] = required(args.publicAccess, '--public-access')
	const database = postgres(args)
	if (database !== undefined) {
		values['postgres'] = database.profile === undefined ? { type: database.type } : { type: database.type, profile: database.profile }
	}
	return Object.keys(values).length === 0 ? undefined : values
}

const namespacePlan = async (
	args: ZeropsCliArgs,
	source: Readonly<Record<string, string | undefined>>,
): Promise<ProviderNamespacePlan> => {
	// `FABRIKA_ZEROPS_*` because Zerops reserves the bare `ZEROPS_` prefix and refuses to store a custom
	// variable using it (`userDataZeropsPrefixForbidden`).
	const serialized = required(source['FABRIKA_ZEROPS_PROXY_SOURCE_JSON'], 'FABRIKA_ZEROPS_PROXY_SOURCE_JSON')
	let value: unknown
	try {
		value = JSON.parse(serialized)
	} catch {
		throw new Error('FABRIKA_ZEROPS_PROXY_SOURCE_JSON must contain valid JSON')
	}
	const proxySource = decodeZeropsNamespaceProxySource(value)
	await verifyZeropsNamespaceProxySource(proxySource)
	const operator = createZeropsNamespaceOperator({ proxySource })
	const options = planOptions(args)
	return operator.plan({
		id: required(args.namespaceId, '--id'),
		env: required(args.env, '--env'),
		preset: required(args.preset, '--preset'),
		...(args.exclusiveAppId === undefined ? {} : { exclusiveAppId: required(args.exclusiveAppId, '--exclusive-app') }),
		...(options === undefined ? {} : { options }),
	})
}

const outputJson = (value: unknown): string => `${JSON.stringify(value, null, '\t')}\n`

const controlCoordinates = (
	args: ZeropsCliArgs,
	source: Readonly<Record<string, string | undefined>>,
): { baseUrl: URL; token: string } => {
	const value = required(args.controlUrl ?? source['FABRIKA_CONTROL_URL'], '--control-url or FABRIKA_CONTROL_URL')
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
	deps: ZeropsNamespaceCommandDependencies,
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

// Passthrough on purpose: the operator sees the whole namespace detail, this only checks it is one.
const namespaceResponseSchema = z.object({ id: z.string(), state: z.enum(['pending', 'provisioning', 'ready', 'failed']) }).passthrough()
const writeNamespace = (deps: ZeropsNamespaceCommandDependencies, result: unknown): void => {
	const parsed = namespaceResponseSchema.safeParse(result)
	if (!parsed.success) {
		throw new Error('Control API returned an invalid namespace')
	}
	deps.write(outputJson(parsed.data))
}

const createBody = (namespace: ProviderDeploymentNamespace): CreateDeploymentNamespaceRequest => ({
	id: namespace.id,
	env: namespace.env,
	...(namespace.exclusiveAppId === undefined ? {} : { exclusiveAppId: namespace.exclusiveAppId }),
	target: namespace.target,
})

const adoptBody = (namespace: ProviderDeploymentNamespace): AdoptDeploymentNamespaceRequest => ({
	env: namespace.env,
	...(namespace.exclusiveAppId === undefined ? {} : { exclusiveAppId: namespace.exclusiveAppId }),
	target: namespace.target,
})

/** Execute one namespace command. All command inputs are validated before the first fetch. */
export const runZeropsNamespaceCommand = async (
	args: ZeropsCliArgs,
	deps: ZeropsNamespaceCommandDependencies,
): Promise<void> => {
	const subcommand = required(args.subcommand, 'namespace command')
	if (args.proxyBuildFromGit !== undefined || deps.source['FABRIKA_ZEROPS_PROXY_BUILD_FROM_GIT'] !== undefined) {
		throw new Error(
			'--proxy-build-from-git and FABRIKA_ZEROPS_PROXY_BUILD_FROM_GIT are no longer supported; remove them and use FABRIKA_ZEROPS_PROXY_SOURCE_JSON for plan/create/adopt. Reconcile uses the persisted source; legacy sources are not automatically pinned.',
		)
	}
	if (subcommand === 'plan') {
		deps.write(outputJson(await namespacePlan(args, deps.source)))
		return
	}
	if (subcommand === 'reconcile') {
		const id = required(args.namespaceId, '--id')
		const control = controlCoordinates(args, deps.source)
		writeNamespace(deps, await controlClient(deps, control).namespaces.reconcile({ namespaceId: id }))
		return
	}
	if (subcommand !== 'create' && subcommand !== 'adopt') {
		throw new Error(`Unknown namespace command: ${subcommand}`)
	}

	const planned = await namespacePlan(args, deps.source)
	const control = controlCoordinates(args, deps.source)
	if (subcommand === 'create') {
		writeNamespace(deps, await controlClient(deps, control).namespaces.create(createBody(planned.namespace)))
		return
	}

	const projectId = required(args.projectId, '--project-id')
	const decoded = zeropsNamespaceTargetCodec.decode(planned.namespace.target.payload)
	const namespace: ProviderDeploymentNamespace = {
		...planned.namespace,
		target: {
			provider: 'zerops',
			version: zeropsNamespaceTargetCodec.version,
			payload: zeropsNamespaceTargetCodec.encode({
				...decoded,
				managed: false,
				projectId,
				ready: false,
			}),
		},
	}
	writeNamespace(deps, await controlClient(deps, control).namespaces.adopt({ namespaceId: namespace.id, namespace: adoptBody(namespace) }))
}

export const runZeropsNamespaceCli = (subcommand: string, argv: readonly string[]): Promise<void> =>
	runZeropsNamespaceCommand(parseZeropsCliArgs(['namespace', subcommand, ...argv]), {
		source: process.env,
		fetch: globalThis.fetch,
		write: (value) => console.info(value.trimEnd()),
	})
