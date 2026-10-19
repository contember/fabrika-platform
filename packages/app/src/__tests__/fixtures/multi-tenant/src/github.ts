// The GitHub webhook as a staged kit serves it, bound to a workspace by `webhooks.connect`, a mutation that declares
// `binds`. Each boot reaches the `Seen` its environment names.

import { defineApp, WebhookSecret } from '@fabrika/app/contract'
import { type ContractImplementation, defineDeps, serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { z } from 'zod/v4'
import { Push } from '../fabrika.contract'
import type { Seen } from './app'
import { tables } from './db/tables'
import { vocabulary } from './vocabulary'

/** The application variable that names a boot's `Seen`. */
export const SEEN_VARIABLE = 'GITHUB_SEEN'

const seenById = new Map<string, Seen>()

const seenDeps = defineDeps((env) => {
	const id = env[SEEN_VARIABLE]
	const seen = typeof id === 'string' ? seenById.get(id) : undefined
	if (seen === undefined) {
		throw new Error(`${SEEN_VARIABLE} names no registered Seen`)
	}
	return seen
})

const app = defineApp(vocabulary, tables)

const github = app.webhook('/hooks/github', { scheme: 'github-sha256', boundTo: 'workspace', actions: ['notes.write'], input: Push })
	.handle(async ({ input, ctx }) => {
		const seen = seenDeps.get()
		seen.pushes.push(input)
		seen.keys.push(ctx.delivery.key)
		await ctx.db.in(ctx.refs['notes.write']).notes.insert({ title: input.head_commit?.message ?? input.ref })
		if (seen.failNextPush) {
			seen.failNextPush = false
			throw new Error('the handler failed after its write')
		}
	})

const webhooks = app.group({ callers: ['human'] }, (r) => ({
	connect: r.mutation({
		input: z.strictObject({ workspaceId: z.string(), account: z.string() }),
		output: WebhookSecret,
		access: { action: 'notes.admin', in: 'workspace', from: 'workspaceId' },
		binds: 'github',
	}).handle(({ input, ctx }) => ctx.webhooks('github').bind(ctx.target, input.account)),
	disconnect: r.mutation({
		input: z.strictObject({ workspaceId: z.string(), id: z.uuid() }),
		output: z.strictObject({ removed: z.boolean() }),
		access: { action: 'notes.admin', in: 'workspace', from: 'workspaceId' },
		binds: 'github',
	}).handle(async ({ input, ctx }) => ({ removed: await ctx.webhooks('github').unbind(ctx.target, input.id) })),
}))

export const githubContract = app.contract((c) => ({ api: c.rpc('/api', { webhooks }), github }))

export interface GithubApp {
	readonly implementation: ContractImplementation<typeof githubContract>
	/** The application variables a boot of `implementation` takes: the one that names its `Seen`. */
	readonly variables: Readonly<Record<string, string>>
}

/** A fresh implementation (`scoped(tables)` binds to one boot) whose boots record into `seen`. */
export function githubApp(seen: Seen): GithubApp {
	const id = Bun.randomUUIDv7()
	seenById.set(id, seen)
	return { implementation: serve(githubContract, { database: scoped(tables), deps: seenDeps }), variables: { [SEEN_VARIABLE]: id } }
}
