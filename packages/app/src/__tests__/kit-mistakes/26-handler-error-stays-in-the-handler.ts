import { app } from '../kit-fixture/src/app-kit'
import { Me } from '../kit-fixture/src/schemas'

const me = app.group({ callers: ['human'] }, (r) => ({
	whoami: r.query({ output: Me, access: { member: true } })
		.handle(({ ctx }) => ({
			// mistake: a typo in the handler body; the mount below does not ask for .handle(…)
			label: ctx.principal.lable,
		})),
}))

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { me }),
}))
