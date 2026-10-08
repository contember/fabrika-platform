// A contract of 200 procedures, cycling through the access forms, type-checks fast enough to author. The
// instantiation count is the deterministic witness; the time is printed, and the bound only catches a pathological
// regression on a loaded machine.

import { describe, expect, test } from 'bun:test'
import { compileScale, scaleSource } from './scale-fixture'

describe('a contract of 200 procedures', () => {
	test('type-checks without a diagnostic, within the instantiation and time budget', () => {
		const { diagnostics, seconds, instantiations } = compileScale(scaleSource(200, false))
		console.info(`200 procedures: ${seconds.toFixed(2)} s, ${instantiations} instantiations`)
		expect(diagnostics).toEqual([])
		expect(instantiations).toBeLessThan(1_000_000)
		expect(seconds).toBeLessThan(10)
	}, 60_000)
})
