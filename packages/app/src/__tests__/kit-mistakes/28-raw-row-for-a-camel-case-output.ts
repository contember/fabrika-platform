import { z } from 'zod/v4'
import { app } from '../kit-fixture/src/app-kit'
import { ById, Stage } from '../kit-fixture/src/schemas'

const DealView = z.strictObject({ id: z.uuid(), companyId: z.string(), title: z.string(), stage: Stage })

export const deals = app.group({ callers: ['human'] }, (r) => ({
	// mistake: the row's company_id is the output's companyId; fromRow maps it
	view: r.query({ input: ById, output: DealView, access: { action: 'crm.read', on: 'deal', from: 'id' } })
		.handle(({ ctx }) => ctx.db.target.get()),
}))
