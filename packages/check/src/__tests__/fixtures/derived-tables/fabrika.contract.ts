// The contract over the derived tables of src/db/tables.ts.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { vocabulary } from './src/vocabulary'

export const Task = z.strictObject({ id: z.uuid(), title: z.string() })
export const NewTask = z.strictObject({ projectId: z.string(), title: z.string().min(1) })

export const contract = defineContract(vocabulary, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		tasks: {
			get: c.query({ input: z.strictObject({ id: z.uuid() }), output: Task, access: { action: 'tasks.read', on: 'task', from: 'id' } }),
			create: c.mutation({ input: NewTask, output: Task, access: { action: 'tasks.write', in: 'project', from: 'projectId' } }),
		},
	}),
	health: c.health('/healthz'),
}))
