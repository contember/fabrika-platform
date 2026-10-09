// SKELETON (opice-plan, phase 1): every step is pending. The scenario needs a second Notes fixture commit, the
// `notes-agent-change` seed below, which does not exist yet; opice-author fills the bodies once it does.
//
// The change an agent makes under the fabrika-app skill: one endpoint (`api.notes.rename`, `notes.write` `on` a note)
// and one table (`note_labels`, a child of `notes` with its policy and migration), regenerated tests included, and
// nothing loosened — no existing endpoint's requirement, caller list or access form changes, no role gains an action.

import { browserTest, invariant, step } from '@opice/harness'

const CONTROL_URL = process.env['FABRIKA_BROWSER_BASE_URL'] ?? 'http://control.fabrika.localhost:18080'

browserTest(
	{
		name: 'An agent adds an endpoint and a table to Notes, and the approval shows only what it adds',
		url: `${CONTROL_URL}/approvals`,
		feature: 'app-framework-template',
		seeds: ['local-stack', 'notes-agent-change'],
		roles: ['admin'],
		tier: 'extended',
	},
	async () => {
		await step('the deploy of the agent commit waits for approval', {
			intent: 'a commit that widens access on the protected prod environment parks its run instead of publishing it (ADR-0050)',
			hint: 'the seed pushes the agent commit through the notes connection webhook; open /approvals and find the parked Notes prod run of that commit',
			manual: 'Open Approvals. A Notes deploy to prod waits for your decision.',
		})
		await step('the access change lists the new endpoint, the new table policy and the new migration', {
			intent: 'the console tells a person in plain language what the commit lets someone do that the approved snapshot did not',
			hint:
				'open the run; assert the change names api.notes.rename with notes.write on a note, the note_labels policy and the new migration file, and nothing else',
			manual: 'Open the waiting deploy. The change lists one new endpoint, one new table and one new migration.',
		})
		await invariant.todo(
			'no existing endpoint, role or table policy appears as changed: the agent loosened nothing',
			'assert the change has no entry for api.notes.list/get/create/trash/remove, the files.attachments endpoints, the reader/author/editor roles or the notes policy',
		)
		await step('approving publishes the new endpoint at the proxy', {
			intent: 'only an approved snapshot reaches the proxy; after approval the endpoint table carries api.notes.rename',
			hint: 'approve; wait for the run to succeed; a POST /api/notes.rename by the admin on a seeded note answers 200 through the notes host',
			manual: 'Approve the deploy. When it finishes, renaming a note works.',
		})
		await invariant.todo(
			"a caller without notes.write in the note's workspace is refused by the new endpoint",
			'with a reader key of the workspace, POST /api/notes.rename answers 403 at the proxy and never reaches the application',
		)
	},
)
