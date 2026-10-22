import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import ts from 'typescript'
import { PLATFORM_TYPESCRIPT_VERSION } from '../../packages/provider-zerops/src/execution'
import { checkConsumerDeclarations, declarationManifest, declarationTarget, emitDeclarations, shipsDeclarations } from '../declarations'

const withDirectory = async (run: (directory: string) => Promise<void>): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), 'fabrika-declarations-'))
	try {
		await run(directory)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}

const writeFiles = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true })
		await writeFile(join(root, path), text)
	}
}

describe('a shipped manifest', () => {
	const source = {
		name: '@fabrika/example',
		files: ['src', '!src/**/__tests__/**'],
		exports: {
			'.': { bun: './src/index.ts', types: './src/index.ts', default: './src/index.ts' },
			'./screen': { bun: './src/Screen.tsx', types: './src/Screen.tsx', default: './src/Screen.tsx' },
			'./bare': './src/bare.ts',
			'./styles.css': './src/styles.css',
			'./package.json': './package.json',
		},
		imports: { '#runtime': './src/runtime.ts' },
	}

	test('types every TypeScript entry by its declaration and keeps the source for every runtime condition', () => {
		expect(declarationManifest(source)).toEqual({
			name: '@fabrika/example',
			files: ['src', '!src/**/__tests__/**', 'types'],
			exports: {
				'.': { bun: './src/index.ts', types: './types/src/index.d.ts', default: './src/index.ts' },
				'./screen': { bun: './src/Screen.tsx', types: './types/src/Screen.d.ts', default: './src/Screen.tsx' },
				'./bare': { types: './types/src/bare.d.ts', default: './src/bare.ts' },
				'./styles.css': './src/styles.css',
				'./package.json': './package.json',
			},
			imports: { '#runtime': { types: './types/src/runtime.d.ts', default: './src/runtime.ts' } },
		})
		expect(source.exports['.'].types).toBe('./src/index.ts')
	})

	test('leaves a condition object without a types condition as it is', () => {
		const exports = { '.': { bun: './src/index.ts', default: './dist/index.js' } }
		expect(declarationManifest({ exports })).toEqual({ exports })
	})

	test('ships declarations only when an entry is a TypeScript module', () => {
		expect(shipsDeclarations(source)).toBe(true)
		expect(shipsDeclarations({ exports: { './package.json': './package.json' } })).toBe(false)
		expect(declarationTarget('./src/a.d.ts')).toBeNull()
		expect(declarationTarget('./src/a.css')).toBeNull()
	})
})

const PACKAGE_TSCONFIG = JSON.stringify({
	compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, types: [] },
	include: ['src/**/*'],
})

describe('emitting the declarations of a package', () => {
	test('writes one declaration per shipped module under types/, mirroring the package', async () => {
		await withDirectory(async (root) => {
			const packageDirectory = join(root, 'package')
			await writeFiles(packageDirectory, {
				'tsconfig.json': PACKAGE_TSCONFIG,
				'src/index.ts': "export { twice } from './math/twice'\n",
				'src/math/twice.ts': 'export const twice = (value: number) => value * 2\n',
				'src/__tests__/twice.test.ts': "import { twice } from '../math/twice'\ntwice(1)\n",
			})
			const staging = join(root, 'staging')
			const written = emitDeclarations(packageDirectory, [join(packageDirectory, 'src/index.ts'), join(packageDirectory, 'src/math/twice.ts')], staging)
			expect(written.map((path) => relative(staging, path))).toEqual(['types/src/index.d.ts', 'types/src/math/twice.d.ts'])
			expect(await readFile(join(staging, 'types/src/math/twice.d.ts'), 'utf8')).toContain('export declare const twice: (value: number) => number')
		})
	})

	test('fails on a declaration it cannot write', async () => {
		await withDirectory(async (root) => {
			await writeFiles(root, { 'tsconfig.json': PACKAGE_TSCONFIG, 'src/index.ts': 'export const Hidden = class { private secret = 1 }\n' })
			expect(() => emitDeclarations(root, [join(root, 'src/index.ts')], join(root, 'staging'))).toThrow('declarations do not emit')
		})
	})
})

describe('a consumer of the shipped declarations', () => {
	const installed = (types: string, files: Readonly<Record<string, string>>): Record<string, string> => ({
		'node_modules/@fabrika/example/package.json': JSON.stringify({
			name: '@fabrika/example',
			exports: { '.': { bun: './src/index.ts', types, default: './src/index.ts' } },
		}),
		'node_modules/@fabrika/example/src/index.ts': 'export const answer = 42\n',
		...Object.fromEntries(Object.entries(files).map(([path, text]) => [`node_modules/@fabrika/example/${path}`, text])),
	})
	const packages = [{ name: '@fabrika/example', types: [] }]

	test('accepts declarations that resolve', async () => {
		await withDirectory(async (consumer) => {
			await writeFiles(consumer, installed('./types/src/index.d.ts', { 'types/src/index.d.ts': 'export declare const answer = 42;\n' }))
			await checkConsumerDeclarations(consumer, packages)
		})
	})

	test('refuses a declaration that names what the consumer cannot resolve', async () => {
		await withDirectory(async (consumer) => {
			await writeFiles(consumer, installed('./types/src/index.d.ts', { 'types/src/index.d.ts': 'export declare const answer: Missing;\n' }))
			await expect(checkConsumerDeclarations(consumer, packages)).rejects.toThrow("Cannot find name 'Missing'")
		})
	})

	test('refuses an entry typed by its TypeScript source', async () => {
		await withDirectory(async (consumer) => {
			await writeFiles(consumer, installed('./src/index.ts', {}))
			await expect(checkConsumerDeclarations(consumer, packages)).rejects.toThrow("the consumer's type check reads the source")
		})
	})
})

test('declarations are emitted by the TypeScript release the platform build reads them with', () => {
	// A newer compiler may write declaration syntax the build's older one cannot parse.
	expect(ts.version).toBe(PLATFORM_TYPESCRIPT_VERSION)
})
