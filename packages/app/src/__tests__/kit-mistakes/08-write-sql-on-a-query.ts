import { app } from '../kit-fixture/src/app-kit'
import { OrgInput, Pipeline } from '../kit-fixture/src/schemas'

export const reports = app.group({ callers: ['human'] }, (r) => ({
	pipeline: r.query({
		input: OrgInput,
		output: Pipeline,
		access: { action: 'crm.read', in: 'org', from: 'orgId' },
		// mistake: a query runs read-only, so it declares sql: 'read'
		sql: 'write',
	})
		.handle(() => ({ rows: [] })),
}))
