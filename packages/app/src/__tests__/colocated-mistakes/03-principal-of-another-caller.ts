import { app } from '../kit-fixture/src/app-kit'
import { ById, Me } from '../kit-fixture/src/schemas'

export const sync = app.group({ callers: ['machine'] }, (r) => ({
	whoami: r.query({ input: ById, output: Me, access: { action: 'crm.read', on: 'deal', from: 'id' } })
		.handle(({ ctx }) => {
			// mistake: a machine group's principal is a service, never a user
			const kind: 'user' = ctx.principal.kind
			return { label: kind }
		}),
}))
