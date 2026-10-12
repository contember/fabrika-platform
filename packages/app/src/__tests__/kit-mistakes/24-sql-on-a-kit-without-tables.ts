import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { z } from 'zod/v4'

const app = defineApp(defineVocabulary({ app: 'plain', dimensions: { project: {} }, actions: { 'projects.read': 'Read' }, roles: {} }))

export const projects = app.group({ callers: ['human'] }, (r) => ({
	// mistake: a kit without tables declares sql, which runs on @fabrika/db
	count: r.query({ output: z.strictObject({ n: z.int() }), access: { action: 'projects.read', over: 'project' }, sql: 'read' })
		.handle(() => ({ n: 0 })),
}))
