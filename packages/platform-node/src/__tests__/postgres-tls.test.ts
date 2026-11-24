// A managed PostgreSQL (RDS, Azure Database for PostgreSQL, Cloud SQL) is reached over TLS, and the platform must check
// the server's certificate and name rather than only encrypt: `sslmode=verify-full` with the cloud's CA bundle named by
// `sslrootcert`. The connection URL is the whole configuration, so these tests hold two things: every URL the platform
// derives from a provisioning credential keeps those parameters, and Bun's client honours them against a real server.
//
// The server half needs FABRIKA_TEST_POSTGRES_TLS_URL (a superuser URL WITHOUT TLS parameters, whose host is `localhost`)
// and FABRIKA_TEST_POSTGRES_TLS_CA (the PEM of the CA that signed the server's certificate, which names `localhost` and
// not `127.0.0.1`); `docs/reference/portability-surface.md` ("PostgreSQL over TLS") shows how to start one. It skips
// cleanly without them.

import { SQL } from 'bun'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applicationRuntimeUrl } from '../application-postgres-migrations'
import { postgresRoleUrl, scramVerifier } from '../application-postgres-roles'
import { PostgresDatabase } from '../sql-postgres'

const TLS_PARAMETERS = 'sslmode=verify-full&sslrootcert=%2Fetc%2Ffabrika%2Fdatabase-ca.pem'

describe("a derived role URL keeps the provisioning URL's TLS parameters", () => {
	const provisioning = `postgresql://fabrika_admin:${encodeURIComponent('pass/word+1')}@db.example.internal:5432/fabrika?${TLS_PARAMETERS}`

	test('postgresRoleUrl', () => {
		const url = new URL(postgresRoleUrl(provisioning, 'run_tasks'))
		expect(url.username).toBe('run_tasks')
		expect(url.host).toBe('db.example.internal:5432')
		expect(url.searchParams.get('sslmode')).toBe('verify-full')
		expect(url.searchParams.get('sslrootcert')).toBe('/etc/fabrika/database-ca.pem')
	})

	test('applicationRuntimeUrl', () => {
		const url = new URL(applicationRuntimeUrl(provisioning, 'tasks'))
		expect(url.username).toBe('run_tasks')
		expect(url.searchParams.get('sslmode')).toBe('verify-full')
		expect(url.searchParams.get('sslrootcert')).toBe('/etc/fabrika/database-ca.pem')
	})
})

const serverUrl = process.env['FABRIKA_TEST_POSTGRES_TLS_URL'] ?? ''
const caFile = process.env['FABRIKA_TEST_POSTGRES_TLS_CA'] ?? ''
const hasServer = serverUrl !== '' && caFile !== ''
if (!hasServer) {
	console.warn('postgres-tls.test.ts: the server half skipped: set FABRIKA_TEST_POSTGRES_TLS_URL and FABRIKA_TEST_POSTGRES_TLS_CA to run it')
}

/** The server URL with `parameters` as its query, and `host` in place of its own. */
const withTls = (parameters: Record<string, string>, host?: string): string => {
	const url = new URL(serverUrl)
	if (host !== undefined) url.hostname = host
	url.search = new URLSearchParams(parameters).toString()
	return url.toString()
}

/**
 * A CA that signed nothing the test server holds: a fixed self-signed certificate, its public part only. A bundle of the
 * wrong cloud, or a stale one, looks like this to the client.
 */
const UNRELATED_CA = [
	'-----BEGIN CERTIFICATE-----',
	'MIIBnzCCAUWgAwIBAgIUf9VV+UiZv4Da8GWXxXTSihNYO14wCgYIKoZIzj0EAwIw',
	'JDEiMCAGA1UEAwwZZmFicmlrYS11bnJlbGF0ZWQtdGVzdC1jYTAgFw0yNjExMjQw',
	'MDQ4MzhaGA8yMTI2MTAzMTAwNDgzOFowJDEiMCAGA1UEAwwZZmFicmlrYS11bnJl',
	'bGF0ZWQtdGVzdC1jYTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABAsWXDKZhR9k',
	'MGJxtL/5KDrJRNMjsheDQotu0NZT4KxRIRpnKKELCHvW6wOu/U+qAjN+qydMaRnN',
	'0FdkYuPDEOCjUzBRMB0GA1UdDgQWBBTJ95TAoEDvUVYBptqA4OooqLvh9TAfBgNV',
	'HSMEGDAWgBTJ95TAoEDvUVYBptqA4OooqLvh9TAPBgNVHRMBAf8EBTADAQH/MAoG',
	'CCqGSM49BAMCA0gAMEUCIQCYYnBh3ZMdAqoXXKcK/5BJ2slaURwhESB0iksNhCFh',
	'vQIgMZ2UuH4XMgJ2O3rgPCOj9LPxvpVCXz1c4tlBjC0EP6s=',
	'-----END CERTIFICATE-----',
	'',
].join('\n')

/** The session `url` opens: encrypted or not, or the refusal's code and message (Bun is pinned, so the codes hold). */
type Session = { readonly ssl: boolean } | { readonly code: string; readonly message: string }

const session = async (url: string): Promise<Session> => {
	const database = PostgresDatabase.connect(url, { max: 1 })
	try {
		const row = await database.prepare('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()').first<{ ssl: boolean }>()
		if (row === null) throw new Error('no pg_stat_ssl row for the session')
		return { ssl: row.ssl }
	} catch (error) {
		if (!(error instanceof Error)) throw error
		return { code: 'code' in error && typeof error.code === 'string' ? error.code : '', message: error.message }
	} finally {
		await database.close()
	}
}

describe.skipIf(!hasServer)('sslmode=verify-full against a server signed by a private CA', () => {
	test('the server is reached over TLS when the URL names its CA', async () => {
		expect(await session(withTls({ sslmode: 'verify-full', sslrootcert: caFile }))).toEqual({ ssl: true })
	})

	test('a server whose CA is not named is refused for its chain', async () => {
		expect(await session(withTls({ sslmode: 'verify-full' }))).toMatchObject({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
	})

	test('a server signed by another CA than the one named is refused for its chain', async () => {
		const scratch = await mkdtemp(join(tmpdir(), 'fabrika-tls-'))
		try {
			const unrelated = join(scratch, 'unrelated-ca.pem')
			await writeFile(unrelated, UNRELATED_CA)
			expect(await session(withTls({ sslmode: 'verify-full', sslrootcert: unrelated }))).toMatchObject({
				code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
			})
		} finally {
			await rm(scratch, { recursive: true, force: true })
		}
	})

	test('a host the certificate does not name is refused for its name, though the CA signed it', async () => {
		expect(await session(withTls({ sslmode: 'verify-full', sslrootcert: caFile }, '127.0.0.1'))).toMatchObject({
			code: 'ERR_TLS_CERT_ALTNAME_INVALID',
		})
	})

	test('a missing CA file is refused as a file, not ignored', async () => {
		expect(await session(withTls({ sslmode: 'verify-full', sslrootcert: '/nonexistent/fabrika-ca.pem' }))).toMatchObject({
			code: 'ERR_INVALID_ARG_TYPE',
			message: expect.stringContaining('caFile'),
		})
	})

	test('a role URL derived from a verify-full provisioning URL connects over TLS', async () => {
		const provisioning = withTls({ sslmode: 'verify-full', sslrootcert: caFile })
		const admin = new SQL({ url: provisioning, adapter: 'postgres', max: 1 })
		const role = `run_tls_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
		try {
			// As the runner does: the derived password reaches the server only as its SCRAM verifier.
			const password = decodeURIComponent(new URL(postgresRoleUrl(provisioning, role)).password)
			await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${scramVerifier(password)}'`)
			expect(await session(postgresRoleUrl(provisioning, role))).toEqual({ ssl: true })
		} finally {
			await admin.unsafe(`DROP ROLE IF EXISTS ${role}`)
			await admin.close()
		}
	})
})
