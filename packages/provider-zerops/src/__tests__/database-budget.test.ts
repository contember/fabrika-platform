import { describe, expect, test } from 'bun:test'
import { zeropsDatabaseMinRam, zeropsPostgresMaxConnections, zeropsProcessConnections } from '../database-budget'

describe('max_connections of a Zerops PostgreSQL service', () => {
	test("follows the RAM step as Zerops' connection limits table states it, OLTP and OLAP", () => {
		const table: Array<[number, number, number]> = [
			[0.25, 20, 10],
			[0.5, 25, 12],
			[1, 50, 25],
			[2, 100, 50],
			[4, 200, 100],
			[8, 400, 200],
			[16, 500, 200],
			[48, 500, 200],
		]
		for (const [ram, oltp, olap] of table) {
			expect([ram, zeropsPostgresMaxConnections(ram, 'oltp-hobby'), zeropsPostgresMaxConnections(ram, 'olap-production')]).toEqual([ram, oltp, olap])
		}
	})

	test('a RAM between two steps has the lower one, and a profile it does not know is OLTP', () => {
		expect(zeropsPostgresMaxConnections(0.75, 'oltp-staging')).toBe(25)
		expect(zeropsPostgresMaxConnections(7, 'custom')).toBe(200)
		expect(zeropsPostgresMaxConnections(12, undefined)).toBe(400)
		expect(zeropsPostgresMaxConnections(0.125, undefined)).toBe(20)
	})
})

describe('the connections of each process', () => {
	test('share what the roles can take after the reserved slots and one container start, between twice the containers and the jobs', () => {
		// 20 − 7 reserved − 5 for the init commands = 8, over 2 × 1 containers and 2 jobs.
		expect(zeropsProcessConnections(20, { maxContainers: 1, jobs: 2 })).toBe(2)
		// 50 − 12 = 38, over 2 × 4 containers.
		expect(zeropsProcessConnections(50, { maxContainers: 4, jobs: 0 })).toBe(4)
		expect(zeropsProcessConnections(500, { maxContainers: 2, jobs: 0 })).toBe(10)
	})

	test('are none below two: a job needs one connection for its write and one to cancel it', () => {
		expect(zeropsProcessConnections(20, { maxContainers: 2, jobs: 0 })).toBe(2)
		expect(zeropsProcessConnections(20, { maxContainers: 2, jobs: 1 })).toBeNull()
		expect(zeropsProcessConnections(20, { maxContainers: 4, jobs: 0 })).toBeNull()
	})

	test('need the smallest RAM step at which each process gets two', () => {
		expect(zeropsDatabaseMinRam({ maxContainers: 1, jobs: 0 }, 'oltp-hobby')).toBe(0.25)
		expect(zeropsDatabaseMinRam({ maxContainers: 2, jobs: 2 }, 'oltp-hobby')).toBe(0.5)
		expect(zeropsDatabaseMinRam({ maxContainers: 4, jobs: 2 }, 'oltp-hobby')).toBe(1)
		expect(zeropsDatabaseMinRam({ maxContainers: 10, jobs: 3 }, 'oltp-hobby')).toBe(2)
		expect(zeropsDatabaseMinRam({ maxContainers: 10, jobs: 3 }, 'olap-production')).toBe(4)
	})
})
