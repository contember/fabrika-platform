// `fabrika namespace` on Zerops: the provider options, the plan, and the namespace each command hands Control. The
// `fabrika` command holds Control's origin and credential, and prints the result.

import type { JsonValue, ProviderDeploymentNamespace, ProviderNamespacePlan } from '@fabrika/provider-contract'
import type { NamespaceCli, NamespaceCommandContext, NamespaceCommandResult } from '@fabrika/provider-contract/app-cli'
import { parseZeropsCliArgs, type ZeropsCliArgs } from './cli-args'
import {
	createZeropsNamespaceOperator,
	decodeZeropsNamespaceProxySource,
	verifyZeropsNamespaceProxySource,
	zeropsNamespaceTargetCodec,
} from './namespace'
import type { ZeropsNamespacePostgres } from './namespace'
import { postgresSchema } from './namespace/codec'

const NAMESPACE_USAGE = `fabrika namespace — Zerops deployment namespaces

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
  --project-name=<name>          Zerops project name (create: default fabrika-<env>-<id>;
                                 adopt: the existing project's name, default the namespace id).
  --core-package=<tier>          LIGHT or SERIOUS.
  --public-access=<mode>         custom-domain or zerops-subdomain.
  --postgres-type=<type>         Cheap-tier PostgreSQL type.
  --postgres-profile=<profile>   Cheap-tier PostgreSQL profile.
  --control-url=<url>            Control origin; or FABRIKA_CONTROL_URL.
  --json                         Print the result as JSON instead of rows.
  -h, --help                     Show this help.

\`plan\` prints one \`<path>\\t<value>\` row per field of the plan, keyed by its path in --json; a multi-line
value such as the proxy's descriptor file is shown by size only. The other commands print one
\`<id>\\t<env>\\t<state>\\t<exclusive app>\` row.

Mutating namespace commands read the Bearer credential from FABRIKA_CONTROL_TOKEN.
Plan/create/adopt require FABRIKA_ZEROPS_PROXY_SOURCE_JSON:
  {"repository":{"owner":"...","name":"..."},"commitSha":"...","descriptor":{"path":"zerops.yaml","contents":"...","sha256":"..."}}
Reconcile uses the persisted namespace source.
`

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
	const result = postgresSchema.safeParse({ type, profile })
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

/** One namespace command. Every input is validated before `context.control()` is read. */
const runZeropsNamespaceCommand = async (
	subcommand: string,
	argv: readonly string[],
	context: NamespaceCommandContext,
): Promise<NamespaceCommandResult> => {
	const args = parseZeropsCliArgs(['namespace', subcommand, ...argv])
	if (subcommand === 'plan') {
		return { plan: await namespacePlan(args, context.source) }
	}
	if (subcommand === 'reconcile') {
		const id = required(args.namespaceId, '--id')
		return { namespace: await context.control().reconcile(id) }
	}
	if (subcommand !== 'create' && subcommand !== 'adopt') {
		throw new Error(`Unknown namespace command: ${subcommand}`)
	}

	const planned = await namespacePlan(args, context.source)
	const control = context.control()
	if (subcommand === 'create') {
		return { namespace: await control.create(planned.namespace) }
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
				// An adopted project keeps its own name, so the plan's default for a created one does not apply.
				projectName: args.projectName ?? planned.namespace.id,
				managed: false,
				projectId,
				ready: false,
			}),
		},
	}
	return { namespace: await control.adopt(namespace) }
}

export const zeropsNamespaceCli: NamespaceCli = { usage: NAMESPACE_USAGE, run: runZeropsNamespaceCommand }
