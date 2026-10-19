// `c.rpc(prefix, groups, { compatibility: 'backward' })`: the artifact records the promise, and
// `incompatibleMountChanges` names what a later contract breaks for the mount's callers, as an export's rule does.

import { type AnyContract, compileContract, defineApp, defineVocabulary, incompatibleMountChanges } from '@fabrika/app/contract'
import type { ContractArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'

const vocabulary = defineVocabulary({
	app: 'partners',
	dimensions: { org: {} },
	actions: { 'deals.read': 'Read deals', 'deals.write': 'Write deals' },
	roles: { partner: { grants: ['deals.read', 'deals.write'] } },
})
const app = defineApp(vocabulary)
const Deal = z.strictObject({ id: z.string(), name: z.string() })
const Id = z.strictObject({ id: z.string() })
const handled = () => ({ id: 'd1', name: 'Deal' })

const DealStage = z.strictObject({ id: z.string(), name: z.string(), stage: z.string() })
const IdAndNote = z.strictObject({ id: z.string(), note: z.optional(z.string()) })
const IdAndOrg = z.strictObject({ id: z.string(), org: z.string() })

const rename = app.group({ callers: ['machine'] }, (r) => ({
	rename: r.mutation({ input: Deal, output: Deal, access: { action: 'deals.write', app: true } }).handle(handled),
}))

/** The artifact of one version of the partner API. */
const artifactOf = (contract: AnyContract): ContractArtifact => compileContract(contract, {})

const published = app.group({ callers: ['machine'] }, (r) => ({
	get: r.query({ input: Id, output: Deal, access: { action: 'deals.read', app: true } }).handle(handled),
}))

describe('the promise in the artifact', () => {
	test("records 'backward' on the mount, and nothing for 'unchecked' or no options", () => {
		const deals = app.group({ callers: ['machine'] }, (r) => ({
			get: r.query({ input: Id, output: Deal, access: { action: 'deals.read', app: true } }).handle(handled),
		}))
		expect(
			artifactOf(app.contract((c) => ({ partners: c.rpc('/api/v1', { deals: published, rename }, { compatibility: 'backward' }) }))).mounts['partners'],
		).toEqual({ kind: 'rpc', prefix: '/api/v1', callers: ['machine'], compatibility: 'backward' })
		const unchecked = compileContract(app.contract((c) => ({ api: c.rpc('/api', { deals }, { compatibility: 'unchecked' }) })), {})
		expect(unchecked.mounts['api']).toEqual({ kind: 'rpc', prefix: '/api', callers: ['machine'] })
		expect(compileContract(app.contract((c) => ({ api: c.rpc('/api', { deals }) })), {}).mounts['api']).not.toHaveProperty('compatibility')
	})

	test('refuses another promise and another option', () => {
		const deals = app.group({ callers: ['machine'] }, (r) => ({
			get: r.query({ input: Id, output: Deal, access: { action: 'deals.read', app: true } }).handle(handled),
		}))
		const written = Reflect.construct(Object, [{ compatibility: 'forward', retries: 1 }])
		expect(() => compileContract(app.contract((c) => ({ api: c.rpc('/api', { deals }, written) })), {})).toThrow(
			"c.rpc('/api'): 'retries' is not an option (allowed: compatibility)",
		)
	})
})

describe('incompatibleMountChanges', () => {
	const before = artifactOf(app.contract((c) => ({ partners: c.rpc('/api/v1', { deals: published, rename }, { compatibility: 'backward' }) })))

	test('accepts a new optional input field and a new procedure', () => {
		const widened = app.group({ callers: ['machine'] }, (r) => ({
			get: r.query({ input: IdAndNote, output: Deal, access: { action: 'deals.read', app: true } }).handle(handled),
			list: r.query({ output: z.array(Deal), access: { action: 'deals.read', app: true } }).handle(() => []),
		}))
		expect(
			incompatibleMountChanges(
				before,
				artifactOf(app.contract((c) => ({ partners: c.rpc('/api/v1', { deals: widened, rename }, { compatibility: 'backward' }) }))),
			),
		).toEqual([])
	})

	test('names a removed procedure, a narrower input, another output, another method and another access', () => {
		const removed = app.group({ callers: ['machine'] }, (r) => ({
			list: r.query({ output: z.array(Deal), access: { action: 'deals.read', app: true } }).handle(() => []),
		}))
		expect(
			incompatibleMountChanges(
				before,
				artifactOf(app.contract((c) => ({ partners: c.rpc('/api/v1', { deals: removed, rename }, { compatibility: 'backward' }) }))),
			),
		).toEqual(["removes 'partners.deals.get'"])
		expect(
			incompatibleMountChanges(
				before,
				artifactOf(app.contract((c) => ({
					partners: c.rpc('/api/v1', {
						rename,
						deals: app.group({ callers: ['machine'] }, (r) => ({
							get: r.query({ input: IdAndOrg, output: Deal, access: { action: 'deals.read', app: true } }).handle(handled),
						})),
					}, { compatibility: 'backward' }),
				}))),
			),
		).toEqual(["'partners.deals.get' accepts less input than before"])
		expect(
			incompatibleMountChanges(
				before,
				artifactOf(app.contract((c) => ({
					partners: c.rpc('/api/v1', {
						rename,
						deals: app.group({ callers: ['machine'] }, (r) => ({
							get: r.query({ input: Id, output: DealStage, access: { action: 'deals.read', app: true } }).handle(() => ({ ...handled(), stage: 'won' })),
						})),
					}, { compatibility: 'backward' }),
				}))),
			),
		).toEqual(["'partners.deals.get' answers another output than before"])
		expect(
			incompatibleMountChanges(
				before,
				artifactOf(app.contract((c) => ({
					partners: c.rpc('/api/v1', {
						rename,
						deals: app.group({ callers: ['machine'] }, (r) => ({
							get: r.query({ input: Id, output: Deal, access: { action: 'deals.read', app: true }, http: { method: 'GET' } }).handle(handled),
						})),
					}, { compatibility: 'backward' }),
				}))),
			),
		).toEqual(["'partners.deals.get' changes its HTTP shape"])
		expect(
			incompatibleMountChanges(
				before,
				artifactOf(app.contract((c) => ({
					partners: c.rpc('/api/v1', {
						rename,
						deals: app.group({ callers: ['machine'] }, (r) => ({
							get: r.query({ input: Id, output: Deal, access: { action: 'deals.write', app: true } }).handle(handled),
						})),
					}, { compatibility: 'backward' }),
				}))),
			),
		).toEqual(["'partners.deals.get' changes its access"])
	})

	test('names a removed or moved mount, and holds a mount that drops its promise to it once', () => {
		expect(
			incompatibleMountChanges(
				before,
				artifactOf(app.contract((c) => ({ partners: c.rpc('/api/v2', { deals: published, rename }, { compatibility: 'backward' }) }))),
			),
		).toEqual([
			"mount 'partners' promises backward compatibility, and this deploy removes or moves it",
		])
		const dropped = compileContract(app.contract((c) => ({ partners: c.rpc('/api/v1', { deals: published, rename }) })), {})
		expect(incompatibleMountChanges(before, dropped)).toEqual([])
		expect(
			incompatibleMountChanges(
				dropped,
				artifactOf(app.contract((c) => ({ partners: c.rpc('/api/v2', { deals: published, rename }, { compatibility: 'backward' }) }))),
			),
		).toEqual([])
	})
})
