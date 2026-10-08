import type { Report } from '../finding'
import { isIgnoredSegment, isRelativeSpecifier, joinRelative } from '../layout'
import type { ModuleReference } from '../references'

interface Forbidden {
	readonly what: string
	readonly allowed: string
}

const DATABASE: Forbidden = { what: 'a database driver', allowed: 'the scoped data layer of @fabrika/db, reached through ctx' }
const STORAGE: Forbidden = { what: 'an S3 client', allowed: 'a file collection declared in the contract (c.files)' }
const TOKENS: Forbidden = { what: 'a token library', allowed: 'the principal the framework verified, on ctx' }
const NETWORK: Forbidden = {
	what: 'a raw network module',
	allowed: 'endpoints declared in the contract; another application through a connector import',
}
const PROCESSES: Forbidden = { what: 'a process-spawning module', allowed: 'a job declared in the contract (c.cron)' }

const FORBIDDEN_PACKAGES: ReadonlyMap<string, Forbidden> = new Map([
	...[
		'pg',
		'pg-native',
		'postgres',
		'@neondatabase/serverless',
		'@vercel/postgres',
		'@electric-sql/pglite',
		'mysql',
		'mysql2',
		'mariadb',
		'sqlite',
		'sqlite3',
		'better-sqlite3',
		'bun:sqlite',
		'@libsql/client',
		'mongodb',
		'mongoose',
		'redis',
		'ioredis',
		'kysely',
		'kysely-postgres-js',
		'drizzle-orm',
		'@prisma/client',
		'knex',
		'typeorm',
		'sequelize',
	].map((name): [string, Forbidden] => [name, DATABASE]),
	...['@aws-sdk/client-s3', '@aws-sdk/lib-storage', '@aws-sdk/s3-request-presigner', 'minio', 'aws4fetch'].map((
		name,
	): [string, Forbidden] => [name, STORAGE]),
	['jose', TOKENS],
	...['http', 'https', 'http2', 'net', 'tls', 'dgram'].map((name): [string, Forbidden] => [name, NETWORK]),
	['child_process', PROCESSES],
])

/** The `Bun` globals that open a server, a socket, a database or a process; imported by name from `bun`, they are the same bypass. */
export const FORBIDDEN_BUN_MEMBERS: ReadonlySet<string> = new Set([
	'sql',
	'SQL',
	'serve',
	'spawn',
	'spawnSync',
	'connect',
	'listen',
	'udpSocket',
	'$',
])
export const FORBIDDEN_BUN_ALLOWED = 'a declared endpoint, the data layer or a job; the framework serves and connects'

/** `node:http` and `http` name one module; `pg/lib/client` belongs to `pg`. */
const packageName = (specifier: string): string => {
	const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
	const segments = bare.split('/')
	return bare.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? bare)
}

export const checkModuleReferences = (file: string, references: readonly ModuleReference[], report: Report, isGeneratedEntry: boolean): void => {
	for (const reference of references) {
		const { specifier, node } = reference
		if (isRelativeSpecifier(specifier)) {
			const target = joinRelative(file, specifier)
			if (target === undefined) {
				report(
					node,
					'unchecked-import',
					`'${specifier}' resolves outside the application root, where the checker does not look`,
					'a module inside the application',
				)
			} else if (target.split('/').some(isIgnoredSegment)) {
				report(
					node,
					'unchecked-import',
					`'${specifier}' resolves into a directory the checker skips`,
					'a module outside node_modules, dist and dot-directories',
				)
			}
			continue
		}
		if (reference.typeOnly) continue
		const name = packageName(specifier)
		const forbidden = FORBIDDEN_PACKAGES.get(name)
		if (forbidden !== undefined) {
			report(node, 'forbidden-import', `'${specifier}' is ${forbidden.what}`, forbidden.allowed)
			continue
		}
		if (name === 'bun') {
			for (const imported of reference.names) {
				if (FORBIDDEN_BUN_MEMBERS.has(imported)) {
					report(node, 'forbidden-global', `'${imported}' imported from 'bun' bypasses the framework`, FORBIDDEN_BUN_ALLOWED)
				} else if (imported === '*' || imported === 'default') {
					report(node, 'forbidden-global', `'bun' imported whole hides which of its globals is used`, 'named imports from bun')
				}
			}
		}
		if (
			name === 'process' && !isGeneratedEntry && reference.names.some((imported) => imported === 'env' || imported === '*' || imported === 'default')
		) {
			report(node, 'env-read', `'${specifier}' imported for its environment`, 'values the framework hands the handler through deps or ctx')
		}
	}
}
