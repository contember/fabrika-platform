import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { composeEnv } from '../compose'
import {
	APPS_PORT_VARIABLE,
	LOCAL_PORT_BASE_VARIABLE,
	LOCAL_PORTS,
	parseLocalPortBase,
	parsePortsFile,
	PLATFORM_PORT_VARIABLE,
	readRecordedPortBase,
	refuseMovedBase,
	resolveLocalPorts,
} from '../ports'

const composeFile = (name: string): string => readFileSync(resolve(import.meta.dir, '..', '..', name), 'utf8')

describe("a checkout's host ports", () => {
	test('default to 18080 and 18081', () => {
		expect(resolveLocalPorts({}, undefined)).toEqual({ platform: 18080, apps: 18081 })
		expect(resolveLocalPorts({ [LOCAL_PORT_BASE_VARIABLE]: '' }, undefined)).toEqual({ platform: 18080, apps: 18081 })
	})

	test('follow the base the stack was prepared on when the variable is unset, so a later command finds its own stack', () => {
		expect(resolveLocalPorts({}, 18090)).toEqual({ platform: 18090, apps: 18091 })
	})

	test('take the variable over the recorded base', () => {
		expect(resolveLocalPorts({ [LOCAL_PORT_BASE_VARIABLE]: '18100' }, 18090)).toEqual({ platform: 18100, apps: 18101 })
	})

	test('refuse a base that is not a port with a free next one', () => {
		for (const text of ['80', '1023', '65535', '18080.5', ' 18080', '-1', 'abc', '018080x']) {
			expect(() => parseLocalPortBase(text, 'test')).toThrow(`${LOCAL_PORT_BASE_VARIABLE} must be a port from 1024 to 65534`)
		}
		expect(parseLocalPortBase('65534', 'test')).toBe(65_534)
	})

	test('read back the record prepare writes, and refuse a malformed one', () => {
		expect(parsePortsFile(`${LOCAL_PORT_BASE_VARIABLE}=18090\n`)).toBe(18090)
		expect(() => parsePortsFile('FABRIKA_LOCAL_PORT=18090\n')).toThrow('malformed')
		expect(() => parsePortsFile(`${LOCAL_PORT_BASE_VARIABLE}=18090\nOTHER=1\n`)).toThrow('malformed')
	})
})

describe("a stack's recorded base", () => {
	const withStateDir = (files: Record<string, string>, check: (dir: string) => void): void => {
		const dir = mkdtempSync(resolve(tmpdir(), 'local-ports-'))
		try {
			for (const [name, text] of Object.entries(files)) writeFileSync(resolve(dir, name), text)
			check(dir)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}

	test('is the record, else the default for a stack prepared before the record, else none', () => {
		withStateDir({ 'ports.env': `${LOCAL_PORT_BASE_VARIABLE}=18090\n`, 'iam.env': '' }, (dir) => expect(readRecordedPortBase(dir)).toBe(18090))
		withStateDir({ 'iam.env': '' }, (dir) => expect(readRecordedPortBase(dir)).toBe(18080))
		withStateDir({}, (dir) => expect(readRecordedPortBase(dir)).toBeUndefined())
	})

	test('refuses another base until a reset, and accepts its own or none', () => {
		expect(() => refuseMovedBase(18090, { platform: 18100, apps: 18101 })).toThrow('runs on FABRIKA_LOCAL_PORT_BASE=18090, not 18100')
		refuseMovedBase(18090, { platform: 18090, apps: 18091 })
		refuseMovedBase(undefined, { platform: 18100, apps: 18101 })
	})
})

describe('the composition takes its ports from the checkout', () => {
	test('every compose call passes both ports', () => {
		expect(composeEnv(['down'])).toMatchObject({
			[PLATFORM_PORT_VARIABLE]: String(LOCAL_PORTS.platform),
			[APPS_PORT_VARIABLE]: String(LOCAL_PORTS.apps),
		})
	})

	test('no compose file names a fixed public port, and both publishes are the variables', () => {
		for (const name of ['compose.yaml', 'compose.browser.yaml']) {
			expect(composeFile(name)).not.toMatch(/1808[01]/)
		}
		const compose = composeFile('compose.yaml')
		expect(compose).toContain(`- 127.0.0.1:\${${PLATFORM_PORT_VARIABLE}:?}:\${${PLATFORM_PORT_VARIABLE}:?}`)
		expect(compose).toContain(`- 127.0.0.1:\${${APPS_PORT_VARIABLE}:?}:\${${APPS_PORT_VARIABLE}:?}`)
	})
})
