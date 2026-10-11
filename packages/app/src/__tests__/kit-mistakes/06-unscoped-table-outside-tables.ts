import { app } from '../kit-fixture/src/app-kit'
import { Company, OrgInput } from '../kit-fixture/src/schemas'

export const audit = app.group({ callers: ['human'] }, (r) => ({
	first: r.query({
		input: OrgInput,
		output: Company,
		access: { action: 'crm.read', in: 'org', from: 'orgId' },
		// mistake: unscoped names only tables of src/db/tables.ts, and there is no invoices table
		unscoped: { invoices: 'read' },
	})
		.handle(() => ({ id: '', name: '' })),
}))
