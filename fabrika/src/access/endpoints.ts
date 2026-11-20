import { app } from '../app-kit'
import { Me, Readable } from '../schemas'
import { readable } from './logic'

export const access = app.group({ callers: ['human', 'machine'] }, (r) => ({
	me: r.query({ output: Me, access: { member: true } })
		.handle(({ ctx }) => ({ id: ctx.principal.id, label: ctx.principal.label })),
	projects: r.query({ output: Readable, access: { action: 'example.read', over: 'project' } })
		.handle(({ ctx }) => readable(ctx.within.values)),
	organizations: r.query({ output: Readable, access: { action: 'example.read', over: 'organization' } })
		.handle(({ ctx }) => readable(ctx.within.values)),
}))
