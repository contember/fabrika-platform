import type {
	JsonValue,
	ProviderDeploymentNamespace,
	ProviderNamespaceFact,
	ProviderNamespaceOperator,
	ProviderNamespacePlanInput,
	ProviderNamespacePresentation,
	ProviderNamespacePreset,
} from '@fabrika/provider-contract'
import { decodeEnvelope, envelope, optionalString, parsePostgres } from './codec'
import { zeropsNamespacePreset } from './topology'
import type { ZeropsNamespaceOperatorOptions, ZeropsNamespacePlanOptions, ZeropsNamespaceTarget } from './types'

const ZEROPS_NAMESPACE_PRESETS: readonly ProviderNamespacePreset[] = [
	{
		id: 'cheap',
		label: 'Cheap',
		description: 'Several apps share one project, proxy, and namespace-owned PostgreSQL service.',
		requiresExclusiveApp: false,
	},
	{
		id: 'mid',
		label: 'Mid',
		description: 'Several apps share one project and proxy; each app owns its prefixed database services.',
		requiresExclusiveApp: false,
	},
	{
		id: 'full',
		label: 'Full',
		description: 'One project and proxy are reserved for exactly one app.',
		requiresExclusiveApp: true,
	},
]

const parsePlanOptions = (value: JsonValue | undefined): ZeropsNamespacePlanOptions => {
	if (value === undefined) return {}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Zerops namespace plan options must be an object')
	}
	const supported = new Set(['projectName', 'corePackage', 'publicAccess', 'postgres'])
	for (const key of Object.keys(value)) {
		if (!supported.has(key)) {
			throw new Error(`Zerops namespace plan option ${key} is not supported`)
		}
	}
	const projectName = optionalString(value, 'projectName')
	const corePackage = optionalString(value, 'corePackage')
	if (corePackage !== undefined && corePackage !== 'LIGHT' && corePackage !== 'SERIOUS') {
		throw new Error('Zerops namespace plan corePackage must be LIGHT or SERIOUS')
	}
	const publicAccess = optionalString(value, 'publicAccess')
	if (publicAccess !== undefined && publicAccess !== 'custom-domain' && publicAccess !== 'zerops-subdomain') {
		throw new Error('Zerops namespace plan publicAccess is not supported')
	}
	const postgres = parsePostgres(value)
	return {
		...(projectName === undefined ? {} : { projectName }),
		...(corePackage === undefined ? {} : { corePackage }),
		...(publicAccess === undefined ? {} : { publicAccess }),
		...(postgres === undefined ? {} : { postgres }),
	}
}

const namespacePresentation = (
	namespace: ProviderDeploymentNamespace,
	target: ZeropsNamespaceTarget,
): ProviderNamespacePresentation => {
	const preset = target.postgres !== undefined ? 'cheap' : namespace.exclusiveAppId === undefined ? 'mid' : 'full'
	const projectName = target.projectName ?? namespace.id
	const corePackage = target.corePackage ?? 'LIGHT'
	const publicAccess = target.publicAccess ?? 'custom-domain'
	const postgres = target.postgres === undefined
		? 'App-owned database services'
		: `Shared ${target.postgres.type}${target.postgres.profile === undefined ? '' : ` (${target.postgres.profile})`}`
	// Only a published subdomain namespace knows its own hosts; custom domains are bound out of band, so
	// the provider names none and an operator reads them where they were bound.
	const hosts = publicAccess === 'zerops-subdomain' && target.ready === true ? target.proxyHosts ?? [] : []
	const instructions = [
		...(publicAccess === 'custom-domain'
			? [`Bind each application domain to the \`proxy\` service in Zerops project \`${projectName}\`; keep every app service private.`]
			: ['Use the proxy Zerops subdomain only for non-production access; app services must remain private.']),
		...(hosts.length === 0 ? [] : ['Register a proxy-target environment with one of the hosts below as its domain; each host serves one app.']),
		...(target.postgres === undefined
			? []
			: ['Every app consuming the shared PostgreSQL binding shares its physical service and provider-issued credential.']),
	]
	// The project is the one fact that names a LIVE resource: it exists at the provider, it outlives the
	// namespace row, and removal does not delete it (ADR-0034). Marked only once it actually exists.
	const project: ProviderNamespaceFact = target.projectId === undefined
		? { label: 'Project', value: projectName }
		: { label: 'Project', value: `${projectName} (${target.projectId})`, resource: true }
	return {
		preset,
		title: `${ZEROPS_NAMESPACE_PRESETS.find((candidate) => candidate.id === preset)?.label ?? preset} namespace`,
		facts: [
			{
				label: 'Proxy source',
				value: target.proxySource === undefined
					? 'Unpinned (mutations blocked)'
					: `${target.proxySource.repository.owner}/${target.proxySource.repository.name}@${target.proxySource.commitSha} (zerops.yaml sha256:${target.proxySource.descriptor.sha256})`,
			},
			project,
			{ label: 'Environment', value: namespace.env },
			{ label: 'Core package', value: corePackage },
			{ label: 'Placement', value: namespace.exclusiveAppId === undefined ? 'Shared' : `Exclusive to ${namespace.exclusiveAppId}` },
			{ label: 'PostgreSQL', value: postgres },
			{ label: 'Public access', value: publicAccess },
		],
		instructions,
		...(hosts.length === 0 ? {} : { hosts }),
	}
}

/** Build the provider-owned namespace planning surface without any network collaborators. */
export const createZeropsNamespaceOperator = (
	options: ZeropsNamespaceOperatorOptions,
): ProviderNamespaceOperator => {
	return {
		presets: ZEROPS_NAMESPACE_PRESETS,
		plan(input: ProviderNamespacePlanInput) {
			if (input.id.trim() === '' || input.env.trim() === '') {
				throw new Error('Zerops namespace plan id and env must be non-empty')
			}
			if (input.preset !== 'cheap' && input.preset !== 'mid' && input.preset !== 'full') {
				throw new Error(`Zerops namespace preset ${input.preset} is not supported`)
			}
			const exclusiveAppId = input.exclusiveAppId?.trim()
			if (input.preset === 'full' && (exclusiveAppId === undefined || exclusiveAppId === '')) {
				throw new Error('Zerops full namespace plan requires exclusiveAppId')
			}
			if (input.preset !== 'full' && exclusiveAppId !== undefined) {
				throw new Error(`Zerops ${input.preset} namespace plan cannot reserve an exclusive app`)
			}
			const planOptions = parsePlanOptions(input.options)
			if (input.preset !== 'cheap' && planOptions.postgres !== undefined) {
				throw new Error(`Zerops ${input.preset} namespace plan cannot own PostgreSQL`)
			}
			const target = zeropsNamespacePreset({
				preset: input.preset,
				env: input.env,
				projectName: planOptions.projectName ?? input.id,
				proxyBuildFromGit: options.proxyBuildFromGit,
				...(options.proxySource === undefined ? {} : { proxySource: options.proxySource }),
				...(planOptions.corePackage === undefined ? {} : { corePackage: planOptions.corePackage }),
				...(planOptions.publicAccess === undefined ? {} : { publicAccess: planOptions.publicAccess }),
				...(planOptions.postgres === undefined ? {} : { postgres: planOptions.postgres }),
			})
			const namespace: ProviderDeploymentNamespace = {
				id: input.id,
				env: input.env,
				...(exclusiveAppId === undefined ? {} : { exclusiveAppId }),
				target: envelope(target),
			}
			return { namespace, presentation: namespacePresentation(namespace, target) }
		},
		present(namespace) {
			return namespacePresentation(namespace, decodeEnvelope(namespace.target))
		},
	}
}
