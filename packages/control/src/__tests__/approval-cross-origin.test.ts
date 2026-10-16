// A cross-origin endpoint in the conservative access diff (ADR-0050 §3, ADR-0022 "Cross-origin endpoints"): opening an
// endpoint to another origin widens and says from where; closing it narrows.

import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { classifyAccess } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'
import { BASE, edited } from './helpers/contracts'

function snapshot(contract = BASE): AccessSnapshot {
	return { version: 1, contract: readContractSource(new Map([['fabrika.contract.ts', contract]]), {}), migrations: [], checker: '0.0.0' }
}

const GET = "access: { action: 'notes.read', on: 'note', from: 'id' } }),"
const OPENED = "access: { action: 'notes.read', on: 'note', from: 'id' }, crossOrigin: true }),"

describe('a cross-origin endpoint in the approval diff', () => {
	test('opening an endpoint to the environment origins widens, and the line says so', () => {
		const classification = classifyAccess(snapshot(), snapshot(edited(GET, OPENED)))
		expect(classification.outcome).toBe('widening')
		expect(classification.changes).toContainEqual({
			effect: 'widens',
			line: 'Endpoint `api.get` becomes callable from a page on an origin the environment lists',
			environmentOrigins: true,
		})
	})

	test('closing it again narrows', () => {
		const classification = classifyAccess(snapshot(edited(GET, OPENED)), snapshot())
		expect(classification.changes).toContainEqual({ effect: 'narrows', line: 'Endpoint `api.get` is no longer callable from another origin' })
		expect(classification.changes.some((change) => change.environmentOrigins === true)).toBe(false)
		expect(classification.outcome).not.toBe('widening')
	})

	test('a new cross-origin endpoint names where it is callable from', () => {
		const added = edited(GET, `${GET}\n\t\tpeek: c.query({ input: z.strictObject({ id: z.uuid() }), output: Note, ${OPENED}`)
		const classification = classifyAccess(snapshot(), snapshot(added))
		expect(classification.changes.map((change) => change.line)).toContainEqual(
			expect.stringMatching(/^New endpoint `api\.peek` .*, callable from a page on an origin the environment lists$/),
		)
		expect(classification.changes.find((change) => change.line.startsWith('New endpoint `api.peek`'))?.environmentOrigins).toBe(true)
	})
})
