// The console's sample data on top of `local:smoke`: a second Notes environment, secrets in each, a changed policy on
// `prod`, a deploy waiting for a person and a plan of the same change waiting for one. It writes through Control (as the
// signed-in person, the machine key for the namespace and the plan, the GitHub webhook for the parked deploy); a rerun
// adds nothing that is already there.

import { type ApprovalPolicy, type ApprovalSettings, STRICT_POLICY, STRICT_SETTINGS } from '@fabrika/control-contract'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { consoleRpc, signInToConsole } from './console-approval'
import { LOCAL_SOURCE_FIXTURE_DIRECTORY } from './local-source-contract'
import { loadLocalSourceFixtures } from './local-source-fixtures/fixture'
import { requireMachineKey } from './machine-key'
import {
	controlRequest,
	ensureNamespace,
	envValue,
	type LocalNamespace,
	NOTES_APP_ID,
	notesEnvironmentEnvelopes,
	triggerByScopedWebhook,
	waitForParkOrProvider,
	waitForRunSuccess,
} from './notes-deploy'
import { CONTROL_ORIGIN, NOTES_TEST_ORIGIN } from './ports'
import { STATE_DIR } from './prepare'

const TEST_NAMESPACE: LocalNamespace = { id: 'apps-test', env: 'test' }

/** `prod`'s policy: the strict preset with four changes, so the console has a changed rule of each kind to show. */
const PROD_POLICY: ApprovalPolicy = { ...STRICT_POLICY, secrets: 'off', 'role-added': 'person' }
const PROD_SETTINGS: ApprovalSettings = {
	...STRICT_SETTINGS,
	requestTtlHours: 72,
	approvers: { ...STRICT_SETTINGS.approvers, 'deletes-data': 2 },
}

// On Zerops a secret's value is the provider's, which takes an environment: no secret is in the all-environments layer.
const SECRETS: readonly { readonly name: string; readonly env: string }[] = [
	{ name: 'SESSION_SIGNING_KEY', env: 'prod' },
	{ name: 'SESSION_SIGNING_KEY', env: 'test' },
	{ name: 'PAYMENT_API_KEY', env: 'prod' },
]

const environmentsSchema = z.object({
	items: z.array(z.object({
		env: z.string(),
		protected: z.boolean(),
		publishedRunId: z.string().nullable(),
		approvalPolicy: z.record(z.string()),
		approvalSettings: z.unknown(),
	})),
})
const namedValuesSchema = z.object({ items: z.array(z.object({ name: z.string(), env: z.string().nullable() })) })
const approvalsSchema = z.object({ items: z.array(z.object({ run: z.object({ appId: z.string(), env: z.string() }) })) })
const runSchema = z.object({ id: z.string() })
const plansSchema = z.object({ items: z.array(z.object({ appId: z.string(), env: z.string(), commitSha: z.string() })) })

const main = async (): Promise<void> => {
	const fixtures = await loadLocalSourceFixtures(resolve(STATE_DIR, LOCAL_SOURCE_FIXTURE_DIRECTORY))
	const machineKey = requireMachineKey()
	const webhookSecret = envValue(resolve(STATE_DIR, 'control.env'), 'GITHUB_WEBHOOK_SECRET')
	const cookie = await signInToConsole(CONTROL_ORIGIN)
	const asPerson = (method: string, input: unknown) => consoleRpc(CONTROL_ORIGIN, cookie, method, input)
	const environments = async () => environmentsSchema.parse(await asPerson('apps.environments.list', { appId: NOTES_APP_ID })).items

	const prod = (await environments()).find((environment) => environment.env === 'prod')
	if (prod === undefined || prod.publishedRunId === null) throw new Error('Notes prod has published nothing: run `bun run local:smoke` first')

	await ensureNamespace(machineKey, TEST_NAMESPACE)
	if (!(await environments()).some((environment) => environment.env === TEST_NAMESPACE.env)) {
		await asPerson('apps.environments.put', {
			appId: NOTES_APP_ID,
			env: TEST_NAMESPACE.env,
			environment: {
				domain: 'notes-test.fabrika.localhost',
				publicOrigin: NOTES_TEST_ORIGIN,
				triggerRef: null,
				namespaceId: TEST_NAMESPACE.id,
				...await notesEnvironmentEnvelopes(fixtures, TEST_NAMESPACE.env),
			},
		})
	}
	if ((await environments()).find((environment) => environment.env === TEST_NAMESPACE.env)?.publishedRunId === null) {
		const run = runSchema.parse(await asPerson('deploy', { appId: NOTES_APP_ID, env: TEST_NAMESPACE.env }))
		await waitForRunSuccess(machineKey, run.id)
	}

	const secrets = namedValuesSchema.parse(await asPerson('apps.secrets.list', { appId: NOTES_APP_ID })).items
	for (const secret of SECRETS) {
		if (secrets.some((held) => held.name === secret.name && held.env === secret.env)) continue
		await asPerson('apps.secrets.put', { appId: NOTES_APP_ID, secret: { name: secret.name, env: secret.env, value: randomUUID() } })
	}

	if (!isDeepStrictEqual(prod.approvalPolicy, PROD_POLICY) || !isDeepStrictEqual(prod.approvalSettings, PROD_SETTINGS)) {
		await asPerson('apps.environments.protect', { appId: NOTES_APP_ID, env: 'prod', protected: true, policy: PROD_POLICY, settings: PROD_SETTINGS })
	}

	const waiting = approvalsSchema.parse(await asPerson('approvals.list', undefined)).items
	if (!waiting.some((approval) => approval.run.appId === NOTES_APP_ID && approval.run.env === 'prod')) {
		const runId = await triggerByScopedWebhook(webhookSecret, fixtures.agentChange.commitSha)
		const parked = await waitForParkOrProvider(machineKey, runId)
		if (parked.status !== 'awaiting_approval') throw new Error(`the agent change deploy ${runId} did not wait for approval: ${String(parked.status)}`)
	}

	// The key plans the same change, as an agent asks ahead of its deploy; a person decides it in the console.
	const plans = plansSchema.parse(await asPerson('approvals.plans.list', undefined)).items
	const planned = { appId: NOTES_APP_ID, env: 'prod', commitSha: fixtures.agentChange.commitSha }
	if (!plans.some((plan) => isDeepStrictEqual({ appId: plan.appId, env: plan.env, commitSha: plan.commitSha }, planned))) {
		await controlRequest('approvals.plans.create', machineKey, planned)
	}
	console.info(
		'Console seed: Notes has prod and test, secrets in each, a changed approval policy on prod, a deploy and a plan waiting for approval',
	)
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : 'the console seed failed')
		process.exit(1)
	})
}
