import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { z } from 'zod'

const ROOT = resolve(import.meta.dir, '..')
type DependencyField = 'dependencies' | 'optionalDependencies' | 'peerDependencies'

const DEPENDENCY_FIELDS: readonly DependencyField[] = ['dependencies', 'optionalDependencies', 'peerDependencies']
const PACKED_DEPENDENCY_FIELDS: readonly (DependencyField | 'devDependencies')[] = [...DEPENDENCY_FIELDS, 'devDependencies']
const EXPECTED_PUBLIC_PACKAGES = [
	'@fabrika/annotations',
	'@fabrika/app',
	'@fabrika/auth',
	'@fabrika/auth-core',
	'@fabrika/builder',
	'@fabrika/canvas-kernel',
	'@fabrika/check',
	'@fabrika/cli',
	'@fabrika/control-contract',
	'@fabrika/daemon-kit',
	'@fabrika/db',
	'@fabrika/email',
	'@fabrika/github-app',
	'@fabrika/iam-contract',
	'@fabrika/installation-init',
	'@fabrika/jwks',
	'@fabrika/operations-contract',
	'@fabrika/platform',
	'@fabrika/platform-node',
	'@fabrika/provider-cloudflare',
	'@fabrika/provider-contract',
	'@fabrika/provider-zerops',
	'@fabrika/proxy-core',
]
const TAG_PATTERN =
	/^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/

interface PackageInfo {
	readonly name: string
	readonly directory: string
	readonly manifest: Record<string, unknown>
	readonly dependencies: DependencyMaps
	readonly publishable: boolean
}

interface ReleasePackage {
	readonly name: string
	readonly filename: string
	readonly dependencies: readonly string[]
	/** The sha512 of the tarball's bytes, as npm and bun record it: what `fabrika-check --packed` compares. */
	readonly integrity: string
}

interface ReleaseManifest {
	readonly tag: string
	readonly version: string
	readonly packages: readonly ReleasePackage[]
}

interface Options {
	readonly command: string
	readonly tag: string
	readonly version: string
	/** `pack --local`: the version is derived, not tagged, and the pack also writes the block that installs it. */
	readonly local: boolean
	/** The version the skill's example pins name: the release itself, or for a local pack the last published one. */
	readonly pinnedVersion: string
	readonly artifactsDirectory: string
	readonly dryRun: boolean
	readonly positional: readonly string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmptyString = z.string().min(1)
// Zod 3 object/record outputs omit __proto__; entry tuples retain every own JSON key.
const recordEntriesSchema = z.unknown().transform((value, context) => {
	if (!isRecord(value)) {
		context.addIssue({ code: z.ZodIssueCode.invalid_type, expected: 'object', received: z.getParsedType(value) })
		return z.NEVER
	}
	return Object.entries(value)
})
const manifestFieldsSchema = recordEntriesSchema.transform((entries) => Object.fromEntries(entries))
const stringRecordSchema = recordEntriesSchema.pipe(z.array(z.tuple([z.string(), z.string()])))
	.transform((entries) => Object.fromEntries(entries))
const dependencyMapsSchema = z.object({
	dependencies: stringRecordSchema.optional(),
	optionalDependencies: stringRecordSchema.optional(),
	peerDependencies: stringRecordSchema.optional(),
})
type DependencyMaps = z.infer<typeof dependencyMapsSchema>
const packageManifestSchema = z.object({ name: nonEmptyString }).passthrough()
const packageIdentitySchema = packageManifestSchema.extend({ version: nonEmptyString })
const publicManifestSchema = packageIdentitySchema.merge(dependencyMapsSchema).passthrough()
const packedManifestSchema = publicManifestSchema.extend({ devDependencies: stringRecordSchema.optional() })
type ExportTarget = string | null | ExportTarget[] | { [key: string]: ExportTarget }
const exportTargetSchema: z.ZodType<ExportTarget, z.ZodTypeDef, unknown> = z.lazy(() =>
	z.union([
		z.string(),
		z.null(),
		z.array(exportTargetSchema),
		recordEntriesSchema.pipe(z.array(z.tuple([z.string(), exportTargetSchema]))).transform((entries) => Object.fromEntries(entries)),
	])
)
const binTargetsSchema = z.union([z.string(), stringRecordSchema]).optional()
const releaseManifestSchema = z.object({
	tag: nonEmptyString,
	version: nonEmptyString,
	packages: z.array(z.object({
		name: nonEmptyString,
		filename: nonEmptyString,
		dependencies: z.array(z.string()),
		integrity: z.string().startsWith('sha512-'),
	})),
})

const parseJson = (text: string, source: string): unknown => {
	try {
		return JSON.parse(text)
	} catch (error) {
		throw new Error(`${source}: invalid JSON`, { cause: error })
	}
}

export const parsePackageManifest = (text: string, source: string) => {
	const fields = manifestFieldsSchema.parse(parseJson(text, source), { path: [source] })
	return { ...fields, ...packageManifestSchema.parse(fields, { path: [source] }) }
}
export const parsePackedManifest = (text: string, source: string) => {
	const fields = manifestFieldsSchema.parse(parseJson(text, source), { path: [source] })
	return { ...fields, ...packedManifestSchema.parse(fields, { path: [source] }) }
}
export const parseInstalledManifest = (text: string, source: string) => {
	const fields = manifestFieldsSchema.parse(parseJson(text, source), { path: [source] })
	return { ...fields, ...packageIdentitySchema.parse(fields, { path: [source] }) }
}
export const parseReleaseManifest = (text: string, source: string): ReleaseManifest =>
	releaseManifestSchema.parse(parseJson(text, source), { path: [source] })

const dependencyMap = (item: PackageInfo, field: DependencyField): ReadonlyMap<string, string> =>
	new Map(Object.entries(item.dependencies[field] ?? {}))

export const packageInfo = (text: string, directory: string): PackageInfo => {
	const manifestPath = join(directory, 'package.json')
	const manifest = parsePackageManifest(text, manifestPath)
	const name = manifest.name
	const isPrivate = manifest['private'] === true
	const publishConfig = manifest['publishConfig']
	const publishable = isRecord(publishConfig) && publishConfig['access'] === 'public'
	if (!isPrivate && !publishable) throw new Error(`${name}: package must be private or declare publishConfig.access as public`)
	if (isPrivate && publishable) throw new Error(`${name}: private package must not declare public publishing`)
	if (!publishable) return { name, directory, manifest, dependencies: {}, publishable }
	const validated = publicManifestSchema.parse(manifest, { path: [manifestPath] })
	return { name, directory, manifest: { ...manifest, ...validated }, dependencies: validated, publishable }
}

export const readPackages = async (): Promise<readonly PackageInfo[]> => {
	const entries = await readdir(join(ROOT, 'packages'), { withFileTypes: true })
	const packages: PackageInfo[] = []
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isDirectory()) continue
		const directory = join(ROOT, 'packages', entry.name)
		const manifestPath = join(directory, 'package.json')
		if (!(await Bun.file(manifestPath).exists())) continue
		packages.push(packageInfo(await readFile(manifestPath, 'utf8'), directory))
	}
	return packages
}

export const packageGraph = (
	packages: readonly PackageInfo[],
): { readonly publicPackages: readonly PackageInfo[]; readonly order: readonly PackageInfo[] } => {
	const byName = new Map(packages.map((item) => [item.name, item]))
	if (byName.size !== packages.length) throw new Error('Package names must be unique')
	const publicPackages = packages.filter((item) => item.publishable)
	const publicNames = publicPackages.map((item) => item.name).sort()
	if (JSON.stringify(publicNames) !== JSON.stringify(EXPECTED_PUBLIC_PACKAGES)) {
		throw new Error(`Public package inventory changed; update EXPECTED_PUBLIC_PACKAGES deliberately:\n${publicNames.join('\n')}`)
	}
	const sourceVersions = new Set<string>()
	for (const item of publicPackages) {
		if (!item.name.startsWith('@fabrika/')) throw new Error(`${item.name}: public package must use the @fabrika scope`)
		const sourceVersion = item.manifest['version']
		if (typeof sourceVersion !== 'string') throw new Error(`${item.name}: version must be a non-empty string`)
		if (!TAG_PATTERN.test(`v${sourceVersion}`)) throw new Error(`${item.name}: version must be valid semver`)
		sourceVersions.add(sourceVersion)
		for (const field of DEPENDENCY_FIELDS) {
			for (const [dependency, range] of dependencyMap(item, field)) {
				if (!range.startsWith('workspace:')) continue
				const target = byName.get(dependency)
				if (target === undefined) throw new Error(`${item.name}: ${field}.${dependency} refers to a missing workspace package`)
				if (!target.publishable) {
					throw new Error(`${item.name}: public ${field} must not depend on private package ${dependency}`)
				}
			}
		}
		for (const field of DEPENDENCY_FIELDS) {
			for (const [dependency, range] of dependencyMap(item, field)) {
				if (byName.has(dependency) && !range.startsWith('workspace:')) {
					throw new Error(`${item.name}: local ${field}.${dependency} must use the workspace protocol`)
				}
			}
		}
	}
	if (sourceVersions.size !== 1) throw new Error(`Public package source versions must match: ${[...sourceVersions].sort().join(', ')}`)

	const publicByName = new Map(publicPackages.map((item) => [item.name, item]))
	const visiting = new Set<string>()
	const visited = new Set<string>()
	const order: PackageInfo[] = []
	const visit = (item: PackageInfo, path: readonly string[]): void => {
		if (visited.has(item.name)) return
		if (visiting.has(item.name)) throw new Error(`Public package dependency cycle: ${[...path, item.name].join(' -> ')}`)
		visiting.add(item.name)
		for (const field of DEPENDENCY_FIELDS) {
			for (const dependency of dependencyMap(item, field).keys()) {
				const target = publicByName.get(dependency)
				if (target !== undefined) visit(target, [...path, item.name])
			}
		}
		visiting.delete(item.name)
		visited.add(item.name)
		order.push(item)
	}
	for (const item of publicPackages) visit(item, [])
	return { publicPackages, order }
}

const run = async (
	command: readonly string[],
	options: { readonly cwd?: string } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> => {
	const process = Bun.spawn([...command], { cwd: options.cwd ?? ROOT, stdout: 'pipe', stderr: 'pipe', env: processEnv() })
	const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
	if (exitCode !== 0) throw new Error(`${command.join(' ')} failed (${exitCode})\n${stderr || stdout}`)
	return { stdout, stderr }
}

const processEnv = (): Record<string, string | undefined> => ({ ...process.env, NO_COLOR: '1' })

const resolveTag = async (explicit: string | undefined): Promise<{ readonly tag: string; readonly version: string }> => {
	let tag = explicit ?? process.env['RELEASE_TAG'] ?? process.env['GITHUB_REF_NAME']
	if (tag === undefined || tag === '') {
		try {
			tag = (await run(['git', 'describe', '--tags', '--exact-match', '--match', 'v*'])).stdout.trim()
		} catch {
			throw new Error('Release tag is required. Pass --tag=v1.2.3 or set RELEASE_TAG.')
		}
	}
	const match = TAG_PATTERN.exec(tag)
	if (match?.[1] === undefined) throw new Error(`Invalid release tag ${JSON.stringify(tag)}; expected v<semver>`)
	return { tag, version: match[1] }
}

const COMMANDS: readonly string[] = ['validate', 'pack', 'smoke', 'publish', 'registry-smoke', 'example-pin']

/** The package whose published version a local pack builds on. */
const LOCAL_BASE_PACKAGE = '@fabrika/app'

/**
 * The version of a local pack: a prerelease of the last published version, named after the commit. npm never has it,
 * so nothing resolves it from the registry by accident. The `g` keeps an all-digit abbreviation such as `0123456`
 * from being a numeric identifier, which SemVer refuses with a leading zero.
 */
export const localVersion = (published: string, commit: string): string => {
	if (!/^\d+\.\d+\.\d+$/.test(published)) throw new Error(`${LOCAL_BASE_PACKAGE}: the published version ${JSON.stringify(published)} is not a release`)
	if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`the commit ${JSON.stringify(commit)} is not a git object name`)
	return `${published}-local.g${commit}`
}

/** `pack --local`'s version and the published version it builds on, which the skill's example pins keep naming. */
const resolveLocalVersion = async (): Promise<{ readonly version: string; readonly published: string }> => {
	const published = await distTagVersion(LOCAL_BASE_PACKAGE, 'latest')
	if (published === undefined) throw new Error(`${LOCAL_BASE_PACKAGE} has no latest version on npm to build a local pack on`)
	const commit = (await run(['git', 'rev-parse', '--short', 'HEAD'])).stdout.trim()
	return { version: localVersion(published, commit), published }
}

/** The one command that takes a path. Everywhere else a bare word is a typo, and `publish oops` must not publish. */
const POSITIONAL_COMMAND = 'example-pin'

export const parseOptions = async (argv: readonly string[]): Promise<Options> => {
	const command = argv[0] ?? 'validate'
	let tagArgument: string | undefined
	let artifactsDirectory = join(ROOT, '.release')
	let dryRun = false
	let local = false
	const positional: string[] = []
	for (const argument of argv.slice(1)) {
		if (argument.startsWith('--tag=')) tagArgument = argument.slice('--tag='.length)
		else if (argument.startsWith('--artifacts=')) artifactsDirectory = resolve(ROOT, argument.slice('--artifacts='.length))
		else if (argument === '--dry-run') dryRun = true
		else if (argument === '--local' && command === 'pack') local = true
		else if (command === POSITIONAL_COMMAND && !argument.startsWith('-')) positional.push(argument)
		else throw new Error(`Unknown option: ${argument}`)
	}
	if (!COMMANDS.includes(command)) throw new Error(`Unknown release command: ${command}`)
	if (local) {
		if (tagArgument !== undefined) throw new Error('pack --local derives its version and takes no --tag')
		const { version, published } = await resolveLocalVersion()
		return { command, tag: `v${version}`, version, local, pinnedVersion: published, artifactsDirectory, dryRun, positional }
	}
	const { tag, version } = await resolveTag(tagArgument)
	return { command, tag, version, local, pinnedVersion: version, artifactsDirectory, dryRun, positional }
}

const internalDependencies = (item: PackageInfo, publicNames: ReadonlySet<string>): readonly string[] => {
	const names = new Set<string>()
	for (const field of DEPENDENCY_FIELDS) {
		for (const name of dependencyMap(item, field).keys()) if (publicNames.has(name)) names.add(name)
	}
	return [...names].sort()
}

export const stagedManifest = (item: PackageInfo, version: string, publicNames: ReadonlySet<string>): Record<string, unknown> => {
	const manifest = structuredClone(item.manifest)
	manifest['version'] = version
	delete manifest['devDependencies']
	for (const field of DEPENDENCY_FIELDS) {
		const dependencies = dependencyMap(item, field)
		if (dependencies.size === 0) continue
		manifest[field] = Object.fromEntries(
			[...dependencies].map(([name, range]) => [name, publicNames.has(name) && range.startsWith('workspace:') ? `^${version}` : range]),
		)
	}
	return manifest
}

const SKILL_VERSION_LINE = /^(---\n[\s\S]*?\nversion: )\S+(\n[\s\S]*?\n---\n)/

/** An agent skill's `SKILL.md` as a release ships it: its frontmatter `version` is the released version. */
export const stagedSkill = (text: string, version: string): string => {
	if (!SKILL_VERSION_LINE.test(text)) throw new Error('skill/SKILL.md must carry a version in its frontmatter')
	return text.replace(SKILL_VERSION_LINE, `$1${version}$2`)
}

/** The package whose `skill/` ships the application rules, versioned with it. */
const APP_SKILL_PACKAGE = '@fabrika/app'

/**
 * The application skill of `@fabrika/app` as a release ships it: `SKILL.md` names the released version, and every
 * `@fabrika/*` range of a reference file's examples is `^<pinnedVersion>`, so an application copied from it installs
 * the release whose rules it read. A local pack pins the last published version, the newest npm has.
 */
export const stagedAppSkill = (files: readonly { readonly path: string; readonly text: string }[], version: string, pinnedVersion = version) =>
	files.map(({ path, text }) => ({ path, text: path === 'SKILL.md' ? stagedSkill(text, version) : rewriteExamplePins(text, pinnedVersion).text }))

/** Copies `item` into `stagingDirectory` as `pack` packs it: its files, its staged manifest and, for the app, its skill. */
export const stagePackage = async (
	item: PackageInfo,
	version: string,
	publicNames: ReadonlySet<string>,
	stagingDirectory: string,
	pinnedVersion = version,
): Promise<void> => {
	const includeDist = includesDist(item.manifest)
	await cp(item.directory, stagingDirectory, { recursive: true, filter: (source) => stagesPath(source, includeDist) })
	await writeFile(join(stagingDirectory, 'package.json'), `${JSON.stringify(stagedManifest(item, version, publicNames), null, '\t')}\n`)
	if (item.name !== APP_SKILL_PACKAGE) return
	const skillDirectory = join(stagingDirectory, 'skill')
	const references = (await readdir(join(skillDirectory, 'references'))).filter((name) => name.endsWith('.md')).map((name) => `references/${name}`)
	const files = await Promise.all(
		['SKILL.md', ...references].map(async (path) => ({ path, text: await readFile(join(skillDirectory, path), 'utf8') })),
	)
	for (const file of stagedAppSkill(files, version, pinnedVersion)) await writeFile(join(skillDirectory, file.path), file.text)
}

const tarballFilename = (name: string, version: string): string => `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`

/** Where an application keeps the tarballs of a local pack, relative to its root. */
export const LOCAL_TARBALL_DIRECTORY = 'vendor'

/** The file beside a local pack's tarballs that holds the `dependencies` and `overrides` block installing them. */
export const LOCAL_INSTALL_FILE = 'install.json'

/**
 * The `package.json` block that installs a local pack from `vendor/`: every package as a direct dependency, and as an
 * override, because each packed manifest names its `@fabrika/*` dependencies by a range only the pack satisfies.
 */
export const localInstallBlock = (packages: readonly ReleasePackage[]) => {
	const tarballs = Object.fromEntries(packages.map((item) => [item.name, `file:${LOCAL_TARBALL_DIRECTORY}/${item.filename}`]))
	return { dependencies: tarballs, overrides: tarballs }
}

const tarballIntegrity = async (path: string): Promise<string> => `sha512-${createHash('sha512').update(await readFile(path)).digest('base64')}`

const preparesRelease = (manifest: Record<string, unknown>): boolean => {
	const scripts = manifest['scripts']
	return isRecord(scripts) && typeof scripts['release:prepare'] === 'string'
}

const includesDist = (manifest: Record<string, unknown>): boolean => {
	const files = manifest['files']
	return Array.isArray(files) && files.some((file) => typeof file === 'string' && file.split('/').includes('dist'))
}

/** The staging copy's filter: what `pack` leaves out of a tarball regardless of `files`. */
const stagesPath = (path: string, includeDist: boolean): boolean => {
	const parts = path.split('/')
	return !parts.includes('node_modules') && (includeDist || !parts.includes('dist')) && !parts.includes('__tests__')
		&& !/\.(?:test|spec)\.[^.]+$/.test(path)
}

const filesSchema = z.array(z.string()).optional()
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/

/** Package-relative paths a tarball would carry, read off `files` the way npm applies it. */
const packedFiles = async (item: PackageInfo): Promise<readonly string[]> => {
	const entries = filesSchema.parse(item.manifest['files'], { path: [item.name, 'files'] }) ?? ['**']
	const toPattern = async (entry: string): Promise<string> => {
		const path = entry.replace(/^\.\//, '')
		if (/[*?[{]/.test(path)) return path
		const isDirectory = await stat(join(item.directory, path)).then((found) => found.isDirectory(), () => false)
		return isDirectory ? `${path}/**` : path
	}
	const includes = await Promise.all(entries.filter((entry) => !entry.startsWith('!')).map(toPattern))
	const excludes = (await Promise.all(entries.filter((entry) => entry.startsWith('!')).map((entry) => toPattern(entry.slice(1)))))
		.map((pattern) => new Bun.Glob(pattern))
	const includeDist = includesDist(item.manifest)
	const found = new Set<string>()
	for (const pattern of includes) {
		for await (const path of new Bun.Glob(pattern).scan({ cwd: item.directory, onlyFiles: true })) {
			if (stagesPath(path, includeDist) && !excludes.some((exclude) => exclude.match(path))) found.add(path)
		}
	}
	return [...found].sort()
}

/**
 * Every import a public package ships — type-only ones included, because a consumer's typecheck resolves
 * them too — must name a declared public dependency or stay inside the package.
 */
export const assertPackedImports = async (item: PackageInfo, publicNames: ReadonlySet<string>): Promise<void> => {
	const declared = new Set([...dependencyMap(item, 'dependencies').keys(), ...dependencyMap(item, 'peerDependencies').keys()])
	const violations: string[] = []
	for (const file of await packedFiles(item)) {
		if (!SCRIPT_FILE.test(file)) continue
		const path = join(item.directory, file)
		for (const { fileName: specifier } of ts.preProcessFile(await readFile(path, 'utf8'), true, true).importedFiles) {
			if (specifier.startsWith('.')) {
				if (relative(item.directory, resolve(dirname(path), specifier)).startsWith('..')) {
					violations.push(`${file} imports ${specifier}, which is outside the package`)
				}
				continue
			}
			if (!specifier.startsWith('@fabrika/')) continue
			const dependency = specifier.split('/').slice(0, 2).join('/')
			if (dependency === item.name) continue
			if (!declared.has(dependency)) violations.push(`${file} imports ${specifier}, which is not a declared dependency`)
			else if (!publicNames.has(dependency)) violations.push(`${file} imports ${specifier}, which is a private package`)
		}
	}
	if (violations.length > 0) throw new Error(`${item.name}: packed files import what a consumer cannot resolve:\n  ${violations.join('\n  ')}`)
}

export const collectExportTargets = (value: unknown, source: string, targets: Set<string>): void => {
	visitExportTargets(exportTargetSchema.parse(value, { path: [source] }), source, targets)
}

const visitExportTargets = (value: ExportTarget, source: string, targets: Set<string>): void => {
	if (value === null) return
	if (typeof value === 'string') {
		if (!value.startsWith('./') || value.includes('*') || value.endsWith('/')) {
			throw new Error(`${source}: export target must be a concrete package-relative file`)
		}
		targets.add(value)
		return
	}
	if (Array.isArray(value)) {
		if (value.length === 0) throw new Error(`${source}: export fallback array must not be empty`)
		for (const [index, target] of value.entries()) visitExportTargets(target, `${source}[${index}]`, targets)
		return
	}
	const entries = Object.entries(value)
	if (entries.length === 0) throw new Error(`${source}: export map must not be empty`)
	const subpathKeys = entries.filter(([key]) => key.startsWith('.'))
	if (subpathKeys.length !== 0 && subpathKeys.length !== entries.length) {
		throw new Error(`${source}: export map must not mix subpaths and conditions`)
	}
	for (const [key, target] of entries) {
		if (key === '' || (subpathKeys.length > 0 && key !== '.' && !key.startsWith('./'))) {
			throw new Error(`${source}: invalid export key ${JSON.stringify(key)}`)
		}
		visitExportTargets(target, `${source}.${key}`, targets)
	}
}

export const collectBinTargets = (input: unknown, source: string, targets: Set<string>): void => {
	const value = binTargetsSchema.parse(input, { path: [source] })
	if (value === undefined) return
	if (typeof value === 'string') {
		if (!value.startsWith('./') || value.endsWith('/')) throw new Error(`${source}: bin target must be a package-relative file`)
		targets.add(value)
		return
	}
	if (Object.keys(value).length === 0) throw new Error(`${source}: bin must be a non-empty string or object`)
	for (const [name, target] of Object.entries(value)) {
		if (name === '' || !target.startsWith('./') || target.endsWith('/')) {
			throw new Error(`${source}.${name}: bin target must be a package-relative file`)
		}
		targets.add(target)
	}
}

const assertSafeTarball = async (path: string, expectedName: string, expectedVersion: string): Promise<void> => {
	const { stdout } = await run(['tar', '-tzf', path])
	const entries = stdout.split('\n').filter((entry) => entry !== '')
	const files = new Set(entries)
	const forbidden = entries.find((entry) =>
		entry.includes('/__tests__/') || entry.includes('/node_modules/') || entry.includes('/.git/') || /\/(?:\.env|\.dev\.vars)(?:$|\.)/.test(entry)
		|| entry.endsWith('/.npmrc')
		|| entry.endsWith('.log')
	)
	if (forbidden !== undefined) throw new Error(`${basename(path)} contains forbidden file ${forbidden}`)
	if (!files.has('package/package.json')) throw new Error(`${basename(path)} does not contain package/package.json`)
	const packedManifestText = (await run(['tar', '-xOzf', path, 'package/package.json'])).stdout
	const packedManifest = parsePackedManifest(packedManifestText, `${basename(path)}:package.json`)
	if (packedManifest.name !== expectedName) throw new Error(`${basename(path)} contains the wrong package name`)
	if (packedManifest.version !== expectedVersion) {
		throw new Error(`${basename(path)} contains the wrong package version`)
	}
	for (const field of PACKED_DEPENDENCY_FIELDS) {
		const dependencies = packedManifest[field]
		if (dependencies === undefined) continue
		for (const [name, range] of Object.entries(dependencies)) {
			if (range.includes('workspace:')) throw new Error(`${expectedName}: packed ${field}.${name} contains unresolved workspace protocol`)
		}
	}
	const targets = new Set<string>()
	const exports = packedManifest['exports']
	if (exports === undefined) throw new Error(`${expectedName}: packed manifest must declare exports`)
	collectExportTargets(exports, `${expectedName}.exports`, targets)
	collectBinTargets(packedManifest['bin'], `${expectedName}.bin`, targets)
	for (const target of targets) {
		const entry = `package/${target.slice(2)}`
		if (!files.has(entry)) throw new Error(`${expectedName}: packed target ${target} is missing`)
	}
}

const pack = async (options: Options, order: readonly PackageInfo[]): Promise<ReleaseManifest> => {
	await mkdir(options.artifactsDirectory, { recursive: true })
	const stagingRoot = await mkdtemp(join(tmpdir(), 'fabrika-release-'))
	const publicNames = new Set(order.map((item) => item.name))
	const entries: ReleasePackage[] = []
	try {
		for (const item of order) {
			if (preparesRelease(item.manifest)) await run(['bun', 'run', 'release:prepare'], { cwd: item.directory })
			const stagingDirectory = join(stagingRoot, basename(item.directory))
			await stagePackage(item, options.version, publicNames, stagingDirectory, options.pinnedVersion)
			const filename = tarballFilename(item.name, options.version)
			const path = join(options.artifactsDirectory, filename)
			await rm(path, { force: true })
			await run(['npm', 'pack', stagingDirectory, '--json', '--ignore-scripts', '--pack-destination', options.artifactsDirectory])
			if (!(await Bun.file(path).exists())) throw new Error(`${item.name}: npm pack did not create ${filename}`)
			await assertSafeTarball(path, item.name, options.version)
			entries.push({ name: item.name, filename, dependencies: internalDependencies(item, publicNames), integrity: await tarballIntegrity(path) })
			console.info(`packed ${item.name}@${options.version}`)
		}
	} finally {
		await rm(stagingRoot, { recursive: true, force: true })
	}
	const manifest: ReleaseManifest = { tag: options.tag, version: options.version, packages: entries }
	await writeFile(join(options.artifactsDirectory, 'release-manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`)
	if (options.local) {
		await writeFile(join(options.artifactsDirectory, LOCAL_INSTALL_FILE), `${JSON.stringify(localInstallBlock(entries), null, '\t')}\n`)
	}
	return manifest
}

const readReleaseManifest = async (options: Options): Promise<ReleaseManifest> => {
	const path = join(options.artifactsDirectory, 'release-manifest.json')
	const { tag, version, packages } = parseReleaseManifest(await readFile(path, 'utf8'), path)
	if (tag !== options.tag || version !== options.version) throw new Error(`${path}: release does not match ${options.tag}`)
	for (const item of packages) {
		if (!(await Bun.file(join(options.artifactsDirectory, item.filename)).exists())) throw new Error(`Missing ${item.filename}`)
	}
	return { tag, version, packages }
}

/** Loads every main entry, so a shipped file that imports an unpublished package fails the smoke. */
export const entryImportSmoke = (packageNames: readonly string[]): string =>
	[
		`for (const name of ${JSON.stringify(packageNames)}) {`,
		'\tawait import(name).catch((error) => {',
		'\t\tthrow new Error(`${name}: main entry does not load from its tarball`, { cause: error })',
		'\t})',
		'}',
		'',
	].join('\n')

const runConsumerSmoke = async (dependencies: Readonly<Record<string, string>>, expectedVersion: string, label: string): Promise<void> => {
	const consumer = await mkdtemp(join(tmpdir(), 'fabrika-consumer-'))
	try {
		await writeFile(
			join(consumer, 'package.json'),
			`${JSON.stringify({ name: 'fabrika-release-smoke', private: true, type: 'module', dependencies }, null, '\t')}\n`,
		)
		await writeFile(
			join(consumer, 'smoke.ts'),
			[
				entryImportSmoke(Object.keys(dependencies)),
				"const modules = await Promise.all([import('@fabrika/annotations'), import('@fabrika/app'), import('@fabrika/builder'), import('@fabrika/canvas-kernel'), import('@fabrika/daemon-kit'), import('@fabrika/provider-cloudflare'), import('@fabrika/provider-cloudflare/installation'), import('@fabrika/provider-zerops'), import('@fabrika/provider-zerops/installation')])",
				"if (modules.some((module) => Object.keys(module).length === 0)) throw new Error('A public entry point has no exports')",
				"const builder = await import('@fabrika/builder')",
				"if (builder.resolveCatalogRoot() === null || builder.resolveSkillSource() === null) throw new Error('Builder resources are missing')",
				"const builderRoot = new URL('.', import.meta.resolve('@fabrika/builder'))",
				"if (!(await Bun.file(new URL('ui/dist/index.html', builderRoot)).exists())) throw new Error('Builder dashboard is missing')",
				"console.info('public entry points loaded')",
				'',
			].join('\n'),
		)
		await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer })
		for (const name of Object.keys(dependencies)) {
			const installedPath = join(consumer, 'node_modules', ...name.split('/'), 'package.json')
			const installed = parseInstalledManifest(await readFile(installedPath, 'utf8'), installedPath)
			if (installed.name !== name || installed.version !== expectedVersion) {
				throw new Error(`${name}: isolated consumer installed an unexpected package identity`)
			}
		}
		await run(['bun', 'run', 'smoke.ts'], { cwd: consumer })
		await run([join(consumer, 'node_modules', '.bin', 'fabrika'), '--help'], { cwd: consumer })
		await run([join(consumer, 'node_modules', '.bin', 'fabrika'), 'builder', '--help'], { cwd: consumer })
		console.info(`${label} passed for ${Object.keys(dependencies).length} packages in an isolated consumer`)
	} finally {
		await rm(consumer, { recursive: true, force: true })
	}
}

const smoke = async (options: Options, expectedOrder: readonly PackageInfo[]): Promise<void> => {
	const manifest = await readReleaseManifest(options)
	const expectedNames = expectedOrder.map((item) => item.name)
	if (JSON.stringify(manifest.packages.map((item) => item.name)) !== JSON.stringify(expectedNames)) {
		throw new Error('Release manifest package order does not match the validated dependency graph')
	}
	const dependencies: Record<string, string> = {}
	for (const item of manifest.packages) dependencies[item.name] = `file:${join(options.artifactsDirectory, item.filename)}`
	await runConsumerSmoke(dependencies, options.version, 'tarball smoke')
}

export const parseRegistryIntegrity = (text: string, source: string): string => {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch (error) {
		throw new Error(`${source}: npm returned invalid integrity metadata`, { cause: error })
	}
	const parsed = nonEmptyString.safeParse(value)
	if (!parsed.success) throw new Error(`${source}: npm did not return dist.integrity`)
	return parsed.data
}

export const parseRegistryPackageName = (text: string, source: string): string => nonEmptyString.parse(parseJson(text, source), { path: [source] })

const published = async (name: string, version: string, path: string): Promise<boolean> => {
	const command = ['npm', 'view', `${name}@${version}`, 'dist.integrity', '--json']
	const child = Bun.spawn(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: processEnv() })
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	if (exitCode === 0) {
		const registryIntegrity = parseRegistryIntegrity(stdout, `${name}@${version}`)
		if (registryIntegrity !== (await tarballIntegrity(path))) {
			throw new Error(`${name}@${version} already exists with different content; refusing to treat this release as complete`)
		}
		return true
	}
	if (stderr.includes('E404') || stdout.includes('E404')) return false
	throw new Error(`${command.join(' ')} failed (${exitCode})\n${stderr || stdout}`)
}

const packageExists = async (name: string): Promise<boolean> => {
	const command = ['npm', 'view', name, 'name', '--json']
	const child = Bun.spawn(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: processEnv() })
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	if (exitCode === 0) return parseRegistryPackageName(stdout, name) === name
	if (stderr.includes('E404') || stdout.includes('E404')) return false
	throw new Error(`${command.join(' ')} failed (${exitCode})\n${stderr || stdout}`)
}

const releaseDistTag = (version: string): 'latest' | 'next' => version.includes('-') ? 'next' : 'latest'

const compareVersions = (left: string, right: string, source: string): number => {
	if (!TAG_PATTERN.test(`v${left}`)) throw new Error(`${source}: invalid SemVer ${JSON.stringify(left)}`)
	if (!TAG_PATTERN.test(`v${right}`)) throw new Error(`${source}: invalid SemVer ${JSON.stringify(right)}`)
	return Bun.semver.order(left, right)
}

const publishCommand = (path: string, version: string, dryRun: boolean): readonly string[] => {
	const command = ['npm', 'publish', path, '--access', 'public', '--ignore-scripts']
	if (releaseDistTag(version) === 'next') command.push('--tag', 'next')
	command.push(dryRun ? '--dry-run' : '--provenance')
	return command
}

const publish = async (options: Options, expectedOrder: readonly PackageInfo[]): Promise<void> => {
	const manifest = await readReleaseManifest(options)
	const expectedNames = expectedOrder.map((item) => item.name)
	if (JSON.stringify(manifest.packages.map((item) => item.name)) !== JSON.stringify(expectedNames)) {
		throw new Error('Release manifest package order does not match the validated dependency graph')
	}
	const alreadyPublished = new Map<string, boolean>()
	if (!options.dryRun) {
		const missing: string[] = []
		for (const item of manifest.packages) if (!(await packageExists(item.name))) missing.push(item.name)
		if (missing.length > 0) {
			throw new Error(
				`Trusted publishing cannot create a package for the first time. Bootstrap these packages through npm's initial-publish process, then configure their trusted publisher for .github/workflows/release.yml:\n${
					missing.join('\n')
				}`,
			)
		}
		for (const item of manifest.packages) {
			const path = join(options.artifactsDirectory, item.filename)
			alreadyPublished.set(item.name, await published(item.name, options.version, path))
		}
		if ([...alreadyPublished.values()].some((value) => !value)) {
			const tag = releaseDistTag(options.version)
			for (const item of manifest.packages) {
				const current = await distTagVersion(item.name, tag)
				if (current !== undefined && compareVersions(current, options.version, `${item.name} dist-tag ${tag}`) > 0) {
					throw new Error(`${item.name}: refusing to publish ${options.version} because npm dist-tag ${tag} already points to newer ${current}`)
				}
			}
		}
	}
	for (const item of manifest.packages) {
		const path = join(options.artifactsDirectory, item.filename)
		if (options.dryRun) {
			await run(publishCommand(path, options.version, true))
			console.info(`publish dry-run passed for ${item.name}@${options.version}`)
			continue
		}
		if (alreadyPublished.get(item.name) === true) {
			console.info(`already published ${item.name}@${options.version}`)
			continue
		}
		try {
			await run(publishCommand(path, options.version, false))
		} catch (error) {
			await Bun.sleep(2_000)
			if (!(await published(item.name, options.version, path))) throw error
		}
		console.info(`published ${item.name}@${options.version}`)
	}
}

const distTagVersion = async (name: string, tag: string): Promise<string | undefined> => {
	const { stdout } = await run(['npm', 'view', name, `dist-tags.${tag}`, '--json'])
	return parseRegistryDistTag(stdout, name, tag)
}

export const parseRegistryDistTag = (text: string, name: string, tag: string): string | undefined => {
	if (text.trim() === '') return undefined
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch (error) {
		throw new Error(`${name}: npm returned invalid ${tag} dist-tag metadata`, { cause: error })
	}
	const parsed = nonEmptyString.nullable().safeParse(value)
	if (!parsed.success) throw new Error(`${name}: npm returned malformed ${tag} dist-tag metadata`)
	return parsed.data ?? undefined
}

/**
 * How long the registry wait sleeps between rounds, the last value repeating.
 *
 * npm's replication, not the publish, is what is being waited on: `@fabrika/control-contract` reached the
 * `latest` dist-tag about five minutes after publish on both v0.0.24 and v0.0.25, where the old fixed
 * 6 x 2 s gave up after twelve seconds and every release needed a manual re-run.
 */
export const REGISTRY_BACKOFF_MS: readonly number[] = [5_000, 10_000, 20_000, 30_000]

/** Total budget for the wait; past it the release job fails rather than holding a runner open. */
export const REGISTRY_DEADLINE_MS = 600_000

/** Everything the wait does to the outside world, so a test can assert its schedule without spending it. */
export interface RegistryWaitDeps {
	readonly lookup: (name: string) => Promise<string | undefined>
	readonly sleep: (ms: number) => Promise<void>
	readonly now: () => number
	readonly report: (message: string) => void
}

/** One package the registry has not answered for yet, and what it answered instead. */
interface RegistryMiss {
	readonly name: string
	readonly actual: string | undefined
	readonly reason: string | undefined
}

/** One line of an error, capped: a registry failure goes into a build log, so it must not paste a page into it. */
const shortReason = (error: unknown): string => {
	const [first = ''] = (error instanceof Error ? error.message : 'unknown error').split('\n')
	return first.length > 120 ? `${first.slice(0, 119)}…` : first
}

/** What the registry currently says about a package, in one phrase both the retry line and the failure use. */
const missState = (miss: RegistryMiss): string => miss.actual ?? (miss.reason === undefined ? '(missing)' : `(lookup failed: ${miss.reason})`)

/** Wait until every package's dist-tag is at `version` or newer, naming the ones still missing between rounds. */
export const awaitRegistryTag = async (
	names: readonly string[],
	tag: string,
	version: string,
	deps: RegistryWaitDeps,
): Promise<void> => {
	const deadline = deps.now() + REGISTRY_DEADLINE_MS
	let pending = [...names]
	let missing: RegistryMiss[] = []
	for (let attempt = 0;; attempt++) {
		missing = []
		const remaining: string[] = []
		for (const name of pending) {
			try {
				const actual = await deps.lookup(name)
				if (actual !== undefined && compareVersions(actual, version, `${name} dist-tag ${tag}`) >= 0) continue
				missing.push({ name, actual, reason: undefined })
			} catch (error) {
				// A registry hiccup is not an answer. One 5xx must not end a ten-minute wait, so it counts as
				// "still missing" and the deadline decides.
				missing.push({ name, actual: undefined, reason: shortReason(error) })
			}
			remaining.push(name)
		}
		pending = remaining
		if (missing.length === 0) return
		const wait = REGISTRY_BACKOFF_MS[Math.min(attempt, REGISTRY_BACKOFF_MS.length - 1)] ?? 30_000
		if (deps.now() + wait > deadline) break
		deps.report(
			`npm dist-tag ${tag} is not at ${version} yet for ${missing.length} package(s); retrying in ${wait / 1_000}s: ${
				missing.map((miss) => `${miss.name}: ${missState(miss)}`).join(', ')
			}`,
		)
		await deps.sleep(wait)
	}
	throw new Error(
		missing.map((miss) => `${miss.name}: expected npm dist-tag ${tag} at ${version} or newer, received ${missState(miss)}`).join('\n'),
	)
}

const registrySmoke = async (options: Options, expectedOrder: readonly PackageInfo[]): Promise<void> => {
	const tag = releaseDistTag(options.version)
	await awaitRegistryTag(expectedOrder.map((item) => item.name), tag, options.version, {
		lookup: (name) => distTagVersion(name, tag),
		sleep: (ms) => Bun.sleep(ms),
		now: () => Date.now(),
		report: (message) => console.info(message),
	})
	const dependencies: Record<string, string> = {}
	for (const item of expectedOrder) dependencies[item.name] = options.version
	await runConsumerSmoke(dependencies, options.version, 'registry smoke')
}

// ── the example repository's pins ───────────────────────────────────────────────

/** A `"@fabrika/x": "<range>"` manifest line. Line-for-line by design, so the rewrite's diff shows only pins. */
const FABRIKA_PIN_LINE = /^(\s*"(?:@fabrika\/[A-Za-z0-9._-]+)"\s*:\s*")([^"]*)("\s*,?)$/

/** Rewrite every `@fabrika/*` range in one manifest to the released version, one line for one line. */
export const rewriteExamplePins = (text: string, version: string): { readonly text: string; readonly changed: number } => {
	let changed = 0
	const rewritten = text.split('\n').map((line) => {
		const match = FABRIKA_PIN_LINE.exec(line)
		const prefix = match?.[1]
		const range = match?.[2]
		const suffix = match?.[3]
		if (prefix === undefined || range === undefined || suffix === undefined) return line
		// A workspace range means the checkout is a monorepo member; rewriting it would unlink the package.
		if (range.startsWith('workspace:') || range === `^${version}`) return line
		changed++
		return `${prefix}^${version}${suffix}`
	})
	return { text: rewritten.join('\n'), changed }
}

/**
 * Refuse to rewrite a checkout inside this repository.
 *
 * `examples/*` are workspace members whose ranges match the workspace's own version ON PURPOSE, which is how
 * bun links the local packages instead of installing them. Stamping a released range there is silent: the
 * next install fetches those packages from npm and the example stops testing the working tree.
 */
export const assertStandaloneCheckout = (checkout: string, root: string): void => {
	if (checkout !== root && !checkout.startsWith(`${root}/`)) return
	throw new Error(
		`${checkout} is inside this repository. Its package manifests are workspace members whose ranges keep bun linking the local packages; rewriting them to a released range makes the next install fetch from npm instead. Run example-pin against a standalone checkout of the example repository.`,
	)
}

/** A unified diff of a LINE-PRESERVING rewrite, so an operator reviews the change before committing it. */
export const unifiedDiff = (path: string, before: string, after: string, context = 3): string => {
	if (before === after) return ''
	const beforeLines = before.split('\n')
	const afterLines = after.split('\n')
	// The only caller substitutes in place, so an added or removed line means the rewrite is broken, not the diff.
	if (beforeLines.length !== afterLines.length) throw new Error(`${path}: the pin rewrite changed the line count`)
	const changed = beforeLines.flatMap((line, index) => line === afterLines[index] ? [] : [index])
	const hunks: { start: number; end: number }[] = []
	for (const index of changed) {
		const start = Math.max(0, index - context)
		const end = Math.min(beforeLines.length - 1, index + context)
		const last = hunks[hunks.length - 1]
		if (last !== undefined && start <= last.end + 1) last.end = Math.max(last.end, end)
		else hunks.push({ start, end })
	}
	const out = [`--- a/${path}`, `+++ b/${path}`]
	for (const hunk of hunks) {
		const count = hunk.end - hunk.start + 1
		out.push(`@@ -${hunk.start + 1},${count} +${hunk.start + 1},${count} @@`)
		let index = hunk.start
		while (index <= hunk.end) {
			if (beforeLines[index] === afterLines[index]) {
				out.push(` ${beforeLines[index] ?? ''}`)
				index++
				continue
			}
			const run = index
			while (index <= hunk.end && beforeLines[index] !== afterLines[index]) index++
			for (let cursor = run; cursor < index; cursor++) out.push(`-${beforeLines[cursor] ?? ''}`)
			for (let cursor = run; cursor < index; cursor++) out.push(`+${afterLines[cursor] ?? ''}`)
		}
	}
	return out.join('\n')
}

/** Every `package.json` in a checkout, skipping dependencies and anything hidden. */
const findManifests = async (directory: string): Promise<readonly string[]> => {
	const found: string[] = []
	const walk = async (current: string): Promise<void> => {
		const entries = await readdir(current, { withFileTypes: true })
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
			const path = join(current, entry.name)
			if (entry.isDirectory()) await walk(path)
			else if (entry.name === 'package.json') found.push(path)
		}
	}
	await walk(directory)
	return found
}

const examplePin = async (options: Options): Promise<void> => {
	const argument = options.positional[0]
	if (argument === undefined || options.positional.length > 1) {
		throw new Error('Usage: bun scripts/release.ts example-pin <path-to-example-checkout> [--tag=v1.2.3]')
	}
	const checkout = resolve(process.cwd(), argument)
	assertStandaloneCheckout(checkout, ROOT)
	const manifests = await findManifests(checkout)
	if (manifests.length === 0) throw new Error(`${checkout}: no package.json found`)
	let changed = 0
	for (const path of manifests) {
		const before = await readFile(path, 'utf8')
		const rewrite = rewriteExamplePins(before, options.version)
		if (rewrite.changed === 0) continue
		await writeFile(path, rewrite.text)
		changed += rewrite.changed
		console.info(unifiedDiff(path.slice(checkout.length + 1), before, rewrite.text))
	}
	console.info(
		changed === 0
			? `${manifests.length} manifest(s) already pin ^${options.version}`
			: `rewrote ${changed} @fabrika/* range(s) to ^${options.version}; nothing was committed or pushed`,
	)
}

const main = async (): Promise<void> => {
	const options = await parseOptions(Bun.argv.slice(2))
	const packages = await readPackages()
	const { publicPackages, order } = packageGraph(packages)
	if (options.command === 'validate' || options.command === 'pack') {
		const publicNames = new Set(publicPackages.map((item) => item.name))
		for (const item of publicPackages) await assertPackedImports(item, publicNames)
	}
	console.info(`validated ${publicPackages.length} public packages for ${options.tag}`)
	if (options.command === 'validate') {
		for (const item of order) console.info(item.name)
		return
	}
	if (options.command === 'pack') await pack(options, order)
	else if (options.command === 'smoke') await smoke(options, order)
	else if (options.command === 'publish') await publish(options, order)
	else if (options.command === 'example-pin') await examplePin(options)
	else await registrySmoke(options, order)
}

// Guarded so the tests can import the pure pieces without running a release.
if (import.meta.main) await main()
