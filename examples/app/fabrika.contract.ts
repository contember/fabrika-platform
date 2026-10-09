// The example application's whole access surface: who may call what. The proxy enforces it from the endpoint table
// the deployer compiles out of this file; `src/app.ts` implements it. Cloudflare has no `@fabrika/db` yet, so every
// endpoint here answers from the caller's own grants and reads no application data.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const Me = z.strictObject({ id: z.string(), label: z.string() })
export const Readable = z.strictObject({ all: z.boolean(), values: z.array(z.string()) })

export const contract = defineContract({
	app: 'example-app',
	// Two independent dimensions; IAM stores their values and never interprets them.
	dimensions: {
		organization: {},
		project: {},
	},
	actions: {
		'example.read': 'Read example data',
		'example.view': 'View the example surface',
		'example.settings.update': 'Update example settings',
	},
	roles: {
		viewer: { grants: ['example.read', 'example.view'] },
		editor: { grants: ['example.read', 'example.view', 'example.settings.update'] },
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human', 'machine'] }, {
		me: c.query({ output: Me, access: { member: true } }),
		projects: {
			readable: c.query({ output: Readable, access: { action: 'example.read', over: 'project' } }),
		},
		organizations: {
			readable: c.query({ output: Readable, access: { action: 'example.read', over: 'organization' } }),
		},
	}),
	health: c.health('/healthz'),
}))
