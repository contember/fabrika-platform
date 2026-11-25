// The `registry` kinds (ADR-0083 §1, §8; ADR-0050 §4): what a deploy of an environment runs and where it is reached.
// `apps.environments.put` takes the procedure's whole body with its meaning: an absent domain or trigger ref clears it,
// an absent public origin, cross-origin list, namespace or authoring flag keeps it, and the target and artifact are
// replaced. It executes through the put's use case as the approver, the provider's `prepareRegistration` included, and
// binds the environment's `generation` beside every field the put writes, the target and artifact by their digests.
// `apps.update` is a patch with the value each field held when the request was made, shown before → after; naming the
// repository or its GitHub binding takes global `app.manage`, of the requester and of the approver alike.

import { canonicalJson, sha256Hex } from '@fabrika/auth-core'
import { ALL_ENVIRONMENTS, APP_ENV_KINDS, CONTROL_ACTIONS } from '@fabrika/control-contract'
import type { ProviderEnvelope } from '@fabrika/provider-contract'
import { z } from 'zod'
import { fail } from '../../../api/domain'
import { parseStoredEnvelope, providerEnvelopeSchema } from '../../../api/provider-envelope'
import { updateAppUseCase } from '../../../api/registry/apps'
import { admitAppEnvPut, putAppEnvUseCase } from '../../../api/registry/environments'
import { assertCrossOrigins, assertProxyDomain, canonicalOrigin, triggerRefInput } from '../../../api/registry/validation'
import { appEnvCrossOrigins, type AppEnvRow, type AppRow } from '../../../db'
import { normalizeRepoUrl } from '../../../github/triggers/push-event'
import { type RequestActionContext, requestKind, type RequestKindContext } from '../kind'
import { agentText, appIdField, envField, observed, outcomeOf, ownText, registryContext, shown } from './shared'

/** The put's body as its procedure takes it (`control-rpc.ts`), read without `.strict()` so a stored row parses again. */
const environmentBody = z.object({
	domain: z.string().nullable().optional(),
	publicOrigin: z.string().nullable().optional(),
	crossOrigins: z.array(z.string()).optional(),
	triggerRef: z.string().nullable().optional(),
	authoring: z.boolean().optional(),
	kind: z.enum(APP_ENV_KINDS).optional(),
	namespaceId: z.string().nullable().optional(),
	target: providerEnvelopeSchema,
	artifact: providerEnvelopeSchema,
})
type EnvironmentBody = z.infer<typeof environmentBody>

const putEnvironmentInput = z.object({ appId: appIdField, env: envField, environment: environmentBody })
type PutEnvironmentInput = z.infer<typeof putEnvironmentInput>

/** Every field a put writes, as the environment holds it; the target and artifact by the digest of their envelope. */
const environmentFields = z.object({
	triggerRef: z.string().nullable(),
	domain: z.string().nullable(),
	publicOrigin: z.string().nullable(),
	crossOrigins: z.array(z.string()),
	namespaceId: z.string().nullable(),
	authoring: z.boolean(),
	target: z.string(),
	artifact: z.string(),
})
type EnvironmentFields = z.infer<typeof environmentFields>

/** What an environment put binds: its `generation`, and every field the put writes as it is now. */
const environmentBefore = z.object({ generation: z.number(), fields: environmentFields })

type EnvironmentField = keyof EnvironmentFields

const ENVIRONMENT_FIELDS: readonly EnvironmentField[] = [
	'triggerRef',
	'domain',
	'publicOrigin',
	'crossOrigins',
	'namespaceId',
	'authoring',
	'target',
	'artifact',
]

const ENVIRONMENT_FIELD_LABELS: Readonly<Record<EnvironmentField, string>> = {
	triggerRef: 'Trigger ref',
	domain: 'Domain',
	publicOrigin: 'Public origin',
	crossOrigins: 'Cross origins',
	namespaceId: 'Deployment namespace',
	authoring: 'Authoring target',
	target: 'Target',
	artifact: 'Artifact',
}

/** An envelope as the page shows it and the before-state binds it: its provider, version and digest. */
function envelopeDigest(envelope: ProviderEnvelope): string {
	return `${envelope.provider} v${envelope.version}, sha256:${sha256Hex(canonicalJson(envelope)).slice(0, 12)}`
}

function fieldsOf(appEnv: AppEnvRow): EnvironmentFields {
	const where = `app env ${appEnv.app_id}/${appEnv.env}`
	return {
		triggerRef: appEnv.trigger_ref,
		domain: appEnv.domain,
		publicOrigin: appEnv.public_origin,
		crossOrigins: appEnvCrossOrigins(appEnv),
		namespaceId: appEnv.namespace_id,
		authoring: appEnv.authoring === 1,
		target: envelopeDigest(parseStoredEnvelope(appEnv.provider_target_json, `${where} target`)),
		artifact: envelopeDigest(parseStoredEnvelope(appEnv.provider_artifact_json, `${where} artifact`)),
	}
}

/** What the put writes over `now`, each field as `putAppEnvUseCase` reads its absence; the target before the provider prepares it. */
function writtenBy(body: EnvironmentBody, now: EnvironmentFields): EnvironmentFields {
	return {
		triggerRef: triggerRefInput(body.triggerRef),
		domain: body.domain ?? null,
		publicOrigin: canonicalOrigin(body.publicOrigin, now.publicOrigin),
		crossOrigins: body.crossOrigins ?? now.crossOrigins,
		namespaceId: body.namespaceId === undefined ? now.namespaceId : body.namespaceId,
		authoring: body.authoring ?? now.authoring,
		target: envelopeDigest(body.target),
		artifact: envelopeDigest(body.artifact),
	}
}

async function requireAppEnv(c: RequestKindContext, input: PutEnvironmentInput): Promise<AppEnvRow> {
	return (await c.repositories.registry.getAppEnv(input.appId, input.env)) ?? fail(404, 'app env not found')
}

/**
 * Refuse, when it is asked for, what the put would refuse before it calls the provider. An environment that does not
 * exist yet has nowhere for a request to wait, so its registration is never requested.
 */
async function admitEnvironmentPut(c: RequestActionContext, input: PutEnvironmentInput): Promise<void> {
	const appEnv = await requireAppEnv(c, input)
	const app = (await c.repositories.registry.getApp(input.appId)) ?? fail(404, 'app not found')
	const body = input.environment
	assertProxyDomain(body.domain)
	const triggerRef = triggerRefInput(body.triggerRef)
	assertCrossOrigins(body.crossOrigins ?? appEnvCrossOrigins(appEnv), body.domain ?? null)
	if (body.kind !== undefined && body.kind !== appEnv.kind) {
		fail(409, `environment ${input.env} is ${appEnv.kind}; an environment's kind is set when it is created`)
	}
	await admitAppEnvPut(c, app, input.env, appEnv, body, triggerRef)
	canonicalOrigin(body.publicOrigin, appEnv.public_origin)
}

const sameFields = (a: EnvironmentFields, b: EnvironmentFields, field: EnvironmentField): boolean =>
	canonicalJson(a[field]) === canonicalJson(b[field])

/**
 * The fields a put changes over what the environment holds: what the page shows before → after, and none for a put
 * that writes what is there. The target and artifact compare by digest with the stored ones, which the provider
 * prepared, so a provider that rewrites what the caller sent reads as a change.
 */
function changedFields(now: EnvironmentFields, after: EnvironmentFields): readonly EnvironmentField[] {
	return ENVIRONMENT_FIELDS.filter((field) => !sameFields(now, after, field))
}

export const putEnvironmentKind = requestKind<PutEnvironmentInput, z.infer<typeof environmentBefore>>({
	kind: 'apps.environments.put',
	category: 'registry',
	input: putEnvironmentInput,
	before: environmentBefore,
	coordinates: (input) => ({ appId: input.appId, env: input.env }),
	requesterAction: CONTROL_ACTIONS.APP_MANAGE,
	requesterAt: 'app',
	admit: admitEnvironmentPut,
	captureBefore: async (c, input) => {
		const appEnv = await requireAppEnv(c, input)
		return { generation: appEnv.generation, fields: fieldsOf(appEnv) }
	},
	unchanged: (input, before) => changedFields(before.fields, writtenBy(input.environment, before.fields)).length === 0,
	execute: async (c, input, execution) =>
		outcomeOf(async () => {
			const row = await putAppEnvUseCase(registryContext(c, execution), input.appId, input.env, input.environment)
			return {
				appId: row.appId,
				env: row.env,
				triggerRef: row.triggerRef,
				domain: row.domain,
				publicOrigin: row.publicOrigin,
				crossOrigins: row.crossOrigins,
				namespaceId: row.namespaceId,
			}
		}),
	// The put is one write fenced on the generation it read, so an unmoved generation means it did not land.
	follow: async (c, input, _execution, before) => {
		const appEnv = await c.repositories.registry.getAppEnv(input.appId, input.env)
		if (appEnv === null) return { state: 'failed', error: 'the environment no longer exists' }
		if (appEnv.generation === before.generation) {
			return { state: 'failed', error: 'the put did not land: the environment is as it was when the execution started; ask again' }
		}
		const now = fieldsOf(appEnv)
		const wanted = writtenBy(input.environment, before.fields)
		// The provider prepares the target and artifact it stores, so only the fields Control writes as asked are compared.
		const compared: readonly EnvironmentField[] = ['triggerRef', 'domain', 'publicOrigin', 'crossOrigins', 'namespaceId', 'authoring']
		return observed(compared.every((field) => sameFields(now, wanted, field)), { appId: input.appId, env: input.env })
	},
	describe: (input, before) => {
		const body = input.environment
		if (before === null) {
			// What the put writes, without what the environment holds now: the fields it names, and the two its absence clears.
			const named: [EnvironmentField, string | readonly string[] | boolean | null | undefined][] = [
				['triggerRef', triggerRefInput(body.triggerRef)],
				['domain', body.domain ?? null],
				['publicOrigin', body.publicOrigin],
				['crossOrigins', body.crossOrigins],
				['namespaceId', body.namespaceId],
				['authoring', body.authoring],
				['target', envelopeDigest(body.target)],
				['artifact', envelopeDigest(body.artifact)],
			]
			return {
				summary: [ownText(`Change what a deploy of ${input.appId}@${input.env} runs or where it is reached`)],
				facts: named.flatMap(([field, value]) =>
					value === undefined ? [] : [{ label: ENVIRONMENT_FIELD_LABELS[field], value: agentText(fieldText(value)) }]
				),
			}
		}
		const after = writtenBy(body, before.fields)
		const changed = changedFields(before.fields, after)
		return {
			summary: [ownText(`Change what a deploy of ${input.appId}@${input.env} runs or where it is reached`)],
			facts: [
				...changed.map((field) => ({
					label: ENVIRONMENT_FIELD_LABELS[field],
					value: agentText(`${fieldText(before.fields[field])} → ${fieldText(after[field])}`),
				})),
				...(changed.length === 0 ? [{ label: 'Changes', value: ownText('none: the put writes what the environment holds') }] : []),
				...(changed.includes('target') || changed.includes('artifact')
					? [{
						label: 'Provider',
						value: ownText('the provider prepares the target and artifact when the change is approved, which may create its services'),
					}]
					: []),
			],
		}
	},
})

function fieldText(value: string | readonly string[] | boolean | null): string {
	if (value === null) return 'none'
	if (typeof value === 'boolean') return value ? 'yes' : 'no'
	if (typeof value === 'string') return value
	return value.length === 0 ? 'none' : value.join(', ')
}

/**
 * The source and build fields a request may patch, as `apps.update` takes them. A `null` keeps a build field in
 * `apps.update`, so a request names its values only; `githubInstallationId: null` removes the binding.
 */
const appPatch = z.object({
	defaultBranch: z.string().min(1).optional(),
	workerDir: z.string().optional(),
	buildCmd: z.string().optional(),
	configPath: z.string().optional(),
	repoUrl: z.string().min(1).optional(),
	githubInstallationId: z.number().int().nonnegative().nullable().optional(),
	resolveInstallationId: z.boolean().optional(),
})
type AppPatch = z.infer<typeof appPatch>
type BuildField = 'defaultBranch' | 'workerDir' | 'buildCmd' | 'configPath'

const BUILD_FIELDS: readonly BuildField[] = ['defaultBranch', 'workerDir', 'buildCmd', 'configPath']

const BUILD_FIELD_LABELS: Readonly<Record<BuildField, string>> = {
	defaultBranch: 'Default branch',
	workerDir: 'Worker directory',
	buildCmd: 'Build command',
	configPath: 'Config path',
}

const updateAppInput = z.object({ appId: appIdField, app: appPatch })
type UpdateAppInput = z.infer<typeof updateAppInput>

/** Whether the patch names where the source comes from, which `apps.update` lets only global `app.manage` change. */
function namesSource(patch: AppPatch): boolean {
	return patch.repoUrl !== undefined || patch.githubInstallationId !== undefined || patch.resolveInstallationId === true
}

/**
 * What a patch binds: each field it names, as it was when the request was made, and the repository and its binding
 * where it names either; the page shows them before → after.
 */
const appBefore = z.object({
	defaultBranch: z.string().optional(),
	workerDir: z.string().nullable().optional(),
	buildCmd: z.string().nullable().optional(),
	configPath: z.string().nullable().optional(),
	repoUrl: z.string().optional(),
	github: z.object({ connectionId: z.string().nullable(), installationId: z.number().nullable() }).optional(),
})
type AppBefore = z.infer<typeof appBefore>

function appField(app: AppRow, field: BuildField): string | null {
	switch (field) {
		case 'defaultBranch':
			return app.default_branch
		case 'workerDir':
			return app.worker_dir
		case 'buildCmd':
			return app.build_cmd
		case 'configPath':
			return app.config_path
	}
}

async function appBeforeOf(c: RequestKindContext, input: UpdateAppInput): Promise<AppBefore> {
	const app = (await c.repositories.registry.getApp(input.appId)) ?? fail(404, 'app not found')
	const before: Record<string, string | null> = {}
	for (const field of BUILD_FIELDS) {
		if (input.app[field] !== undefined) before[field] = appField(app, field)
	}
	return {
		...appBefore.parse(before),
		...(input.app.repoUrl === undefined ? {} : { repoUrl: app.repo_url }),
		...(namesSource(input.app) ? { github: { connectionId: app.github_connection_id, installationId: app.github_installation_id } } : {}),
	}
}

function installationText(installationId: number | null | undefined): string {
	return installationId === null || installationId === undefined ? 'none' : `installation ${installationId}`
}

export const updateAppKind = requestKind<UpdateAppInput, AppBefore>({
	kind: 'apps.update',
	category: 'registry',
	input: updateAppInput,
	before: appBefore,
	coordinates: (input) => ({ appId: input.appId, env: ALL_ENVIRONMENTS }),
	requesterAction: CONTROL_ACTIONS.APP_MANAGE,
	requesterAt: (input) => namesSource(input.app) ? 'global' : 'app',
	admit: (_c, input) => {
		if (Object.keys(input.app).length === 0) fail(400, 'the request names no field of the application to change')
		return Promise.resolve()
	},
	captureBefore: appBeforeOf,
	unchanged: (input, before) => {
		const patch = input.app
		// Resolving the binding asks GitHub, so only the request's execution can tell whether it changes anything.
		return patch.resolveInstallationId !== true
			&& BUILD_FIELDS.every((field) => patch[field] === undefined || before[field] === patch[field])
			&& (patch.repoUrl === undefined || before.repoUrl === normalizeRepoUrl(patch.repoUrl))
			&& (patch.githubInstallationId === undefined || before.github?.installationId === patch.githubInstallationId)
	},
	execute: (c, input, execution) =>
		outcomeOf(async () => {
			const app = await updateAppUseCase(registryContext(c, execution), input.appId, input.app)
			return {
				appId: app.id,
				repoUrl: app.repoUrl,
				defaultBranch: app.defaultBranch,
				workerDir: app.workerDir,
				buildCmd: app.buildCmd,
				configPath: app.configPath,
				githubInstallationId: app.githubInstallationId,
			}
		}),
	follow: async (c, input) => {
		const app = await c.repositories.registry.getApp(input.appId)
		if (app === null) return { state: 'failed', error: 'the application no longer exists' }
		const patch = input.app
		const applied = BUILD_FIELDS.every((field) => patch[field] === undefined || appField(app, field) === patch[field])
			&& (patch.repoUrl === undefined || app.repo_url === normalizeRepoUrl(patch.repoUrl))
			&& (patch.githubInstallationId === undefined || app.github_installation_id === patch.githubInstallationId)
			&& (patch.resolveInstallationId !== true || app.github_installation_id !== null)
		return observed(applied, { appId: input.appId })
	},
	describe: (input, before) => {
		const patch = input.app
		const change = (label: string, from: string, to: string) => ({ label, value: agentText(before === null ? to : `${from} → ${to}`) })
		return {
			summary: [ownText(`Change how ${input.appId} is built, for every environment it deploys to`)],
			facts: [
				...(patch.repoUrl === undefined ? [] : [change('Repository', before?.repoUrl ?? '', normalizeRepoUrl(patch.repoUrl))]),
				...(patch.githubInstallationId === undefined
					? []
					: [change('GitHub binding', installationText(before?.github?.installationId), installationText(patch.githubInstallationId))]),
				...(patch.resolveInstallationId === true
					? [{ label: 'GitHub binding', value: ownText("bound to the repository owner's GitHub connection") }]
					: []),
				...BUILD_FIELDS.flatMap((field) => {
					const after = patch[field]
					if (after === undefined) return []
					return [change(BUILD_FIELD_LABELS[field], shown(before?.[field] ?? null), after)]
				}),
			],
		}
	},
})
