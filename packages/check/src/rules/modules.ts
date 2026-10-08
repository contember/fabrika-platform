import type { Report } from '../finding'
import { isIgnoredSegment, isRelativeSpecifier, joinRelative, resolveRelative } from '../layout'
import type { ModuleReference } from '../references'
import { type ImportMappings, mappedTargets } from '../resolution'

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
	...['@aws-sdk/client-s3', '@aws-sdk/lib-storage', '@aws-sdk/s3-request-presigner', 'aws-sdk', 'minio', 'aws4fetch'].map((
		name,
	): [string, Forbidden] => [name, STORAGE]),
	['jose', TOKENS],
	...['http', 'https', 'http2', 'net', 'tls', 'dgram'].map((name): [string, Forbidden] => [name, NETWORK]),
	['child_process', PROCESSES],
])

/** The `Bun` globals that open a server, a socket, a database, a bucket or a process; imported by name from `bun`, the same bypass. */
export const FORBIDDEN_BUN_MEMBERS: ReadonlyMap<string, Forbidden> = new Map([
	...['sql', 'SQL'].map((name): [string, Forbidden] => [name, DATABASE]),
	...['S3Client', 's3'].map((name): [string, Forbidden] => [name, STORAGE]),
	...['serve', 'connect', 'listen', 'udpSocket'].map((name): [string, Forbidden] => [name, NETWORK]),
	...['spawn', 'spawnSync', '$'].map((name): [string, Forbidden] => [name, PROCESSES]),
])

/** `node:http` and `http` name one module; `pg/lib/client` belongs to `pg`. */
const packageName = (specifier: string): string => {
	const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
	const segments = bare.split('/')
	return bare.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? bare)
}

const ALLOWED_ENV = 'values the framework hands the handler through deps or ctx'

/** A path from the root that a mapping or an import lands on, judged by where the checker reads. */
const containmentProblem = (target: string | undefined): string | undefined => {
	if (target === undefined) return 'resolves outside the application root, where the checker does not look'
	if (target.split('/').some(isIgnoredSegment)) return 'resolves into a directory the checker skips'
	return undefined
}

const checkPackage = (reference: ModuleReference, specifier: string, report: Report, isGeneratedEntry: boolean): void => {
	const { node } = reference
	const name = packageName(specifier)
	const forbidden = FORBIDDEN_PACKAGES.get(name)
	if (forbidden !== undefined) {
		report(node, 'forbidden-import', `'${specifier}' is ${forbidden.what}`, forbidden.allowed)
		return
	}
	if (name === 'bun') {
		for (const imported of reference.names) {
			const member = FORBIDDEN_BUN_MEMBERS.get(imported)
			if (member !== undefined) report(node, 'forbidden-global', `'${imported}' from 'bun' is ${member.what}`, member.allowed)
			else if (imported === '*' || imported === 'default') {
				report(node, 'forbidden-global', `'bun' loaded whole hides which of its members is used`, 'named imports from bun')
			}
		}
	}
	const takesEnvironment = reference.names.some((imported) => imported === 'env' || imported === '*' || imported === 'default')
	if (name === 'process' && takesEnvironment && !isGeneratedEntry) report(node, 'env-read', `'${specifier}' loaded for its environment`, ALLOWED_ENV)
}

export const checkModuleReferences = (
	file: string,
	references: readonly ModuleReference[],
	mappings: ImportMappings,
	exists: (path: string) => boolean,
	report: Report,
	isGeneratedEntry: boolean,
): void => {
	for (const reference of references) {
		const { specifier, node } = reference
		if (specifier.startsWith('/') || /^file:/i.test(specifier)) {
			report(
				node,
				'unchecked-import',
				`'${specifier}' is an absolute path, outside what the checker reads`,
				'a relative import of a module inside the application',
			)
			continue
		}
		if (isRelativeSpecifier(specifier)) {
			const problem = containmentProblem(joinRelative(file, specifier))
			if (problem !== undefined) {
				report(node, 'unchecked-import', `'${specifier}' ${problem}`, 'a module inside the application, outside node_modules, dist and dot-directories')
				continue
			}
			const resolution = resolveRelative(exists, file, specifier)
			const packageEntry = resolution.kind === 'directory' && resolution.paths.some((path) => path.endsWith('/package.json'))
			if (resolution.kind === 'ambiguous' || packageEntry) {
				const what = packageEntry
					? 'is a directory with a package.json, whose entry point Bun follows'
					: `resolves to each of ${resolution.paths.join(', ')}`
				report(
					node,
					'unchecked-import',
					`'${specifier}' ${what}, which the checker does not resolve as Bun does`,
					'a relative import that names the module file, extension included',
				)
			}
			continue
		}
		const targets = mappedTargets(mappings, specifier)
		if (targets === undefined) {
			if (!reference.typeOnly) checkPackage(reference, specifier, report, isGeneratedEntry)
			continue
		}
		for (const target of targets) {
			if (!isRelativeSpecifier(target) && !target.startsWith('/')) {
				if (!reference.typeOnly) checkPackage(reference, target, report, isGeneratedEntry)
				continue
			}
			// Mapping targets are relative to the root, where both package.json and tsconfig.json live.
			const problem = containmentProblem(target.startsWith('/') ? undefined : joinRelative('package.json', target))
			if (problem !== undefined) {
				report(node, 'unchecked-import', `'${specifier}' is mapped to '${target}', which ${problem}`, 'a mapping onto a module inside the application')
			}
		}
	}
}
