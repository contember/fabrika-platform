import { app } from '../kit-fixture/src/app-kit'
import { Company, OrgInput } from '../kit-fixture/src/schemas'

export const audit = app.group({ callers: ['human'] }, (r) => ({
	first: r.query({
		input: OrgInput,
		output: Company,
		access: { action: 'crm.read', in: 'org', from: 'orgId' },
		// mistake: invoices is not a table of src/db/tables.ts, beside one that is
		unscoped: { companies: 'read', invoices: 'read' },
	})
		.handle(() => ({ id: '', name: '' })),
}))
