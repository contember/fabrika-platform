// The rule itself. Both directions matter equally: it must refuse a live installation that calls
// itself `local` (backlog 59), and it must keep booting every genuinely local composition in this
// repository — the local stack serves `*.fabrika.localhost` and the Cloudflare local build
// `http://localhost:18191`, so a false positive here is a broken `bun run local:up`.

import { describe, expect, test } from 'bun:test'
import { EnvironmentNameError, readEnvironmentName } from '../environment'

describe('readEnvironmentName', () => {
	test('refuses `local` from a public origin — the shape backlog 59 measured live', () => {
		for (const origin of ['https://iam-abcd-3000.prg1.zerops.app', 'https://iam.example.com', 'http://control.internal']) {
			expect(() => readEnvironmentName('local', origin)).toThrow(EnvironmentNameError)
		}
	})

	test('the message names the origin that disproved the claim, and no other value', () => {
		expect(() => readEnvironmentName('local', 'https://iam.example.com')).toThrow(/https:\/\/iam\.example\.com/)
	})

	test('a loopback origin still boots — every local composition this repository ships', () => {
		for (const origin of ['http://localhost:18191', 'http://iam.fabrika.localhost:18080', 'http://control.fabrika.localhost:18080']) {
			expect(readEnvironmentName('local', origin)).toBe('local')
		}
	})

	test('the literal loopback addresses count, v4 range and v6 alike', () => {
		for (const origin of ['http://127.0.0.1:3000', 'http://127.1.2.3', 'http://[::1]:3000']) {
			expect(readEnvironmentName('local', origin)).toBe('local')
		}
	})

	test('a name that merely CONTAINS localhost is not loopback', () => {
		expect(() => readEnvironmentName('local', 'https://localhost.example.com')).toThrow(EnvironmentNameError)
		expect(() => readEnvironmentName('local', 'https://notlocalhost')).toThrow(EnvironmentNameError)
		// …and 127 in the wrong place is a public address.
		expect(() => readEnvironmentName('local', 'http://10.127.0.1')).toThrow(EnvironmentNameError)
	})

	test('every other environment name passes through untouched — the rule is about `local` only', () => {
		for (const name of ['stage', 'prod', 'mangoweb']) {
			expect(readEnvironmentName(name, 'https://iam.example.com')).toBe(name)
		}
	})

	test('no stated origin is a supported answer, never a guess', () => {
		expect(readEnvironmentName('local', undefined)).toBe('local')
		expect(readEnvironmentName('local', '')).toBe('local')
		expect(readEnvironmentName('local', '   ')).toBe('local')
	})

	test('an unparseable origin is not evidence either — it already breaks sign-in on its own', () => {
		expect(readEnvironmentName('local', 'iam.example.com')).toBe('local')
		expect(readEnvironmentName('local', 'not a url')).toBe('local')
	})
})
