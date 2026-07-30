import { buildCaddyConfig, type ProxyManifest } from '@fabrika/proxy'
import { notesGates } from '@fabrika/example-zerops-app/gates'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
export const LOCAL_STACK_DIR = resolve(REPO_ROOT, 'packages', 'local-stack')
export const STATE_DIR = resolve(LOCAL_STACK_DIR, '.state')
export const COMPOSE_FILE = resolve(LOCAL_STACK_DIR, 'compose.yaml')

const IAM_ISSUER = 'http://iam.localhost:18080'

const statePath = (name: string): string => resolve(STATE_DIR, name)

const randomSecret = (): string => randomBytes(32).toString('base64url')

const writeEnv = async (name: string, values: Record<string, string>): Promise<void> => {
	const lines = Object.entries(values).map(([key, value]) => {
		if (value.includes('\n') || value.includes('\r')) {
			throw new Error(`${key} cannot contain a newline`)
		}
		return `${key}=${value}`
	})
	await Bun.write(statePath(name), `${lines.join('\n')}\n`)
}

const writeJson = (name: string, value: unknown): Promise<number> =>
	Bun.write(statePath(name), `${JSON.stringify(value, null, '\t')}\n`)

const generateSecrets = async (): Promise<void> => {
	const requiredFiles = [
		'platform-db.env',
		'apps-db.env',
		'minio.env',
		'iam.env',
		'control.env',
		'platform-proxy.env',
		'apps-proxy.env',
		'notes.env',
		'emulator.env',
	]
	if (requiredFiles.every((file) => existsSync(statePath(file)))) {
		return
	}

	const platformDatabasePassword = randomSecret()
	const appsDatabasePassword = randomSecret()
	const minioPassword = randomSecret()
	const rpcKey = `px_${randomSecret()}`
	const proxyKey = `px_${randomSecret()}`
	const provisioningKey = `px_${randomSecret()}`
	const emulatorToken = randomSecret()
	const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
	const signingKeys = JSON.stringify([privateKey.export({ format: 'jwk' })])

	await Promise.all([
		writeEnv('platform-db.env', { POSTGRES_PASSWORD: platformDatabasePassword }),
		writeEnv('apps-db.env', { POSTGRES_DB: 'notes', POSTGRES_PASSWORD: appsDatabasePassword }),
		writeEnv('minio.env', { MINIO_ROOT_USER: 'fabrika-local', MINIO_ROOT_PASSWORD: minioPassword }),
		writeEnv('iam.env', {
			PROPUSTKA_DATABASE_URL: `postgres://postgres:${platformDatabasePassword}@platform-db:5432/iam`,
			PROPUSTKA_SIGNING_KEYS: signingKeys,
			PROPUSTKA_RPC_KEY: rpcKey,
			PROPUSTKA_PROXY_KEY: proxyKey,
			PROPUSTKA_PROVISIONING_KEY: provisioningKey,
		}),
		writeEnv('control.env', {
			VOZKA_DATABASE_URL: `postgres://postgres:${platformDatabasePassword}@platform-db:5432/control`,
			VOZKA_RUN_LOGS_ACCESS_KEY_ID: 'fabrika-local',
			VOZKA_RUN_LOGS_SECRET_ACCESS_KEY: minioPassword,
			PROPUSTKA_RPC_KEY: rpcKey,
			PROPUSTKA_PROVISIONING_KEY: provisioningKey,
			VOZKA_VAULT_KEY: randomSecret(),
			ZEROPS_ACCESS_TOKEN: emulatorToken,
			ZEROPS_PROXY_IAM_KEY: proxyKey,
		}),
		writeEnv('platform-proxy.env', { FABRIKA_IAM_KEY: proxyKey }),
		writeEnv('apps-proxy.env', { FABRIKA_IAM_KEY: proxyKey }),
		writeEnv('notes.env', {
			NOTES_DATABASE_URL: `postgres://postgres:${appsDatabasePassword}@apps-db:5432/notes`,
		}),
		writeEnv('emulator.env', { LOCAL_ZEROPS_TOKEN: emulatorToken }),
	])
}

const generateProxyConfigs = async (): Promise<void> => {
	const platformManifest: ProxyManifest = {
		apps: [
			{
				id: 'iam-local',
				hosts: ['iam.localhost'],
				upstream: 'iam:18080',
				gates: { rules: [{ path: '/*', kind: 'public' }] },
			},
			{
				id: 'vozka',
				hosts: ['control.localhost'],
				upstream: 'control:3000',
				gates: { rules: [{ path: '/*', kind: 'public' }] },
			},
		],
	}
	const appsManifest: ProxyManifest = {
		apps: [{
			id: 'notes',
			hosts: ['notes.localhost'],
			upstream: 'notes:3000',
			gates: notesGates,
		}],
	}
	await Promise.all([
		writeJson('platform-proxy.manifest.json', platformManifest),
		writeJson('platform-caddy.json', buildCaddyConfig(platformManifest, {
			authUpstream: '127.0.0.1:9000',
			listen: [':18080'],
			healthListen: [':19080'],
		})),
		writeJson('apps-proxy.manifest.json', appsManifest),
		writeJson('apps-caddy.json', buildCaddyConfig(appsManifest, {
			authUpstream: '127.0.0.1:9000',
			listen: [':18081'],
			healthListen: [':19081'],
		})),
	])
}

const run = async (command: string[]): Promise<void> => {
	const process = Bun.spawn(command, { cwd: REPO_ROOT, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
	const exitCode = await process.exited
	if (exitCode !== 0) {
		throw new Error(`${command[0] ?? 'command'} failed with exit code ${exitCode}`)
	}
}

export const prepareLocalStack = async (): Promise<void> => {
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
	await run(['cpu-lease', 'run', '-n', '2', '--', 'bun', 'run', '--filter', '@fabrika/iam-ui', 'build'])
	await run(['cpu-lease', 'run', '-n', '2', '--', 'bun', 'run', '--filter', '@fabrika/dashboard', 'build'])
	await generateSecrets()
	await generateProxyConfigs()
	console.info(`Local stack prepared for ${IAM_ISSUER}`)
}

if (import.meta.main) {
	prepareLocalStack().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : 'local stack preparation failed')
		process.exit(1)
	})
}
