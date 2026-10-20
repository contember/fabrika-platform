// The change an agent makes under the fabrika-app skill (`packages/local-stack/fixtures/source/notes-agent-change.patch`):
// one endpoint (`api.notes.rename`, `notes.write` `on` a note) and one table (`note_labels`, a child of `notes` with its
// policy and migration), regenerated tests included, and nothing loosened — no existing endpoint's requirement, caller
// list or access form changes, no role gains an action. Renaming writes a note's title, so the notes policy accepts
// updates of `title`: that is the one line about an existing subject, and the approver reads it. A trigger keeps titles
// trimmed for every writer: database code is a step off the paved road, allowed and marked for closer review.
//
// The `notes-agent-change` seed (`@fabrika/local-stack`, run by `browser:up`) deployed and approved the pinned Notes
// commit and pushed the agent's commit through the notes connection webhook, where it waits for approval. Calls to
// Notes present `px_` service keys, which the proxy exchanges for tokens like any machine caller's.

import {
	followNotesDeploy,
	issueNotesKey,
	NOTES_AGENT_CHANGE_WORKSPACE,
	type NotesKey,
	readNotesAgentChange,
	waitForNotesDeploy,
} from '@fabrika/local-stack/browser-support'
import { browserTest, byRole, expect, getPage, invariant, step } from '@opice/harness'

const CONTROL_URL = process.env['FABRIKA_BROWSER_BASE_URL'] ?? 'http://control.fabrika.localhost:18080'
const NOTES_ORIGIN = 'http://notes.fabrika.localhost:18081'
const RENAMED_TITLE = `Renamed by the agent change ${Date.now()}`

const CLOSER_REVIEW = 'needs closer review'

/** What the approver reads: every line widens, and nothing else is listed; the database code needs closer review. */
const EXPECTED_CHANGES = [
	'New endpoint `api.notes.rename` (POST /api/notes.rename) for human, machine callers with `notes.write` (on `note`)',
	'New table policy `note_labels` read with `notes.read`',
	'Table `notes` accepts updates of `title`',
	'New migration `20261010090000_note_labels.sql`',
	'New migration `20261010090100_note_titles.sql`',
	`Migration \`20261010090100_note_titles.sql\` declares function \`notes_trim_title\` ${CLOSER_REVIEW}`,
	`Migration \`20261010090100_note_titles.sql\` declares trigger \`notes.notes_trim_title\` ${CLOSER_REVIEW}`,
]

/** Subjects the agent's change must not touch: the existing note and attachment endpoints, and the roles. */
const UNTOUCHED = [/api\.notes\.(list|get|create|trash|remove)\b/, /api\.attachments\./, /\b(reader|author|editor)\b/]

const keys: NotesKey[] = []
let writer: NotesKey | null = null
let noteId: string | null = null

async function call(key: NotesKey, procedure: string, input: unknown): Promise<Response> {
	return fetch(`${NOTES_ORIGIN}/api/${procedure}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${key.apiKey}`, 'content-type': 'application/json' },
		body: JSON.stringify(input),
		redirect: 'manual',
	})
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The `result` of a 200 answer of Notes. */
async function result(response: Response): Promise<Record<string, unknown>> {
	expect(response.status).toBe(200)
	const body: unknown = await response.json()
	if (!isRecord(body) || !isRecord(body['result'])) throw new Error('Notes answered without a result')
	return body['result']
}

async function readNote(key: NotesKey, id: string): Promise<{ title: unknown; version: unknown }> {
	const note = await result(await call(key, 'notes.get', { id }))
	return { title: note['title'], version: note['version'] }
}

/** A refusal the proxy wrote: its plain-text answer, which no Notes handler produces. */
async function expectProxyRefusal(response: Response): Promise<void> {
	expect(response.status).toBe(403)
	expect(response.headers.get('content-type')).toContain('text/plain')
	expect(await response.text()).toBe('forbidden')
}

async function issueKey(label: string, permissions: string[]): Promise<NotesKey> {
	const key = await issueNotesKey(`${label} ${Date.now()}`, permissions)
	keys.push(key)
	return key
}

function current<T>(value: T | null, what: string): T {
	if (value === null) throw new Error(`${what} was not created by an earlier step`)
	return value
}

function changeList(title: 'Widens access' | 'Narrows access' | 'Access unchanged') {
	return getPage().locator('section').filter({ has: byRole('heading', title, { exact: true, level: 2 }) }).locator('li')
}

browserTest(
	{
		name: 'An agent adds an endpoint and a table to Notes, and the approval shows only what it adds',
		url: `${CONTROL_URL}/approvals`,
		feature: 'app-framework-template',
		seeds: ['local-stack', 'notes-agent-change'],
		roles: ['admin'],
		tier: 'extended',
		// The approved deploy runs through the emulator, then the composed Notes container restarts on the new commit.
		timeout: 600_000,
		teardown: async () => {
			for (const key of keys.splice(0)) await key.revoke()
		},
	},
	async () => {
		const change = readNotesAgentChange()

		await step('the deploy of the agent commit waits for approval', {
			intent: 'a commit that widens access on the protected prod environment parks its run instead of publishing it (ADR-0050)',
			hint: 'the seed pushes the agent commit through the notes connection webhook; open /approvals and find the parked Notes prod run of that commit',
			manual: 'Open Approvals. A Notes deploy to prod waits for your decision.',
		}, async () => {
			await expect(byRole('heading', 'Approvals', { exact: true, level: 1 })).toBeVisible()
			const row = getPage().locator('tr').filter({ hasText: change.commitSha.slice(0, 7) })
			await expect(row).toHaveCount(1)
			await expect(row).toContainText('notes')
			await expect(row).toContainText('prod')
			await expect(row).toContainText('awaiting approval')
			await expect(row).toContainText(`${EXPECTED_CHANGES.length} widening`)
			await expect(row).not.toContainText('narrowing')
			await row.getByRole('link', { name: 'awaiting approval' }).click()
			await expect(getPage()).toHaveURL(`${CONTROL_URL}/approvals/${change.runId}`)
		})

		await step('the access change lists the new endpoint, the new table policy, the new migrations and the trigger', {
			intent: 'the console tells a person in plain language what the commit lets someone do that the approved snapshot did not',
			hint:
				'open the run; assert the change names api.notes.rename with notes.write on a note, the note_labels policy, both migration files and the trigger marked for closer review, and nothing else',
			manual:
				'Open the waiting deploy. The change lists one new endpoint, one new table, two new migrations, and the function and trigger marked "needs closer review".',
		}, async () => {
			await expect(byRole('heading', 'Access change of notes', { level: 1 })).toBeVisible()
			await expect(getPage().getByRole('link', { name: `run ${change.baselineRunId.slice(0, 8)}` })).toBeVisible()
			await expect(changeList('Widens access')).toHaveText(EXPECTED_CHANGES, { useInnerText: true })
			await expect(changeList('Narrows access')).toHaveCount(0)
			await expect(changeList('Access unchanged')).toHaveCount(0)
		})

		await invariant('no existing endpoint, role or table policy appears as changed: the agent loosened nothing', async () => {
			const lines = await changeList('Widens access').allInnerTexts()
			for (const line of lines) {
				for (const subject of UNTOUCHED) expect(line).not.toMatch(subject)
			}
			// The notes policy changes by exactly the column the rename writes; its scope, actions and reads stay.
			expect(lines.filter((line) => line.includes('`notes`'))).toEqual(['Table `notes` accepts updates of `title`'])
		})

		await step('approving publishes the new endpoint at the proxy', {
			intent: 'only an approved snapshot reaches the proxy; after approval the endpoint table carries api.notes.rename',
			hint: 'approve; wait for the run to succeed; a POST /api/notes.rename by the admin on a seeded note answers 200 through the notes host',
			manual: 'Approve the deploy. When it finishes, renaming a note works.',
		}, async () => {
			const key = await issueKey('agent change writer', ['notes.read', 'notes.write'])
			writer = key
			const created = await result(await call(key, 'notes.create', { workspaceId: NOTES_AGENT_CHANGE_WORKSPACE, title: 'Before the agent change' }))
			if (typeof created['id'] !== 'string') throw new Error('notes.create answered no id')
			const id = created['id']
			noteId = id
			const before = await readNote(key, id)
			// Before the approval the proxy serves the approved baseline's table, which has no rename.
			await expectProxyRefusal(await call(key, 'notes.rename', { id, title: RENAMED_TITLE, expectVersion: before.version }))

			await byRole('button', 'Approve and deploy', { exact: true }).click()
			await expect(byRole('heading', 'Approved', { exact: true, level: 4 })).toBeVisible()
			await waitForNotesDeploy(change.runId)
			expect(await followNotesDeploy({ browser: true })).toBe(change.commitSha)
			await getPage().reload()
			await expect(getPage().locator('.page-head')).toContainText('succeeded')

			await result(await call(key, 'notes.rename', { id, title: RENAMED_TITLE, expectVersion: before.version }))
			expect((await readNote(key, id)).title).toBe(RENAMED_TITLE)
		})

		await invariant("a caller without notes.write in the note's workspace is refused by the new endpoint", async () => {
			const reader = await issueKey('agent change reader', ['notes.read'])
			const id = current(noteId, 'the renamed note')
			const { version } = await readNote(reader, id)
			await expectProxyRefusal(await call(reader, 'notes.rename', { id, title: 'Renamed by a reader', expectVersion: version }))
			// The refusal never reached Notes: the note keeps the title and version the writer left.
			expect(await readNote(current(writer, 'the writer key'), id)).toEqual({ title: RENAMED_TITLE, version })
		})
	},
)
