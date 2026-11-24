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

/** Whether the session `url` opens is encrypted, or the refusal's message. */
const sessionEncryption = async (url: string): Promise<boolean | string> => {
	const database = PostgresDatabase.connect(url, { max: 1 })
	try {
		const row = await database.prepare('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()').first<{ ssl: boolean }>()
		return row?.ssl ?? 'no pg_stat_ssl row'
	} catch (error) {
		return error instanceof Error ? error.message : 'refused'
	} finally {
		await database.close()
	}
}

describe.skipIf(!hasServer)('sslmode=verify-full against a server signed by a private CA', () => {
	test('the server is reached over TLS when the URL names its CA', async () => {
		expect(await sessionEncryption(withTls({ sslmode: 'verify-full', sslrootcert: caFile }))).toBe(true)
	})

	test('a server whose CA is not named is refused', async () => {
		expect(await sessionEncryption(withTls({ sslmode: 'verify-full' }))).toBeString()
	})

	test('a host the certificate does not name is refused, though the CA signed it', async () => {
		expect(await sessionEncryption(withTls({ sslmode: 'verify-full', sslrootcert: caFile }, '127.0.0.1'))).toBeString()
	})

	test('a missing CA file is refused, not ignored', async () => {
		expect(await sessionEncryption(withTls({ sslmode: 'verify-full', sslrootcert: '/nonexistent/fabrika-ca.pem' }))).toBeString()
	})

	test('a role URL derived from a verify-full provisioning URL connects over TLS', async () => {
		const provisioning = withTls({ sslmode: 'verify-full', sslrootcert: caFile })
		const admin = new SQL({ url: provisioning, adapter: 'postgres', max: 1 })
		const role = `run_tls_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
		// As the runner does: the derived password reaches the server only as its SCRAM verifier.
		const password = decodeURIComponent(new URL(postgresRoleUrl(provisioning, role)).password)
		await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${scramVerifier(password)}'`)
		try {
			expect(await sessionEncryption(postgresRoleUrl(provisioning, role))).toBe(true)
		} finally {
			await admin.unsafe(`DROP ROLE IF EXISTS ${role}`)
			await admin.close()
		}
	})
})
