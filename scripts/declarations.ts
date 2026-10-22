import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { z } from 'zod'

/** The directory of a packed package that holds its emitted declarations, mirroring the package's own tree. */
export const DECLARATION_DIRECTORY = 'types'

const SOURCE_MODULE = /\.tsx?$/

const isSourceModule = (path: string): boolean => SOURCE_MODULE.test(path) && !path.endsWith('.d.ts')

/** `./src/index.ts` → `./types/src/index.d.ts`; `null` for a target that is not a TypeScript module. */
export const declarationTarget = (target: string): string | null => {
	if (!target.startsWith('./') || !isSourceModule(target)) return null
	return `./${DECLARATION_DIRECTORY}/${target.slice(2).replace(SOURCE_MODULE, '.d.ts')}`
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A map of subpaths (`.`, `./x`) or import names (`#x`), as opposed to a map of conditions. */
const isSubpathMap = (value: Record<string, unknown>): boolean => Object.keys(value).every((key) => key.startsWith('.') || key.startsWith('#'))

/**
 * An `exports` or `imports` value with every TypeScript module typed by its declaration: a `types` condition is
 * repointed, and a bare TypeScript target gains one. Every other condition keeps the source, which Bun runs.
 */
const typedByDeclarations = (value: unknown, inConditions: boolean): unknown => {
	if (typeof value === 'string') {
		const declaration = inConditions ? null : declarationTarget(value)
		return declaration === null ? value : { types: declaration, default: value }
	}
	if (Array.isArray(value)) return value.map((target) => typedByDeclarations(target, inConditions))
	if (!isRecord(value)) return value
	const conditions = !isSubpathMap(value)
	return Object.fromEntries(
		Object.entries(value).map(([key, target]) => {
			if (conditions && key === 'types' && typeof target === 'string') return [key, declarationTarget(target) ?? target]
			return [key, typedByDeclarations(target, conditions)]
		}),
	)
}

/** The manifest as a release ships it: its `exports` and `imports` typed by `types/`, which `files` carries. */
export const declarationManifest = (manifest: Record<string, unknown>): Record<string, unknown> => {
	const shipped = { ...manifest }
	for (const field of ['exports', 'imports']) {
		if (shipped[field] !== undefined) shipped[field] = typedByDeclarations(shipped[field], false)
	}
	const files = shipped['files']
	if (Array.isArray(files) && !files.includes(DECLARATION_DIRECTORY)) shipped['files'] = [...files, DECLARATION_DIRECTORY]
	return shipped
}

/** Whether a manifest types any entry by a TypeScript module, so its release ships declarations. */
export const shipsDeclarations = (manifest: Record<string, unknown>): boolean => {
	const typesSource = (value: unknown): boolean => {
		if (typeof value === 'string') return isSourceModule(value)
		if (Array.isArray(value)) return value.some(typesSource)
		return isRecord(value) && Object.values(value).some(typesSource)
	}
	return typesSource(manifest['exports']) || typesSource(manifest['imports'])
}

const formatDiagnostics = (diagnostics: readonly ts.Diagnostic[], root: string): string =>
	ts.formatDiagnostics(diagnostics, {
		getCanonicalFileName: (fileName) => fileName,
		getCurrentDirectory: () => root,
		getNewLine: () => '\n',
	})

const insideDirectory = (directory: string, path: string): boolean => {
	const fromDirectory = relative(directory, path)
	return fromDirectory !== '' && !fromDirectory.startsWith('..') && !fromDirectory.startsWith(sep)
}

/**
 * Emits the declarations of `sources` (absolute paths of the TypeScript modules a package ships) under
 * `<outDirectory>/types`, with the compiler options of the package's own `tsconfig.json`, and returns the written
 * files. Any diagnostic of the emit fails it: a declaration that cannot be written portably would type a consumer
 * differently from the source.
 */
export const emitDeclarations = (packageDirectory: string, sources: readonly string[], outDirectory: string): readonly string[] => {
	const declarationRoot = join(outDirectory, DECLARATION_DIRECTORY)
	const configErrors: ts.Diagnostic[] = []
	const parsed = ts.getParsedCommandLineOfConfigFile(
		join(packageDirectory, 'tsconfig.json'),
		{
			noEmit: false,
			declaration: true,
			emitDeclarationOnly: true,
			declarationMap: false,
			sourceMap: false,
			rootDir: packageDirectory,
			outDir: declarationRoot,
		},
		{ ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => configErrors.push(diagnostic) },
	)
	if (parsed === undefined || configErrors.length > 0) {
		throw new Error(`${packageDirectory}: its tsconfig.json does not parse\n${formatDiagnostics(configErrors, packageDirectory)}`)
	}
	const rootNames = sources.filter(isSourceModule)
	const program = ts.createProgram({ rootNames, options: parsed.options })
	const written: string[] = []
	const emitted = program.emit(
		undefined,
		(fileName, text) => {
			const path = resolve(fileName)
			if (!insideDirectory(declarationRoot, path)) throw new Error(`${packageDirectory}: a declaration was emitted outside ${declarationRoot}: ${path}`)
			mkdirSync(dirname(path), { recursive: true })
			writeFileSync(path, text)
			written.push(path)
		},
		undefined,
		true,
	)
	const diagnostics = [
		...program.getOptionsDiagnostics(),
		...program.getGlobalDiagnostics(),
		...program.getSyntacticDiagnostics(),
		...program.getDeclarationDiagnostics(),
		...emitted.diagnostics,
	]
	if (diagnostics.length > 0) throw new Error(`${packageDirectory}: declarations do not emit\n${formatDiagnostics(diagnostics, packageDirectory)}`)
	const missing = rootNames.filter((source) =>
		!written.includes(join(declarationRoot, relative(packageDirectory, source)).replace(SOURCE_MODULE, '.d.ts'))
	)
	if (missing.length > 0) throw new Error(`${packageDirectory}: no declaration was emitted for ${missing.join(', ')}`)
	return written.sort()
}

/** A public package as the consumer type check reads it. */
export interface DeclaredPackage {
	readonly name: string
	/** The ambient type packages its own `tsconfig.json` names, which an application of it supplies; `null` reads every `@types/*`. */
	readonly types: readonly string[] | null
}

const tsconfigTypesSchema = z.object({ compilerOptions: z.object({ types: z.array(z.string()).optional() }).optional() })

/** The `compilerOptions.types` of a package's `tsconfig.json`, or `null` when it names none. */
export const tsconfigTypes = async (packageDirectory: string): Promise<readonly string[] | null> => {
	const path = join(packageDirectory, 'tsconfig.json')
	const { config, error } = ts.parseConfigFileTextToJson(path, await readFile(path, 'utf8'))
	if (error !== undefined) throw new Error(`${path}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
	return tsconfigTypesSchema.parse(config, { path: [path] }).compilerOptions?.types ?? null
}

const installedExportsSchema = z.object({ exports: z.record(z.string(), z.unknown()).optional() })

/** The subpath specifiers of an installed package whose export carries a `types` condition. */
const typedSpecifiers = async (consumer: string, name: string): Promise<readonly string[]> => {
	const path = join(consumer, 'node_modules', ...name.split('/'), 'package.json')
	const { exports } = installedExportsSchema.parse(JSON.parse(await readFile(path, 'utf8')), { path: [path] })
	return Object.entries(exports ?? {})
		.filter(([, target]) => isRecord(target) && typeof target['types'] === 'string')
		.map(([subpath]) => subpath === '.' ? name : `${name}/${subpath.slice(2)}`)
}

/**
 * The compiler options of the platform build's type check (`provider-zerops`'s `tsconfig.platform.json`), except that
 * `skipLibCheck` is off: a declaration that names something the consumer cannot resolve must fail here, because an
 * application's build skips declarations and would read the unresolved type as `any`.
 */
const consumerOptions = (consumer: string, types: readonly string[] | null): ts.CompilerOptions => {
	const { options, errors } = ts.convertCompilerOptionsFromJson({
		target: 'ES2022',
		module: 'ESNext',
		moduleResolution: 'bundler',
		lib: ['ES2022', 'DOM', 'DOM.Iterable'],
		jsx: 'react-jsx',
		strict: true,
		noUncheckedIndexedAccess: true,
		noImplicitOverride: true,
		forceConsistentCasingInFileNames: true,
		skipLibCheck: false,
		resolveJsonModule: true,
		isolatedModules: true,
		noEmit: true,
		...(types === null ? {} : { types }),
	}, consumer)
	if (errors.length > 0) throw new Error(formatDiagnostics(errors, consumer))
	return options
}

/**
 * Type-checks every typed entry of each installed package in `consumer` the way an application imports it, and fails
 * when an entry does not resolve, a declaration has an error, or the program reads a TypeScript source of a public
 * package instead of its declaration.
 */
export const checkConsumerDeclarations = async (consumer: string, packages: readonly DeclaredPackage[]): Promise<void> => {
	const installed = packages.map((item) => join(consumer, 'node_modules', ...item.name.split('/')))
	const failures: string[] = []
	for (const item of packages) {
		const specifiers = await typedSpecifiers(consumer, item.name)
		if (specifiers.length === 0) continue
		const entry = join(consumer, `types-${item.name.replace(/^@/, '').replaceAll('/', '-')}.ts`)
		await Bun.write(entry, `${specifiers.map((specifier, index) => `export type * as entry${index} from '${specifier}'`).join('\n')}\n`)
		const options = consumerOptions(consumer, item.types)
		// Type libraries resolve from the host's directory, which must be the consumer's, not this checkout's.
		const host = { ...ts.createCompilerHost(options), getCurrentDirectory: () => consumer }
		const program = ts.createProgram({ rootNames: [entry], options, host })
		const diagnostics: ts.Diagnostic[] = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]
		for (const file of program.getSourceFiles()) {
			const ours = file.fileName === entry || installed.some((directory) => insideDirectory(directory, file.fileName))
			if (!ours) continue
			if (!file.isDeclarationFile && file.fileName !== entry) {
				failures.push(`${item.name}: the consumer's type check reads the source ${relative(consumer, file.fileName)}`)
			}
			diagnostics.push(...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file))
		}
		if (diagnostics.length > 0) failures.push(`${item.name}: its declarations do not type-check\n${formatDiagnostics(diagnostics, consumer)}`)
	}
	if (failures.length > 0) throw new Error(failures.join('\n'))
}
