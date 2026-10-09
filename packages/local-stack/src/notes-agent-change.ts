// The `notes-agent-change` browser seed: Notes deployed and approved at the pinned application commit, then the agent
// change commit (`fixtures/source/notes-agent-change.patch`) pushed through the notes connection's scoped webhook, where
// it waits for approval (ADR-0050). `tests/browser/notes-agent-adds-endpoint-and-table.test.ts` reads the change here,
// decides it in the console, and calls the Notes endpoints with the keys below. Keys are secrets and never printed.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { approveInConsole, type IamLogin } from './console-approval'
import { LOCAL_SOURCE_FIXTURE_DIRECTORY } from './local-source-contract'
import { loadLocalSourceFixtures } from './local-source-fixtures/fixture'
import { requireMachineKey } from './machine-key'
import {
	CONTROL_ORIGIN,
	ensureNamespace,
	ensureNotesApp,
	envValue,
	requestJson,
	triggerByScopedWebhook,
	waitForParkOrProvider,
	waitForRunSuccess,
} from './notes-deploy'
import { followNotesDeploy } from './notes-follow'
import { LOCAL_NOTES_IAM_APP_ID, STATE_DIR } from './prepare'
import { keyPrincipalSchema } from './smoke-schemas'

const IAM_ORIGIN = 'http://iam.fabrika.localhost:18080'
const NOTES_AGENT_CHANGE_FILE = 'notes-agent-change.json'
/** The workspace the keys below are granted in; the scenario's notes lie in it. */
export const NOTES_AGENT_CHANGE_WORKSPACE = 'agent-change'

const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/)
const notesAgentChangeSchema = z.object({
	version: z.literal(1),
	/** The parked run of the agent change commit. */
	runId: z.string().min(1),
	commitSha: commitShaSchema,
	/** The approved deploy the change is compared with. */
	baselineRunId: z.string().min(1),
	baselineCommitSha: commitShaSchema,
}).strict()

export type NotesAgentChange = z.infer<typeof notesAgentChangeSchema>

export function readNotesAgentChange(): NotesAgentChange {
	return notesAgentChangeSchema.parse(JSON.parse(readFileSync(resolve(STATE_DIR, NOTES_AGENT_CHANGE_FILE), 'utf8')))
}

/** Deploy the baseline, approved by the signed-in admin, then park the agent change. */
export async function seedNotesAgentChange(login: IamLogin): Promise<void> {
	const fixtures = await loadLocalSourceFixtures(resolve(STATE_DIR, LOCAL_SOURCE_FIXTURE_DIRECTORY))
	const machineKey = requireMachineKey()
	const webhookSecret = envValue(resolve(STATE_DIR, 'control.env'), 'GITHUB_WEBHOOK_SECRET')
	await ensureNamespace(machineKey)
	await ensureNotesApp(machineKey, fixtures)

	const baselineRunId = await triggerByScopedWebhook(webhookSecret, fixtures.application.commitSha)
	if ((await waitForParkOrProvider(machineKey, baselineRunId)).status === 'awaiting_approval') {
		await approveInConsole(CONTROL_ORIGIN, baselineRunId, login)
	}
	await waitForRunSuccess(machineKey, baselineRunId)
	await followNotesDeploy({ browser: true })

	const runId = await triggerByScopedWebhook(webhookSecret, fixtures.agentChange.commitSha)
	const parked = await waitForParkOrProvider(machineKey, runId)
	if (parked.status !== 'awaiting_approval') {
		throw new Error(`the agent change deploy ${runId} did not wait for approval: ${String(parked.status)}`)
	}
	const seed: NotesAgentChange = {
		version: 1,
		runId,
		commitSha: fixtures.agentChange.commitSha,
		baselineRunId,
		baselineCommitSha: fixtures.application.commitSha,
	}
	await Bun.write(resolve(STATE_DIR, NOTES_AGENT_CHANGE_FILE), `${JSON.stringify(seed, null, '\t')}\n`)
	console.info(`Notes agent change ${seed.commitSha} waits for approval as run ${runId}`)
}

/** Wait until a Notes deploy succeeded; any other end throws. */
export async function waitForNotesDeploy(runId: string): Promise<void> {
	await waitForRunSuccess(requireMachineKey(), runId)
}

export interface NotesKey {
	readonly apiKey: string
	revoke(): Promise<void>
}

/** A service key of `notes@prod` holding `permissions` in the scenario's workspace, issued through IAM's admin surface. */
export async function issueNotesKey(label: string, permissions: readonly string[]): Promise<NotesKey> {
	const provisioningKey = envValue(resolve(STATE_DIR, 'iam.env'), 'FABRIKA_IAM_PROVISIONING_KEY')
	const { apiKey, principalId } = keyPrincipalSchema.parse(
		await requestJson(IAM_ORIGIN, '/admin/api-keys', {
			bearer: provisioningKey,
			body: {
				label,
				type: 'service',
				app: LOCAL_NOTES_IAM_APP_ID,
				permissions,
				scopeType: 'workspace',
				scopeValue: NOTES_AGENT_CHANGE_WORKSPACE,
			},
		}),
	)
	return {
		apiKey,
		revoke: async () => {
			await requestJson(IAM_ORIGIN, `/admin/api-keys/${principalId}`, { bearer: provisioningKey, method: 'DELETE' })
		},
	}
}
