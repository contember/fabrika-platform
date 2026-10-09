// Every form the static reader accepts, compiled both from source and from the evaluated module by
// `differential.test.ts`, which expects the same artifact.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { ById, Deleted, Draft, Event, Feedback, NewProject, NewTask, Patch, Push, Summary, Task } from './src/schemas/tasks'
import roles, { actions, READ } from './src/vocabulary'

const API = '/api'

const nightly = `0 2 * * *`

export const contract = defineContract({
	app: 'tasks',
	dimensions: {
		project: { creator: 'maintainer', members: { manage: 'tasks.admin', list: READ } },
		task: { in: 'project' },
	},
	actions,
	roles,
}, (c) => ({
	api: c.rpc(API, { callers: ['human', 'machine'] }, {
		tasks: {
			get: c.query({ input: ById, output: Task, access: { action: READ, on: 'task', from: 'id' } }),
			list: c.query({ output: z.array(Summary).max(500), access: { action: 'tasks.read', over: 'project' } }),
			events: c.query({ input: ById, output: z.array(Event), access: { action: 'tasks.read', on: 'task', from: 'id' } }),
			create: c.mutation({ input: NewTask, output: ById, access: { action: 'tasks.write', in: 'project', from: 'projectId' } }),
			draft: c.mutation({ input: Draft, output: ById, access: { action: 'tasks.write', in: 'project', from: 'projectId' } }),
			patch: c.mutation({ input: Patch, output: Summary, access: { action: 'tasks.write', over: 'project' } }),
			remove: c.mutation({ input: ById, output: Deleted, access: { action: 'tasks.delete', on: 'task', from: 'id' } }),
		},
		projects: {
			create: c.mutation({ input: NewProject, output: ById, access: { action: 'projects.create', creates: 'project' } }),
		},
		me: c.query({ input: null, output: z.strictObject({ ok: z.boolean() }), access: { member: true } }),
	}),
	shared: c.link('/share', {
		spa: 'dist/share',
		dimension: 'task',
		grants: ['tasks.read', 'tasks.write'],
		issuedBy: 'tasks.share',
		maxDays: 14,
		procedures: (l) => ({
			task: l.query({ output: Task, access: { action: 'tasks.read' } }),
			edit: { title: l.mutation({ input: z.strictObject({ title: z.string() }), output: ById, access: { action: 'tasks.write' } }) },
		}),
	}),
	console: c.spa('/console', { dir: 'dist/console', access: { action: 'tasks.read', over: 'project' } }),
	health: c.health('/healthz'),
	feedback: c.form('/feedback', { input: Feedback, appendTo: 'feedback', maxBytes: 8192 }),
	github: c.webhook('/hooks/github', {
		scheme: 'github-sha256',
		boundTo: 'project',
		actions: ['tasks.write'],
		input: Push,
		maxBytes: 2097152,
	}) satisfies object,
	app: c.spa('/', { dir: 'dist/app', access: { member: true } }),
	files: {
		attachments: c.files({
			owner: 'tasks',
			read: 'tasks.read',
			write: 'tasks.write',
			delete: 'tasks.delete',
			maxBytes: 10485760,
			types: ['image/png', 'application/pdf'],
			maxPerOwner: 20,
			link: true,
		}),
	},
	jobs: {
		cleanup: c.cron(nightly, { actions: ['tasks.delete'], scope: 'app', timeout: '15m', retries: 1 }),
		digest: c.cron('0 7 * * 1', { actions: ['tasks.read'], scope: 'project' }),
	},
	exports: {
		tasks: c.export({
			version: 2,
			consumers: ['billing', 'reports'],
			audience: 'any consumer user',
			procedures: { get: c.query({ input: ById, output: z.nullable(Summary), access: { action: 'tasks.read', over: 'project' } }) },
		}),
	},
	imports: {
		billing: {
			app: 'billing',
			export: 'plans',
			version: 1,
			digest: 'sha256:abc123',
			procedures: ['current'],
			usedBy: ['api.tasks.create'],
			timeoutMs: 2000,
		},
	},
	csp: {
		connectSrc: [{ origin: 'https://api.example.com', purpose: 'Status data' }],
		imgSrc: [{ origin: 'https://images.example.com', purpose: 'Avatars' }],
		frameAncestors: [{ origin: 'https://portal.example.com', purpose: 'The partner portal embeds the console' }],
	},
}))
