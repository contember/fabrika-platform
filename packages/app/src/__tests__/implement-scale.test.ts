// `implement` over a contract of 200 procedures, one handler each, type-checks fast enough to author.

import { describe, expect, test } from 'bun:test'
import { compileScale, scaleSource } from './scale-fixture'

describe('implement over 200 procedures', () => {
	test('type-checks without a diagnostic, within the instantiation and time budget', () => {
		const { diagnostics, seconds, instantiations } = compileScale(scaleSource(200, true))
		console.info(`implement over 200 procedures: ${seconds.toFixed(2)} s, ${instantiations} instantiations`)
		expect(diagnostics).toEqual([])
		expect(instantiations).toBeLessThan(1_000_000)
		expect(seconds).toBeLessThan(10)
	}, 60_000)
})
