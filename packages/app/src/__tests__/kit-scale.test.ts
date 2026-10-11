// 200 endpoints of the staged kit in 10 groups, each its own module and each handler using its `ctx.db`, type-check
// within the budget `implement-scale.test.ts` keeps for 200 handlers of the mirrored tree.

import { describe, expect, test } from 'bun:test'
import { compileScaleFiles, kitScaleSources } from './scale-fixture'

describe('the staged kit over 200 endpoints', () => {
	test('type-checks without a diagnostic, within the instantiation and time budget', () => {
		const { diagnostics, seconds, instantiations } = compileScaleFiles(kitScaleSources(200, 20))
		console.info(`the staged kit over 200 endpoints in 10 groups: ${seconds.toFixed(2)} s, ${instantiations} instantiations`)
		expect(diagnostics).toEqual([])
		expect(instantiations).toBeLessThan(1_000_000)
		expect(seconds).toBeLessThan(10)
	}, 60_000)
})
