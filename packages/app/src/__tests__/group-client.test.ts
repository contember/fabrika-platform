// A group client is the contract client's subtree built from the group values alone: each procedure sends the request
// the contract client sends, under the same mount and path, and reads the answer through the same output schema.

import { createClient, createGroupClient, download, groupMount, RpcError, type RpcFetch } from '@fabrika/app/client'
import { describe, expect, test } from 'bun:test'
import { attachmentAt, clientNodeOf } from '../client/contract'
import { contract } from './kit-fixture/fabrika.contract'
import { companies } from './kit-fixture/src/companies/endpoints'
import { deals } from './kit-fixture/src/deals/endpoints'

interface Sent {
	readonly url: string
	readonly method: string
	readonly body: string
}

/** Records every request and answers `result` in the envelope. */
function answering(result: unknown): { readonly sent: Sent[]; readonly fetch: RpcFetch } {
	const sent: Sent[] = []
	return {
		sent,
		fetch: async (input, init) => {
			const request = new Request(new URL(String(input), 'https://crm.test'), init)
			sent.push({ url: request.url, method: request.method, body: await request.clone().text() })
			return Response.json({ result })
		},
	}
}

const DEAL = { id: '0190a0a0-0000-7000-8000-000000000001', title: 'first', stage: 'won' }

const clients = (fetch: RpcFetch) => {
	const api = groupMount<typeof contract>()('api', { app: 'crm', prefix: '/api' }, { fetch })
	return { full: createClient(contract, 'api', { fetch }), groups: createGroupClient(api, { deals, companies }) }
}

describe('a group client', () => {
	test('holds the procedures of its groups, each the node the contract client has there', () => {
		const { full, groups } = clients(answering(null).fetch)
		expect(Object.keys(groups)).toEqual(['deals', 'companies'])
		expect(clientNodeOf(groups)).toEqual(clientNodeOf(full))
		for (const name of ['deals', 'companies'] as const) {
			expect(Object.keys(groups[name])).toEqual(Object.keys(full[name]))
			expect(clientNodeOf(groups[name])).toEqual(clientNodeOf(full[name]))
		}
		expect(clientNodeOf(groups.deals.get)).toEqual(clientNodeOf(full.deals.get))
		expect(clientNodeOf(groups.companies.create)).toEqual(clientNodeOf(full.companies.create))
		expect(groups.deals.get.output).toBe(full.deals.get.output)
		expect(attachmentAt(groups.deals.exportDeals)).toEqual(attachmentAt(full.deals.exportDeals))
	})

	test('sends the request the contract client sends and answers what the output schema admits', async () => {
		const viaFull = answering(DEAL)
		const viaGroups = answering(DEAL)
		const input = { id: DEAL.id }
		expect(await clients(viaGroups.fetch).groups.deals.get(input)).toEqual(await clients(viaFull.fetch).full.deals.get(input))
		expect(viaGroups.sent).toEqual(viaFull.sent)
		expect(viaGroups.sent).toEqual([{ url: 'https://crm.test/api/deals.get', method: 'POST', body: JSON.stringify(input) }])
	})

	test('refuses an answer the output schema refuses, as the contract client does', async () => {
		const call = clients(answering({ ...DEAL, stage: 'archived' }).fetch).groups.deals.get({ id: DEAL.id })
		const error = await call.then(() => null, (thrown: unknown) => thrown)
		expect(error).toBeInstanceOf(RpcError)
		expect(error instanceof RpcError ? error.type : null).toBe('invalid-response')
	})

	test('downloads an attachment from the path the contract client posts to', async () => {
		const viaFull = answering([])
		const viaGroups = answering([])
		await download(clients(viaFull.fetch).full.deals.exportDeals, { orgId: 'o1' })
		await download(clients(viaGroups.fetch).groups.deals.exportDeals, { orgId: 'o1' })
		expect(viaGroups.sent).toEqual(viaFull.sent)
		expect(viaGroups.sent.map((sent) => sent.url)).toEqual(['https://crm.test/api/deals.exportDeals'])
	})
})
