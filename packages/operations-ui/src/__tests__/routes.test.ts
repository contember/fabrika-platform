import { describe, expect, test } from 'bun:test'
import errorDetail from '../routes/errors/detail'
import health from '../routes/health'
import releaseDetail from '../routes/releases/detail'
import sourceAlerts from '../routes/sources/alerts'
import sourceDetail from '../routes/sources/detail'

describe('Operations routes', () => {
	test('keep operator identities opaque and nested behind the console paths', () => {
		expect(errorDetail.route).toBe('/operations/errors/:issueId')
		expect(releaseDetail.route).toBe('/operations/releases/:releaseId')
		expect(sourceDetail.route).toBe('/operations/sources/:sourceId')
		expect(sourceAlerts.route).toBe('/operations/sources/:sourceId/alerts')
		expect(health.route).toBe('/operations/health')
	})

	test('load every data-backed route instead of shipping a placeholder component', () => {
		for (const page of [errorDetail, releaseDetail, sourceDetail, sourceAlerts, health]) {
			expect(typeof page.loader).toBe('function')
		}
	})
})
