import { expect, test } from 'bun:test'
import { openerAllowed } from './opener'

test('outside a test run every opener runs', () => {
	expect(openerAllowed('/usr/bin/open\n', { NODE_ENV: 'production' })).toBe(true)
	expect(openerAllowed('/usr/bin/xdg-open', {})).toBe(true)
})

test("under a test run only the test's own fake runs, and none without its directory", () => {
	const fakes = { NODE_ENV: 'test', FABRIKA_TEST_OPENER_DIR: '/tmp/run/bin' }
	expect(openerAllowed('/tmp/run/bin/open\n', fakes)).toBe(true)
	expect(openerAllowed('/usr/bin/open\n', fakes)).toBe(false)
	expect(openerAllowed('/tmp/run/bin/../../../usr/bin/open', fakes)).toBe(false)
	expect(openerAllowed('/tmp/run/bin-other/open', fakes)).toBe(false)
	expect(openerAllowed('/tmp/run/bin', fakes)).toBe(false)
	expect(openerAllowed('/tmp/run/bin/open', { NODE_ENV: 'test' })).toBe(false)
	expect(openerAllowed('/tmp/run/bin/open', { NODE_ENV: 'test', FABRIKA_TEST_OPENER_DIR: '' })).toBe(false)
})
