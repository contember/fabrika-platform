// The application: its own procedure reads a note through the store; the file endpoints are the framework's.

import { implement } from '@fabrika/app/implement'
import type { DataLayer } from '@fabrika/db'
import { contract } from '../fabrika.contract'

export function filesApp(database: DataLayer) {
	return implement(contract, {
		database,
		deps: () => ({}),
		handlers: () => ({
			api: {
				notes: {
					get: ({ ctx }) => ({ id: ctx.target.value, title: 'a note' }),
				},
			},
		}),
	})
}
