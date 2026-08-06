import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
type DependencyField = 'dependencies' | 'optionalDependencies' | 'peerDependencies'

const DEPENDENCY_FIELDS: readonly DependencyField[] = ['dependencies', 'optionalDependencies', 'peerDependencies']
const PACKED_DEPENDENCY_FIELDS: readonly string[] = [...DEPENDENCY_FIELDS, 'devDependencies']
const EXPECTED_PUBLIC_PACKAGES = [
	'@fabrika/app',
	'@fabrika/auth',
	'@fabrika/auth-core',
	'@fabrika/cli',
	'@fabrika/control-contract',
	'@fabrika/email',
	'@fabrika/engine',
	'@fabrika/iam-contract',
	'@fabrika/installation-cloudflare',
	'@fabrika/installation-contract',
	'@fabrika/installation-zerops',
	'@fabrika/operations',
	'@fabrika/operations-contract',
	'@fabrika/platform',
	'@fabrika/platform-node',
	'@fabrika/provider-cloudflare',
	'@fabrika/provider-contract',
	'@fabrika/provider-zerops',
	'@fabrika/proxy-contract',
	'@fabrika/proxy-core',
	'@fabrika/runner-contract',
]
const TAG_PATTERN =
	/^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/

interface PackageInfo {
	readonly name: string
	readonly directory: string
	readonly manifest: Record<string, unknown>
	readonly publishable: boolean
}

interface ReleasePackage {
	readonly name: string
	readonly filename: string
	readonly dependencies: readonly string[]
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
	readonly artifactsDirectory: string
	readonly dryRun: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const requiredString = (record: Record<string, unknown>, key: string, source: string): string => {
	const value = record[key]
	if (typeof value !== 'string' || value === '') throw new Error(`${source}: ${key} must be a non-empty string`)
	return value
}

const dependencyMap = (manifest: Record<string, unknown>, field: DependencyField, source: string): ReadonlyMap<string, string> => {
	const value = manifest[field]
	if (value === undefined) return new Map()
	if (!isRecord(value)) throw new Error(`${source}: ${field} must be an object`)
	const dependencies = new Map<string, string>()
	for (const [name, range] of Object.entries(value)) {
		if (typeof range !== 'string') throw new Error(`${source}: ${field}.${name} must be a string`)
		dependencies.set(name, range)
	}
	return dependencies
}

const parseJsonObject = (text: string, source: string): Record<string, unknown> => {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch (error) {
		throw new Error(`${source}: invalid JSON`, { cause: error })
	}
	if (!isRecord(parsed)) throw new Error(`${source}: expected a JSON object`)
	return parsed
}

const readPackages = async (): Promise<readonly PackageInfo[]> => {
	const entries = await readdir(join(ROOT, 'packages'), { withFileTypes: true })
	const packages: PackageInfo[] = []
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isDirectory()) continue
		const directory = join(ROOT, 'packages', entry.name)
		const manifestPath = join(directory, 'package.json')
		if (!(await Bun.file(manifestPath).exists())) continue
		const manifest = parseJsonObject(await readFile(manifestPath, 'utf8'), manifestPath)
		const name = requiredString(manifest, 'name', manifestPath)
		const isPrivate = manifest['private'] === true
		const publishConfig = manifest['publishConfig']
		const publishable = isRecord(publishConfig) && publishConfig['access'] === 'public'
		if (!isPrivate && !publishable) throw new Error(`${name}: package must be private or declare publishConfig.access as public`)
		if (isPrivate && publishable) throw new Error(`${name}: private package must not declare public publishing`)
		packages.push({ name, directory, manifest, publishable })
	}
	return packages
}

const packageGraph = (
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
		const sourceVersion = requiredString(item.manifest, 'version', item.name)
		if (!TAG_PATTERN.test(`v${sourceVersion}`)) throw new Error(`${item.name}: version must be valid semver`)
		sourceVersions.add(sourceVersion)
		for (const field of DEPENDENCY_FIELDS) {
			for (const [dependency, range] of dependencyMap(item.manifest, field, item.name)) {
				if (!range.startsWith('workspace:')) continue
				const target = byName.get(dependency)
				if (target === undefined) throw new Error(`${item.name}: ${field}.${dependency} refers to a missing workspace package`)
				if (!target.publishable) {
					throw new Error(`${item.name}: public ${field} must not depend on private package ${dependency}`)
				}
			}
		}
		for (const field of DEPENDENCY_FIELDS) {
			for (const [dependency, range] of dependencyMap(item.manifest, field, item.name)) {
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
			for (const dependency of dependencyMap(item.manifest, field, item.name).keys()) {
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

const parseOptions = async (argv: readonly string[]): Promise<Options> => {
	const command = argv[0] ?? 'validate'
	let tagArgument: string | undefined
	let artifactsDirectory = join(ROOT, '.release')
	let dryRun = false
	for (const argument of argv.slice(1)) {
		if (argument.startsWith('--tag=')) tagArgument = argument.slice('--tag='.length)
		else if (argument.startsWith('--artifacts=')) artifactsDirectory = resolve(ROOT, argument.slice('--artifacts='.length))
		else if (argument === '--dry-run') dryRun = true
		else throw new Error(`Unknown option: ${argument}`)
	}
	if (!['validate', 'pack', 'smoke', 'publish', 'registry-smoke'].includes(command)) throw new Error(`Unknown release command: ${command}`)
	const { tag, version } = await resolveTag(tagArgument)
	return { command, tag, version, artifactsDirectory, dryRun }
}

const internalDependencies = (item: PackageInfo, publicNames: ReadonlySet<string>): readonly string[] => {
	const names = new Set<string>()
	for (const field of DEPENDENCY_FIELDS) {
		for (const name of dependencyMap(item.manifest, field, item.name).keys()) if (publicNames.has(name)) names.add(name)
	}
	return [...names].sort()
}

const stagedManifest = (item: PackageInfo, version: string, publicNames: ReadonlySet<string>): Record<string, unknown> => {
	const manifest = structuredClone(item.manifest)
	manifest['version'] = version
	delete manifest['devDependencies']
	for (const field of DEPENDENCY_FIELDS) {
		const dependencies = dependencyMap(manifest, field, item.name)
		if (dependencies.size === 0) continue
		const rewritten: Record<string, string> = {}
		for (const [name, range] of dependencies) rewritten[name] = publicNames.has(name) && range.startsWith('workspace:') ? `^${version}` : range
		manifest[field] = rewritten
	}
	return manifest
}

const tarballFilename = (name: string, version: string): string => `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`

const collectExportTargets = (value: unknown, source: string, targets: Set<string>): void => {
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
		for (const [index, target] of value.entries()) collectExportTargets(target, `${source}[${index}]`, targets)
		return
	}
	if (!isRecord(value)) throw new Error(`${source}: unsupported export target`)
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
		collectExportTargets(target, `${source}.${key}`, targets)
	}
}

const collectBinTargets = (value: unknown, source: string, targets: Set<string>): void => {
	if (value === undefined) return
	if (typeof value === 'string') {
		if (!value.startsWith('./') || value.endsWith('/')) throw new Error(`${source}: bin target must be a package-relative file`)
		targets.add(value)
		return
	}
	if (!isRecord(value) || Object.keys(value).length === 0) throw new Error(`${source}: bin must be a non-empty string or object`)
	for (const [name, target] of Object.entries(value)) {
		if (name === '' || typeof target !== 'string' || !target.startsWith('./') || target.endsWith('/')) {
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
	const packedManifest = parseJsonObject(packedManifestText, `${basename(path)}:package.json`)
	if (requiredString(packedManifest, 'name', basename(path)) !== expectedName) throw new Error(`${basename(path)} contains the wrong package name`)
	if (requiredString(packedManifest, 'version', basename(path)) !== expectedVersion) {
		throw new Error(`${basename(path)} contains the wrong package version`)
	}
	for (const field of PACKED_DEPENDENCY_FIELDS) {
		const dependencies = packedManifest[field]
		if (dependencies === undefined) continue
		if (!isRecord(dependencies)) throw new Error(`${expectedName}: packed ${field} must be an object`)
		for (const [name, range] of Object.entries(dependencies)) {
			if (typeof range !== 'string') throw new Error(`${expectedName}: packed ${field}.${name} must be a string`)
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
			const stagingDirectory = join(stagingRoot, basename(item.directory))
			await cp(item.directory, stagingDirectory, {
				recursive: true,
				filter: (source) => {
					const parts = source.split('/')
					return !parts.includes('node_modules') && !parts.includes('dist') && !parts.includes('__tests__') && !/\.(?:test|spec)\.[^.]+$/.test(source)
				},
			})
			await writeFile(join(stagingDirectory, 'package.json'), `${JSON.stringify(stagedManifest(item, options.version, publicNames), null, '\t')}\n`)
			const filename = tarballFilename(item.name, options.version)
			const path = join(options.artifactsDirectory, filename)
			await rm(path, { force: true })
			await run(['npm', 'pack', stagingDirectory, '--json', '--ignore-scripts', '--pack-destination', options.artifactsDirectory])
			if (!(await Bun.file(path).exists())) throw new Error(`${item.name}: npm pack did not create ${filename}`)
			await assertSafeTarball(path, item.name, options.version)
			entries.push({ name: item.name, filename, dependencies: internalDependencies(item, publicNames) })
			console.info(`packed ${item.name}@${options.version}`)
		}
	} finally {
		await rm(stagingRoot, { recursive: true, force: true })
	}
	const manifest: ReleaseManifest = { tag: options.tag, version: options.version, packages: entries }
	await writeFile(join(options.artifactsDirectory, 'release-manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`)
	return manifest
}

const readReleaseManifest = async (options: Options): Promise<ReleaseManifest> => {
	const path = join(options.artifactsDirectory, 'release-manifest.json')
	const manifest = parseJsonObject(await readFile(path, 'utf8'), path)
	const tag = requiredString(manifest, 'tag', path)
	const version = requiredString(manifest, 'version', path)
	const entries = manifest['packages']
	if (tag !== options.tag || version !== options.version) throw new Error(`${path}: release does not match ${options.tag}`)
	if (!Array.isArray(entries)) throw new Error(`${path}: packages must be an array`)
	const packages: ReleasePackage[] = entries.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`${path}: packages[${index}] must be an object`)
		const dependencies = entry['dependencies']
		if (!Array.isArray(dependencies) || !dependencies.every((value) => typeof value === 'string')) {
			throw new Error(`${path}: packages[${index}].dependencies must be an array of strings`)
		}
		return { name: requiredString(entry, 'name', path), filename: requiredString(entry, 'filename', path), dependencies }
	})
	for (const item of packages) {
		if (!(await Bun.file(join(options.artifactsDirectory, item.filename)).exists())) throw new Error(`Missing ${item.filename}`)
	}
	return { tag, version, packages }
}

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
				"const modules = await Promise.all([import('@fabrika/app'), import('@fabrika/provider-cloudflare'), import('@fabrika/provider-zerops')])",
				"if (modules.some((module) => Object.keys(module).length === 0)) throw new Error('A public entry point has no exports')",
				"console.info('public entry points loaded')",
				'',
			].join('\n'),
		)
		await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer })
		for (const name of Object.keys(dependencies)) {
			const installedPath = join(consumer, 'node_modules', ...name.split('/'), 'package.json')
			const installed = parseJsonObject(await readFile(installedPath, 'utf8'), installedPath)
			if (requiredString(installed, 'name', installedPath) !== name || requiredString(installed, 'version', installedPath) !== expectedVersion) {
				throw new Error(`${name}: isolated consumer installed an unexpected package identity`)
			}
		}
		await run(['bun', 'run', 'smoke.ts'], { cwd: consumer })
		await run([join(consumer, 'node_modules', '.bin', 'fabrika'), '--help'], { cwd: consumer })
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

const published = async (name: string, version: string, path: string): Promise<boolean> => {
	const command = ['npm', 'view', `${name}@${version}`, 'dist.integrity', '--json']
	const child = Bun.spawn(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: processEnv() })
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	if (exitCode === 0) {
		let registryIntegrity: unknown
		try {
			registryIntegrity = JSON.parse(stdout)
		} catch (error) {
			throw new Error(`${name}@${version}: npm returned invalid integrity metadata`, { cause: error })
		}
		if (typeof registryIntegrity !== 'string' || registryIntegrity === '') throw new Error(`${name}@${version}: npm did not return dist.integrity`)
		const localIntegrity = `sha512-${createHash('sha512').update(await readFile(path)).digest('base64')}`
		if (registryIntegrity !== localIntegrity) {
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
	if (exitCode === 0) return stdout.includes(name)
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
	if (stdout.trim() === '') return undefined
	let value: unknown
	try {
		value = JSON.parse(stdout)
	} catch (error) {
		throw new Error(`${name}: npm returned invalid ${tag} dist-tag metadata`, { cause: error })
	}
	if (value === null) return undefined
	if (typeof value !== 'string' || value === '') throw new Error(`${name}: npm returned malformed ${tag} dist-tag metadata`)
	return value
}

const registrySmoke = async (options: Options, expectedOrder: readonly PackageInfo[]): Promise<void> => {
	const tag = releaseDistTag(options.version)
	const dependencies: Record<string, string> = {}
	for (const item of expectedOrder) {
		let actual: string | undefined
		for (let attempt = 1; attempt <= 6; attempt++) {
			actual = await distTagVersion(item.name, tag)
			if (actual !== undefined && compareVersions(actual, options.version, `${item.name} dist-tag ${tag}`) >= 0) break
			if (attempt < 6) await Bun.sleep(2_000)
		}
		if (actual === undefined || compareVersions(actual, options.version, `${item.name} dist-tag ${tag}`) < 0) {
			throw new Error(`${item.name}: expected npm dist-tag ${tag} at ${options.version} or newer, received ${actual ?? '(missing)'}`)
		}
		dependencies[item.name] = options.version
	}
	await runConsumerSmoke(dependencies, options.version, 'registry smoke')
}

const main = async (): Promise<void> => {
	const options = await parseOptions(Bun.argv.slice(2))
	const packages = await readPackages()
	const { publicPackages, order } = packageGraph(packages)
	console.info(`validated ${publicPackages.length} public packages for ${options.tag}`)
	if (options.command === 'validate') {
		for (const item of order) console.info(item.name)
		return
	}
	if (options.command === 'pack') await pack(options, order)
	else if (options.command === 'smoke') await smoke(options, order)
	else if (options.command === 'publish') await publish(options, order)
	else await registrySmoke(options, order)
}

await main()
