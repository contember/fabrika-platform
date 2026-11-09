// `implement` over a contract of 200 procedures, one handler each, type-checks fast enough to author, witnessed by the
// instantiation count.

import { describe, expect, test } from 'bun:test'
import { compileScale, scaleSource } from './scale-fixture'

describe('implement over 200 procedures', () => {
	test('type-checks without a diagnostic, within the instantiation budget', () => {
		const { diagnostics, seconds, instantiations } = compileScale(scaleSource(200, true))
		console.info(`implement over 200 procedures: ${seconds.toFixed(2)} s, ${instantiations} instantiations`)
		expect(diagnostics).toEqual([])
		expect(instantiations).toBeLessThan(1_000_000)
	}, 60_000)
})
