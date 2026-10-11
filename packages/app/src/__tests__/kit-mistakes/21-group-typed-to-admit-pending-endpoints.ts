import type { Group, GroupInput } from '@fabrika/app/contract'
import { app } from '../kit-fixture/src/app-kit'
import { Ok } from '../kit-fixture/src/schemas'

const group: Group<readonly ['human'], GroupInput> = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ output: Ok, access: { member: true } }),
}))

export const contract = app.contract((c) => ({
	// mistake: a group whose type admits an endpoint without .handle cannot be served
	api: c.rpc('/api', { group }),
}))
