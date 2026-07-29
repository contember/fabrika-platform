import { describe, expect, test } from 'bun:test'
import * as appApi from '../index.js'

describe('@fabrika/app root exports', () => {
	test('exclude runtime adapter APIs', () => {
		expect('createCloudflareWorker' in appApi).toBe(false)
		expect('createBunHandler' in appApi).toBe(false)
	})
})
