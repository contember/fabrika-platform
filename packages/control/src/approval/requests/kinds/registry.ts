// The `registry` kinds (ADR-0083 §1, §8; ADR-0050 §4): what a deploy of an environment runs and where it is reached.
// `apps.environments.put` here takes the trigger ref, the domain, the public origin and the cross-origin list of an
// environment that exists, and binds its `generation`; the target, the artifact and the namespace are the provider's
// (`prepareRegistration` creates provider services), so a provider that prepares its registrations cannot take this
// request in this release. `apps.update` is a patch of the source and build fields with the value each held when the
// request was made, shown before → after. Each executes through the use case its procedure runs, as the approver.

import { ALL_ENVIRONMENTS, CONTROL_ACTIONS, type PutAppEnvRequest } from '@fabrika/control-contract'
import { z } from 'zod'
import { fail } from '../../../api/domain'
import { parseStoredEnvelope } from '../../../api/provider-envelope'
import { updateAppUseCase } from '../../../api/registry/apps'
import { putAppEnvUseCase } from '../../../api/registry/environments'
import { assertCrossOrigins, assertProxyDomain, canonicalOrigin, triggerRefInput } from '../../../api/registry/validation'
import { appEnvCrossOrigins, type AppEnvRow, type AppRow } from '../../../db'
import { type RequestActionContext, requestKind, type RequestKindContext } from '../kind'
import { agentText, appIdField, envField, observed, outcomeOf, ownText, registryContext, shown } from './shared'

const environmentFields = z.object({
	domain: z.string().min(1).nullable().optional(),
	publicOrigin: z.string().min(1).nullable().optional(),
	crossOrigins: z.array(z.string()).optional(),
	triggerRef: z.string().min(1).nullable().optional(),
})
type EnvironmentFields = z.infer<typeof environmentFields>

const putEnvironmentInput = z.object({ appId: appIdField, env: envField, environment: environmentFields })
type PutEnvironmentInput = z.infer<typeof putEnvironmentInput>

/** What an environment write binds: its `generation`, and the fields the request names as they are now, for the page. */
const environmentBefore = z.object({
	generation: z.number(),
	fields: z.object({
		domain: z.string().nullable().optional(),
		publicOrigin: z.string().nullable().optional(),
		crossOrigins: z.array(z.string()).optional(),
		triggerRef: z.string().nullable().optional(),
	}),
})
type EnvironmentBefore = z.infer<typeof environmentBefore>

const ENVIRONMENT_FIELDS: readonly (keyof EnvironmentFields)[] = ['triggerRef', 'domain', 'publicOrigin', 'crossOrigins']

const ENVIRONMENT_FIELD_LABELS: Readonly<Record<keyof EnvironmentFields, string>> = {
	triggerRef: 'Trigger ref',
	domain: 'Domain',
	publicOrigin: 'Public origin',
	crossOrigins: 'Cross origins',
}

/** The named fields of an environment as it stands, keyed as the request names them. */
function environmentFieldsOf(appEnv: AppEnvRow, named: EnvironmentFields): EnvironmentFields {
	return {
		...(named.triggerRef === undefined ? {} : { triggerRef: appEnv.trigger_ref }),
		...(named.domain === undefined ? {} : { domain: appEnv.domain }),
		...(named.publicOrigin === undefined ? {} : { publicOrigin: appEnv.public_origin }),
		...(named.crossOrigins === undefined ? {} : { crossOrigins: appEnvCrossOrigins(appEnv) }),
	}
}

async function requireAppEnv(c: RequestKindContext, input: PutEnvironmentInput): Promise<AppEnvRow> {
	return (await c.repositories.registry.getAppEnv(input.appId, input.env)) ?? fail(404, 'app env not found')
}

/** The put the use case takes: the request's fields over the environment as it stands, its provider envelopes kept. */
function putOf(appEnv: AppEnvRow, fields: EnvironmentFields): PutAppEnvRequest {
	return {
		domain: fields.domain === undefined ? appEnv.domain : fields.domain,
		triggerRef: fields.triggerRef === undefined ? appEnv.trigger_ref : fields.triggerRef,
		...(fields.publicOrigin === undefined ? {} : { publicOrigin: fields.publicOrigin }),
		...(fields.crossOrigins === undefined ? {} : { crossOrigins: fields.crossOrigins }),
		target: parseStoredEnvelope(appEnv.provider_target_json, `app env ${appEnv.app_id}/${appEnv.env} target`),
		artifact: parseStoredEnvelope(appEnv.provider_artifact_json, `app env ${appEnv.app_id}/${appEnv.env} artifact`),
	}
}

/** Refuse what this release cannot execute as a request, and a field the use case would refuse. */
async function admitEnvironmentPut(c: RequestActionContext, input: PutEnvironmentInput): Promise<void> {
	const fields = input.environment
	if (Object.keys(fields).length === 0) fail(400, 'the request names no field of the environment to change')
	if (c.provider.namespaces?.prepareRegistration !== undefined) {
		fail(
			400,
			`an environment write is not requestable yet on ${c.provider.id}: the provider prepares every registration, which reaches outside `
				+ 'Control, and this release routes only writes Control makes itself through a request',
		)
	}
	const appEnv = await requireAppEnv(c, input)
	const put = putOf(appEnv, fields)
	assertProxyDomain(put.domain)
	triggerRefInput(put.triggerRef)
	canonicalOrigin(put.publicOrigin, appEnv.public_origin)
	assertCrossOrigins(put.crossOrigins ?? appEnvCrossOrigins(appEnv), put.domain ?? null)
}

export const putEnvironmentKind = requestKind<PutEnvironmentInput, EnvironmentBefore>({
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
		return { generation: appEnv.generation, fields: environmentFieldsOf(appEnv, input.environment) }
	},
	execute: async (c, input, execution) => {
		const appEnv = await c.repositories.registry.getAppEnv(input.appId, input.env)
		if (appEnv === null) return { state: 'failed', error: 'the environment no longer exists' }
		return outcomeOf(async () => {
			const row = await putAppEnvUseCase(registryContext(c, execution), input.appId, input.env, putOf(appEnv, input.environment))
			return {
				appId: row.appId,
				env: row.env,
				triggerRef: row.triggerRef,
				domain: row.domain,
				publicOrigin: row.publicOrigin,
				crossOrigins: row.crossOrigins,
			}
		})
	},
	follow: async (c, input) => {
		const appEnv = await c.repositories.registry.getAppEnv(input.appId, input.env)
		if (appEnv === null) return { state: 'failed', error: 'the environment no longer exists' }
		const now = environmentFieldsOf(appEnv, input.environment)
		const wanted = input.environment
		const applied = (wanted.triggerRef === undefined || now.triggerRef === triggerRefInput(wanted.triggerRef))
			&& (wanted.domain === undefined || now.domain === wanted.domain)
			&& (wanted.publicOrigin === undefined || now.publicOrigin === canonicalOrigin(wanted.publicOrigin, null))
			&& (wanted.crossOrigins === undefined || JSON.stringify(now.crossOrigins) === JSON.stringify(wanted.crossOrigins))
		return observed(applied, { appId: input.appId, env: input.env })
	},
	describe: (input, before) => ({
		summary: [ownText(`Change what a deploy of ${input.appId}@${input.env} runs or where it is reached`)],
		facts: ENVIRONMENT_FIELDS.flatMap((field) => {
			const after = input.environment[field]
			if (after === undefined) return []
			const text = before === null ? fieldText(after) : `${fieldText(before.fields[field])} → ${fieldText(after)}`
			return [{ label: ENVIRONMENT_FIELD_LABELS[field], value: agentText(text) }]
		}),
	}),
})

function fieldText(value: string | readonly string[] | null | undefined): string {
	if (value === undefined || value === null) return 'none'
	if (typeof value === 'string') return value
	return value.length === 0 ? 'none' : value.join(', ')
}

/**
 * The source and build fields a request may patch. A `null` keeps the stored value in `apps.update`, so a request names
 * values only. The repository and its GitHub binding are not requestable: moving the repository needs global
 * `app.manage`, which a request's requester, holding the action at the application, does not prove.
 */
const appPatch = z.object({
	defaultBranch: z.string().min(1).optional(),
	workerDir: z.string().optional(),
	buildCmd: z.string().optional(),
	configPath: z.string().optional(),
})
type AppPatch = z.infer<typeof appPatch>
type AppPatchField = keyof AppPatch

const APP_FIELDS: readonly AppPatchField[] = ['defaultBranch', 'workerDir', 'buildCmd', 'configPath']

const APP_FIELD_LABELS: Readonly<Record<AppPatchField, string>> = {
	defaultBranch: 'Default branch',
	workerDir: 'Worker directory',
	buildCmd: 'Build command',
	configPath: 'Config path',
}

const updateAppInput = z.object({ appId: appIdField, app: appPatch })
type UpdateAppInput = z.infer<typeof updateAppInput>

/** What a patch binds: each field it names, as it was when the request was made; the page shows it before → after. */
const appBefore = z.object({
	defaultBranch: z.string().optional(),
	workerDir: z.string().nullable().optional(),
	buildCmd: z.string().nullable().optional(),
	configPath: z.string().nullable().optional(),
})
type AppBefore = z.infer<typeof appBefore>

function appField(app: AppRow, field: AppPatchField): string | null {
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
	for (const field of APP_FIELDS) {
		if (input.app[field] !== undefined) before[field] = appField(app, field)
	}
	return appBefore.parse(before)
}

export const updateAppKind = requestKind<UpdateAppInput, AppBefore>({
	kind: 'apps.update',
	category: 'registry',
	input: updateAppInput,
	before: appBefore,
	coordinates: (input) => ({ appId: input.appId, env: ALL_ENVIRONMENTS }),
	requesterAction: CONTROL_ACTIONS.APP_MANAGE,
	requesterAt: 'app',
	admit: (_c, input) => {
		if (Object.keys(input.app).length === 0) fail(400, 'the request names no field of the application to change')
		return Promise.resolve()
	},
	captureBefore: appBeforeOf,
	execute: (c, input, execution) =>
		outcomeOf(async () => {
			const app = await updateAppUseCase(registryContext(c, execution), input.appId, input.app)
			return { appId: app.id, defaultBranch: app.defaultBranch, workerDir: app.workerDir, buildCmd: app.buildCmd, configPath: app.configPath }
		}),
	follow: async (c, input) => {
		const app = await c.repositories.registry.getApp(input.appId)
		if (app === null) return { state: 'failed', error: 'the application no longer exists' }
		const applied = APP_FIELDS.every((field) => input.app[field] === undefined || appField(app, field) === input.app[field])
		return observed(applied, { appId: input.appId })
	},
	describe: (input, before) => ({
		summary: [ownText(`Change how ${input.appId} is built, for every environment it deploys to`)],
		facts: APP_FIELDS.flatMap((field) => {
			const after = input.app[field]
			if (after === undefined) return []
			return [{ label: APP_FIELD_LABELS[field], value: agentText(before === null ? after : `${shown(before[field] ?? null)} → ${after}`) }]
		}),
	}),
})
