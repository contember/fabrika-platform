import { afterEach, beforeEach, describe } from 'bun:test'
import { createHarness, type Harness } from './helpers/harness'
import { runFencingContract } from './helpers/run-fencing'

let harness: Harness
beforeEach(() => {
	harness = createHarness()
})
afterEach(() => harness.sqlite.close())

describe('run fencing on SQLite', () => {
	runFencingContract(() => harness.d1)
})
