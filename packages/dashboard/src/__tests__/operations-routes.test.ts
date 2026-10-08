import { describe, expect, test } from 'bun:test'
import errorDetail from '../routes/operations/errors/detail'
import health from '../routes/operations/health/index'
import releaseDetail from '../routes/operations/releases/detail'
import sourceAlerts from '../routes/operations/sources/alerts'
import sourceDetail from '../routes/operations/sources/detail'

describe('Operations routes', () => {
	test('keep operator identities opaque and nested behind the console paths', () => {
		expect(errorDetail.route).toBe('/operations/errors/:issueId')
		expect(releaseDetail.route).toBe('/operations/releases/:releaseId')
		expect(sourceDetail.route).toBe('/operations/sources/:sourceId')
		expect(sourceAlerts.route).toBe('/operations/sources/:sourceId/alerts')
		expect(health.route).toBe('/operations/health')
	})
})
