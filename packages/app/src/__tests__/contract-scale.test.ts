// A contract of 200 procedures, cycling through the access forms, type-checks fast enough to author. The
// instantiation count is the deterministic witness; the time is only printed, because a wall-clock bound fails on a
// loaded machine without a code change.

import { describe, expect, test } from 'bun:test'
import { compileScale, scaleSource } from './scale-fixture'

describe('a contract of 200 procedures', () => {
	test('type-checks without a diagnostic, within the instantiation budget', () => {
		const { diagnostics, seconds, instantiations } = compileScale(scaleSource(200, false))
		console.info(`200 procedures: ${seconds.toFixed(2)} s, ${instantiations} instantiations`)
		expect(diagnostics).toEqual([])
		expect(instantiations).toBeLessThan(1_000_000)
	}, 60_000)
})
