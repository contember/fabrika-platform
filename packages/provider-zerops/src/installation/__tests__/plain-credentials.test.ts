import { plainCredentialFinding } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_DEPLOY_ORDER } from '../deploy'
import { parsePlainVariables, plainCredentialVariables } from '../plain-credentials'

/** Every `envVariables` entry of a parsed YAML document, at any depth. */
const environmentEntries = (value: unknown): (readonly [string, string])[] => {
	if (Array.isArray(value)) return value.flatMap(environmentEntries)
	if (typeof value !== 'object' || value === null) return []
	return Object.entries(value).flatMap(([key, item]) =>
		key === 'envVariables' && typeof item === 'object' && item !== null
			? Object.entries(item).map(([name, text]) => [name, String(text)] as const)
			: environmentEntries(item)
	)
}

describe("Fabrika's own readable variables", () => {
	// A deployed version's descriptor variables are listed with the service's own, so the generated root `zerops.yaml`
	// must not trip the check it ships with.
	test('no variable of the generated root zerops.yaml looks like a credential', () => {
		const document: unknown = Bun.YAML.parse(readFileSync(join(import.meta.dir, '../../../../../zerops.yaml'), 'utf8'))
		const entries = environmentEntries(document)
		expect(entries.length).toBeGreaterThan(10)
		expect(entries.filter(([name, value]) => plainCredentialFinding(name, value) !== null).map(([name]) => name)).toEqual([])
	})
})

describe('plainCredentialVariables', () => {
	const live = (records: Readonly<Record<string, string>>, sensitive: readonly string[] = []) =>
		new Map(
			Object.entries(records).map(([key, content]) => [
				key,
				sensitive.includes(key) ? { id: key, key, sensitive: true as const } : { id: key, key, sensitive: false as const, content },
			]),
		)

	test('a key this deploy writes itself is its own configuration, never a finding', () => {
		expect(plainCredentialVariables('control', live({ FABRIKA_IAM_KEY: 'x' }), new Set(['FABRIKA_IAM_KEY']), new Set())).toEqual([])
		expect(plainCredentialVariables('control', live({ FABRIKA_IAM_KEY: 'x' }), new Set(), new Set())).toEqual([
			{ service: 'control', key: 'FABRIKA_IAM_KEY', because: 'its name contains `KEY`' },
		])
	})

	test('a mail provider variable declared secret is a finding even where the name alone says nothing', () => {
		expect(plainCredentialVariables('iam', live({ FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'acme' }), new Set(), new Set())).toEqual([
			{ service: 'iam', key: 'FABRIKA_EMAIL_SMARTEMAILING_USERNAME', because: 'its mail provider declares it secret' },
		])
		expect(plainCredentialVariables('iam', live({ FABRIKA_EMAIL_SMARTEMAILING_USERNAME: '' }), new Set(), new Set())).toEqual([])
	})

	test('a sensitive record is never a finding, and an exception covers only its own service', () => {
		expect(plainCredentialVariables('iam', live({ DB_PASSWORD: 'x' }, ['DB_PASSWORD']), new Set(), new Set())).toEqual([])
		expect(plainCredentialVariables('iam', live({ DB_PASSWORD: 'x' }), new Set(), new Set(['iam/DB_PASSWORD']))).toEqual([])
		expect(plainCredentialVariables('iam', live({ DB_PASSWORD: 'x' }), new Set(), new Set(['control/DB_PASSWORD']))).toHaveLength(1)
	})
})

describe('parsePlainVariables', () => {
	test('reads comma-separated `<service>/<KEY>` and refuses anything else', () => {
		expect(parsePlainVariables(undefined, PLATFORM_DEPLOY_ORDER)).toEqual(new Set())
		expect(parsePlainVariables(' iam/A ,, control/B_C ', PLATFORM_DEPLOY_ORDER)).toEqual(new Set(['iam/A', 'control/B_C']))
		expect(() => parsePlainVariables('A', PLATFORM_DEPLOY_ORDER)).toThrow('entry 1')
		expect(() => parsePlainVariables('iam/A,storage/B', PLATFORM_DEPLOY_ORDER)).toThrow('entry 2')
		expect(() => parsePlainVariables('iam/', PLATFORM_DEPLOY_ORDER)).toThrow('entry 1')
	})
})
