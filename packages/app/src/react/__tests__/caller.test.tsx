// The hooks behind the production proxy decision of the test kit: the proxy's own 401 reaches a view with its login
// URL, and `useCaller` and `<Can>` read the SPA mount's caller document for the kit's callers.

import { mount, settle } from './dom'

import { createClient } from '@fabrika/app/client'
import { defineContract } from '@fabrika/app/contract'
import { Can, useCaller, useQuery } from '@fabrika/app/react'
import { testKit } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { z } from 'zod/v4'
import { implement } from '../../implement/implement'
import { FabrikaProvider } from '../provider'

const contract = defineContract({
	app: 'notes',
	dimensions: { workspace: {} },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' },
	roles: {
		editor: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['editor'] } },
		reader: { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['editor'] } },
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		stats: { counts: c.query({ output: z.strictObject({ notes: z.int() }), access: { action: 'notes.read', over: 'workspace' } }) },
	}),
	site: c.spa('/', { dir: 'dist/site', access: { member: true } }),
}))

const app = implement(contract, { database: null, deps: () => ({}), handlers: () => ({ api: { stats: { counts: () => ({ notes: 1 }) } } }) })
const kit = testKit(app)
const w1 = kit.scope('workspace', 'w1')
const editor = kit.testCaller([{ role: 'editor', scope: w1 }], { email: 'ann@example.com', label: 'Ann' })
const reader = kit.testCaller([{ role: 'reader', scope: w1 }])

const names = createClient(contract, 'api')

function Counts(): ReactNode {
	const counts = useQuery(names.stats.counts)
	if (counts.status === 'error') {
		return (
			<p data-kind={counts.error.kind}>{counts.error.kind === 'unauthenticated' ? (counts.error.loginUrl ?? 'no login URL') : counts.error.message}</p>
		)
	}
	return <p data-kind={counts.status}>{counts.status === 'success' ? counts.data.notes : ''}</p>
}

function Greeting(): ReactNode {
	const caller = useCaller()
	return (
		<div>
			<h1>{caller === null ? 'nobody' : `${caller.label} <${caller.email}>`}</h1>
			<Can action="notes.write" fallback={<span>read only</span>}>
				<button type="button">New note</button>
			</Can>
			<Can action="notes.write" scope={{ type: 'workspace', value: 'w2' }} fallback={<span>not in w2</span>}>
				<span>writes in w2</span>
			</Can>
			<Can action="notes.write" scope={{ type: 'workspace', value: 'w1' }}>
				<span>writes in w1</span>
			</Can>
		</div>
	)
}

const view = async (fetch: ReturnType<typeof kit.browser>, node: ReactNode) => {
	const mounted = await mount(
		<FabrikaProvider clients={[createClient(contract, 'api', { fetch })]} fetch={fetch}>
			{node}
		</FabrikaProvider>,
	)
	await settle()
	return mounted
}

describe('a refusal of the proxy reaches the view', () => {
	test('a call without a session is unauthenticated, with the login URL the proxy answers', async () => {
		const mounted = await view(kit.browser(), <Counts />)
		const shown = mounted.container.querySelector('p')
		expect(shown?.getAttribute('data-kind')).toBe('unauthenticated')
		expect(shown?.textContent).toStartWith('http')
		await mounted.unmount()
	})

	test('the same call with a session answers', async () => {
		const mounted = await view(kit.browser(reader), <Counts />)
		expect(mounted.container.querySelector('p')?.textContent).toBe('1')
		await mounted.unmount()
	})
})

describe('useCaller and Can', () => {
	test("show the person's label and mailbox, and a control only where the token grants its action", async () => {
		const mounted = await view(kit.browser(editor), <Greeting />)
		expect(mounted.container.querySelector('h1')?.textContent).toBe('Ann <ann@example.com>')
		expect(mounted.container.querySelector('button')?.textContent).toBe('New note')
		expect(mounted.container.textContent).toContain('not in w2')
		expect(mounted.container.textContent).toContain('writes in w1')
		await mounted.unmount()
	})

	test('a reader sees no write control', async () => {
		const mounted = await view(kit.browser(reader), <Greeting />)
		expect(mounted.container.querySelector('button')).toBeNull()
		expect(mounted.container.textContent).toContain('read only')
		expect(mounted.container.textContent).not.toContain('writes in w1')
		await mounted.unmount()
	})

	test('without a session the caller is nobody and every Can shows its fallback', async () => {
		const mounted = await view(kit.browser(), <Greeting />)
		expect(mounted.container.querySelector('h1')?.textContent).toBe('nobody')
		expect(mounted.container.textContent).toContain('read only')
		await mounted.unmount()
	})
})
