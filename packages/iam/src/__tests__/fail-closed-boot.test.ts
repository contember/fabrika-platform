/**
 * The three fail-closed boot/crypto primitives nothing exercised (SEC-28).
 *
 * Each one is a single `if` that decides whether a misconfigured or hostile input is REFUSED or
 * quietly tolerated, and each was working only by inspection. They are cheap to test and expensive to
 * regress: an ephemeral signing key on production means every token dies on the next deploy and any
 * isolate can mint for any other; a short RPC secret is a guessable password in front of the
 * management surface; and a non-constant-time digest comparison leaks how much of a presented
 * credential matched.
 */

import { describe, expect, test } from 'bun:test'
import { createRuntime } from '../node/runtime'
import { hashToken, timingSafeEqualHex } from '../secret'
import { getSigner } from '../signing'

describe('signing keys', () => {
	test('an EPHEMERAL key is refused off-local', async () => {
		for (const environment of ['stage', 'prod']) {
			await expect(getSigner({ FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: environment })).rejects.toThrow(/FABRIKA_IAM_SIGNING_KEYS is empty/)
		}
	})

	test('an ephemeral key is generated locally, and a rejection is not cached', async () => {
		const signer = await getSigner({ FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' })
		expect(signer.jwks().keys).toHaveLength(1)

		// A rejected promise must not poison the isolate cache — a fixed configuration has to be able to
		// take effect without a restart.
		await expect(getSigner({ FABRIKA_IAM_SIGNING_KEYS: 'not json', ENVIRONMENT: 'local' })).rejects.toThrow()
		await expect(getSigner({ FABRIKA_IAM_SIGNING_KEYS: 'not json', ENVIRONMENT: 'local' })).rejects.toThrow()
		expect((await getSigner({ FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' })).jwks().keys).toHaveLength(1)
	})
})

describe('process transport secrets', () => {
	const base = {
		FABRIKA_IAM_DATABASE_URL: 'postgres://user:pw@127.0.0.1:1/none',
		ENVIRONMENT: 'stage',
		ISSUER: 'https://iam.example.com',
		FABRIKA_IAM_OIDC_ENABLED: 'false',
		FABRIKA_IAM_PASSWORD_ENABLED: 'true',
	}

	test('a SHORT key fails the boot rather than standing in front of an HTTP surface', () => {
		for (const name of ['FABRIKA_IAM_RPC_KEY', 'FABRIKA_IAM_PROXY_KEY']) {
			expect(() => createRuntime({ ...base, [name]: 'too-short' })).toThrow(new RegExp(`${name} must be at least 32 characters`))
		}
	})

	test('an ABSENT key is legal — it means that surface is off, which is the fail-closed default', () => {
		// No throw, and nothing is logged about the value either way (`rpc-http.ts` 404s the surface).
		const runtime = createRuntime(base)
		expect(runtime.config.rpcKey).toBe('')
		expect(runtime.config.proxyKey).toBe('')
	})

	test('a long enough key is accepted', () => {
		const key = `px_${'k'.repeat(40)}`
		const runtime = createRuntime({ ...base, FABRIKA_IAM_RPC_KEY: key, FABRIKA_IAM_PROXY_KEY: key })
		expect(runtime.config.rpcKey).toBe(key)
		expect(runtime.config.proxyKey).toBe(key)
	})
})

describe('the environment name', () => {
	// The BUN/Zerops half of the witness for backlog 59 — `control` and `operations` on `fabrika-test`
	// carried `ENVIRONMENT=local` while serving public `.zerops.app` hosts. The Cloudflare half is in
	// index.test.ts. What proves a process is not local is the PUBLIC ORIGIN it serves on, because that
	// is the value a misconfiguration cannot hide behind: it is the `iss` of every token it mints.
	const base = {
		FABRIKA_IAM_DATABASE_URL: 'postgres://user:pw@127.0.0.1:1/none',
		FABRIKA_IAM_OIDC_ENABLED: 'false',
		FABRIKA_IAM_PASSWORD_ENABLED: 'true',
	}

	test('a process serving a PUBLIC issuer refuses to boot as `local`', () => {
		expect(() => createRuntime({ ...base, ENVIRONMENT: 'local', ISSUER: 'https://iam-abcd-3000.prg1.zerops.app' }))
			.toThrow(/ENVIRONMENT=local is refused/)
	})

	test('the local stack still boots — it serves `*.fabrika.localhost`', () => {
		// If this breaks, `bun run local:up` breaks with it. The issuer is compose.yaml's, verbatim.
		expect(createRuntime({ ...base, ENVIRONMENT: 'local', ISSUER: 'http://iam.fabrika.localhost:18080' }).env.ENVIRONMENT).toBe('local')
	})

	test('a named installation on the same public issuer boots — the rule is about `local` alone', () => {
		expect(createRuntime({ ...base, ENVIRONMENT: 'stage', ISSUER: 'https://iam-abcd-3000.prg1.zerops.app' }).env.ENVIRONMENT).toBe('stage')
	})
})

describe('timingSafeEqualHex', () => {
	test('equal digests compare equal', async () => {
		const digest = await hashToken('px_a-real-looking-credential')
		expect(timingSafeEqualHex(digest, digest)).toBe(true)
		expect(timingSafeEqualHex(digest, await hashToken('px_a-real-looking-credential'))).toBe(true)
	})

	test('a difference in the LAST character is still a mismatch', async () => {
		// The interesting case: the loop must not stop early, so the whole string is always compared.
		const digest = await hashToken('px_a-real-looking-credential')
		const flipped = `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`
		expect(flipped).not.toBe(digest)
		expect(timingSafeEqualHex(digest, flipped)).toBe(false)
	})

	test('a difference in the FIRST character is a mismatch', async () => {
		const digest = await hashToken('px_a-real-looking-credential')
		const flipped = `${digest.startsWith('0') ? '1' : '0'}${digest.slice(1)}`
		expect(timingSafeEqualHex(digest, flipped)).toBe(false)
	})

	test('differing lengths are unequal, and never throw', async () => {
		const digest = await hashToken('px_a-real-looking-credential')
		expect(timingSafeEqualHex(digest, digest.slice(0, 32))).toBe(false)
		expect(timingSafeEqualHex(digest.slice(0, 32), digest)).toBe(false)
		expect(timingSafeEqualHex('', digest)).toBe(false)
		expect(timingSafeEqualHex('', '')).toBe(true)
	})
})
