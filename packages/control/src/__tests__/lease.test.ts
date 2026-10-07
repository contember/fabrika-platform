import { afterEach, beforeEach, describe } from 'bun:test'
import { createHarness, type Harness } from './helpers/harness'
import { leaseContract } from './helpers/lease'

let harness: Harness
beforeEach(() => {
	harness = createHarness()
})
afterEach(() => harness.sqlite.close())

describe('lease on SQLite', () => {
	leaseContract(() => harness.d1)
})
