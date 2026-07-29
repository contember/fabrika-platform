import type { JsonValue, ProviderDeploymentNamespace, ProviderNamespacePlan } from '@fabrika/provider-contract'
import type { ZeropsCliArgs } from './cli-args'
import { createZeropsNamespaceOperator, type ZeropsNamespacePostgres, zeropsNamespaceTargetCodec } from './namespace'

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
	if (type === 'postgresql:ha@18') {
		if (
			profile !== undefined
			&& profile !== 'oltp-staging'
			&& profile !== 'oltp-production'
			&& profile !== 'oltp-enterprise'
			&& profile !== 'olap-production'
			&& profile !== 'writeheavy-production'
		) {
			throw new Error(`--postgres-profile ${profile} is not supported by ${type}`)
		}
		return profile === undefined ? { type } : { type, profile }
	}
	if (type === 'postgresql:single@18') {
		if (
			profile !== undefined
			&& profile !== 'oltp-hobby'
			&& profile !== 'oltp-staging'
			&& profile !== 'oltp-production'
			&& profile !== 'olap-production'
			&& profile !== 'writeheavy-production'
		) {
			throw new Error(`--postgres-profile ${profile} is not supported by ${type}`)
		}
		return profile === undefined ? { type } : { type, profile }
	}
	throw new Error('--postgres-type must be postgresql:ha@18 or postgresql:single@18')
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

const namespacePlan = (
	args: ZeropsCliArgs,
	source: Readonly<Record<string, string | undefined>>,
): ProviderNamespacePlan => {
	const proxyBuildFromGit = required(
		args.proxyBuildFromGit ?? source['ZEROPS_PROXY_BUILD_FROM_GIT'],
		'--proxy-build-from-git or ZEROPS_PROXY_BUILD_FROM_GIT',
	)
	const operator = createZeropsNamespaceOperator({ proxyBuildFromGit })
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

const responseText = async (response: Response): Promise<string> => {
	const text = await response.text()
	if (response.ok) return text.trim() === '' ? 'null' : text
	let message = `Control API request failed (${response.status})`
	try {
		const body: unknown = JSON.parse(text)
		if (typeof body === 'object' && body !== null) {
			const error = Reflect.get(body, 'error')
			if (typeof error === 'string' && error !== '') message = error
		}
	} catch {
		if (text.trim() !== '' && text.length < 500) message = text
	}
	throw new Error(message)
}

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

const callControl = async (
	deps: ZeropsNamespaceCommandDependencies,
	coordinates: { baseUrl: URL; token: string },
	path: string,
	body?: unknown,
): Promise<void> => {
	const response = await deps.fetch(new URL(path, coordinates.baseUrl), {
		method: 'POST',
		headers: {
			accept: 'application/json',
			authorization: `Bearer ${coordinates.token}`,
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	const text = await responseText(response)
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		parsed = text
	}
	deps.write(outputJson(parsed))
}

const createBody = (namespace: ProviderDeploymentNamespace): object => ({
	id: namespace.id,
	env: namespace.env,
	...(namespace.exclusiveAppId === undefined ? {} : { exclusiveAppId: namespace.exclusiveAppId }),
	target: namespace.target,
})

const adoptBody = (namespace: ProviderDeploymentNamespace): object => ({
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
	if (subcommand === 'plan') {
		deps.write(outputJson(namespacePlan(args, deps.source)))
		return
	}
	if (subcommand === 'reconcile') {
		const id = required(args.namespaceId, '--id')
		const control = controlCoordinates(args, deps.source)
		await callControl(deps, control, `/api/namespaces/${encodeURIComponent(id)}/reconcile`)
		return
	}
	if (subcommand !== 'create' && subcommand !== 'adopt') {
		throw new Error(`Unknown namespace command: ${subcommand}`)
	}

	const planned = namespacePlan(args, deps.source)
	const control = controlCoordinates(args, deps.source)
	if (subcommand === 'create') {
		await callControl(deps, control, '/api/namespaces', createBody(planned.namespace))
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
	await callControl(
		deps,
		control,
		`/api/namespaces/${encodeURIComponent(namespace.id)}/adopt`,
		adoptBody(namespace),
	)
}
