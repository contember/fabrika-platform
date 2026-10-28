// A cross-origin endpoint in the conservative access diff (ADR-0050 §3, ADR-0022 "Cross-origin endpoints"): opening an
// endpoint to another origin widens and says from where; closing it narrows. A 0.5 application opens one with
// `crossOrigin: true`, this release's with `admission: { origins: 'listed' }`; both reach the same row.

import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import type { AccessSnapshot } from '../approval/snapshot'
import { classifyAccess } from './helpers/access'
import { BASE, edited, snapshot05 } from './helpers/contracts'
import { kitFiles, type KitOptions } from './helpers/kit-contract'

const GET = "access: { action: 'notes.read', on: 'note', from: 'id' } }),"
const OPENED = "access: { action: 'notes.read', on: 'note', from: 'id' }, crossOrigin: true }),"

function kitSnapshot(options: KitOptions = {}): AccessSnapshot {
	return { version: 1, contract: readContractSource(new Map(Object.entries(kitFiles(options)))), migrations: [], checker: '0.0.0' }
}

describe('a 0.5 cross-origin endpoint in the approval diff', () => {
	test('opening an endpoint to the environment origins widens, and the line says so', () => {
		const classification = classifyAccess(snapshot05(BASE), snapshot05(edited(GET, OPENED)))
		expect(classification.outcome).toBe('widening')
		expect(classification.changes).toContainEqual({
			effect: 'widens',
			line: 'Endpoint `api.get` becomes callable from a page on an origin the environment lists',
			environmentOrigins: true,
		})
	})

	test('closing it again narrows', () => {
		const classification = classifyAccess(snapshot05(edited(GET, OPENED)), snapshot05(BASE))
		expect(classification.changes).toContainEqual({ effect: 'narrows', line: 'Endpoint `api.get` is no longer callable from another origin' })
		expect(classification.changes.some((change) => change.environmentOrigins === true)).toBe(false)
		expect(classification.outcome).not.toBe('widening')
	})

	test('a new cross-origin endpoint names where it is callable from', () => {
		const added = edited(GET, `${GET}\n\t\tpeek: c.query({ input: z.strictObject({ id: z.uuid() }), output: Note, ${OPENED}`)
		const classification = classifyAccess(snapshot05(BASE), snapshot05(added))
		expect(classification.changes.map((change) => change.line)).toContainEqual(
			expect.stringMatching(/^New endpoint `api\.peek` .*, callable from a page on an origin the environment lists$/),
		)
		expect(classification.changes.find((change) => change.line.startsWith('New endpoint `api.peek`'))?.environmentOrigins).toBe(true)
	})
})

describe('an endpoint that admits the listed origins in the approval diff', () => {
	const listed: KitOptions = { summary: "admission: { origins: 'listed' }" }

	test('admitting the environment origins widens, and the line says so', () => {
		const classification = classifyAccess(kitSnapshot(), kitSnapshot(listed))
		expect(classification.outcome).toBe('widening')
		expect(classification.changes).toContainEqual({
			effect: 'widens',
			line: 'Endpoint `api.notes.summary` becomes callable from a page on an origin the environment lists',
			environmentOrigins: true,
		})
	})

	test('admitting the same origin again narrows', () => {
		const classification = classifyAccess(kitSnapshot(listed), kitSnapshot({ summary: "admission: { origins: 'same-origin' }" }))
		expect(classification.changes).toContainEqual({
			effect: 'narrows',
			line: 'Endpoint `api.notes.summary` is no longer callable from another origin',
		})
		expect(classification.outcome).not.toBe('widening')
	})
})
