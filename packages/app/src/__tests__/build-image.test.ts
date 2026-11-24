import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { containerImage, type ContainerImageInput, contractRecipe, SOURCE_MAP_UPLOAD_SECRET } from '../build'

const BASE = `oven/bun:1.4.4-alpine@sha256:${'a'.repeat(64)}`
const DESTINATION = JSON.stringify({ url: 'https://ops.example.test/api/artifacts/source-maps/', roots: [{ prefix: '/', dir: 'web/dist' }] })

const input: ContainerImageInput = {
	recipe: {
		appId: 'notes',
		checkRelease: '0.9.1',
		sourceRoot: '/src',
		runtimeRoot: '/app',
		database: { schemaChecks: 'init' },
		sourceMaps: true,
		jobs: [{ name: 'digest', schedule: '0 6 * * *' }],
		files: false,
		scan: false,
	},
	baseImage: BASE,
	spaCommands: ['cd web && bun install --frozen-lockfile && bun run build'],
	runtimePackages: [],
	runtimeFiles: [],
	sourceMapUpload: DESTINATION,
	runtimeUser: '1000:1000',
}

const lines = (dockerfile: string): string[] => dockerfile.split('\n')
const INSTRUCTION = /^(?:FROM|USER|WORKDIR|COPY|RUN|CMD) /

describe('containerImage', () => {
	test('builds in the source root after the SPA commands, and runs the built tree from the runtime root', () => {
		const { dockerfile } = containerImage(input)
		const all = lines(dockerfile)
		const at = (line: string): number => all.indexOf(line)
		expect(all[1]).toBe(`FROM ${BASE} AS build`)
		expect(at('WORKDIR /src')).toBeGreaterThan(at(`FROM ${BASE} AS build`))
		expect(at('COPY . .')).toBeGreaterThan(at('WORKDIR /src'))
		expect(at('RUN cd web && bun install --frozen-lockfile && bun run build')).toBe(at('COPY . .') + 1)
		expect(at(`FROM ${BASE} AS runtime`)).toBeGreaterThan(at('COPY . .'))
		expect(at('COPY --from=build /src /app')).toBeGreaterThan(at(`FROM ${BASE} AS runtime`))
		expect(all.slice(-4)).toEqual(['WORKDIR /app', 'USER 1000:1000', 'CMD ["sh","/app/fabrika/start.generated.sh"]', ''])
	})

	test("runs the recipe's build steps in its order, each as one instruction", () => {
		const { dockerfile, recipe } = containerImage(input)
		const runs = lines(dockerfile).filter((line) => line.startsWith('RUN '))
		// The SPA command, then one RUN per recipe step.
		expect(runs).toHaveLength(1 + recipe.build.length)
		recipe.build.forEach((step, index) => {
			const run = runs[index + 1]
			if ('run' in step && !step.run.includes('fabrika-source-maps')) expect(run).toBe(`RUN ${step.run}`)
			if ('write' in step) expect(run).toContain(` > ${step.write}`)
		})
		for (const line of lines(dockerfile)) {
			if (line === '' || line.startsWith('#')) continue
			expect(line).toMatch(INSTRUCTION)
			expect(line.endsWith('\\')).toBe(false)
		}
	})

	test('a generated file is written byte for byte, whatever its lines hold', async () => {
		const tricky = ["it's", '$HOME and `date`', 'a\\nb', '"quoted"', '%s %d']
		const { dockerfile } = containerImage({ ...input, runtimeFiles: [{ path: '/etc/fabrika/check.txt', lines: tricky }] })
		const run = lines(dockerfile).find((line) => line.endsWith(' > /etc/fabrika/check.txt'))
		if (run === undefined) throw new Error('the runtime file is not written')
		// Run the same shell command against a scratch directory instead of /etc.
		const scratch = await mkdtemp(join(tmpdir(), 'fabrika-image-'))
		try {
			const command = run.slice('RUN '.length).replaceAll('/etc/fabrika', `${scratch}/etc/fabrika`)
			const shell = Bun.spawn(['sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' })
			expect(await shell.exited).toBe(0)
			expect(await readFile(`${scratch}/etc/fabrika/check.txt`, 'utf8')).toBe(`${tricky.join('\n')}\n`)
		} finally {
			await rm(scratch, { recursive: true, force: true })
		}
	})

	test("writes the recipe's generated scripts and starts the container with its start script", () => {
		const image = containerImage(input)
		expect(image.dockerfile).toContain(' > fabrika/migrate.generated.sh')
		expect(image.dockerfile).toContain(' > fabrika/verify.generated.sh')
		expect(image.dockerfile).toContain(' > fabrika/start.generated.sh')
		expect(image.init).toEqual([['sh', '/app/fabrika/migrate.generated.sh'], ['sh', '/app/fabrika/verify.generated.sh']])
		expect(image.start).toEqual(['sh', '/app/fabrika/start.generated.sh'])
		expect(containerImage({ ...input, recipe: { ...input.recipe, database: false } }).init).toEqual([])
	})

	test('hands the jobs to the provider and schedules none in the image', () => {
		const image = containerImage(input)
		expect(image.recipe.jobs).toEqual(contractRecipe(input.recipe).jobs)
		expect(image.dockerfile).not.toContain('job run')
		expect(image.dockerfile).not.toContain('crontab')
	})

	test('reads the source-map bearer from a build secret and never holds it', () => {
		const { dockerfile } = containerImage(input)
		const upload = lines(dockerfile).filter((line) => line.includes('fabrika-source-maps'))
		expect(upload).toHaveLength(1)
		const [line] = upload
		expect(line).toStartWith(`RUN --mount=type=secret,id=${SOURCE_MAP_UPLOAD_SECRET} export FABRIKA_SOURCE_MAP_UPLOAD='${DESTINATION}' `)
		expect(line).toContain(`FABRIKA_SOURCE_MAP_UPLOAD_KEY="$(cat /run/secrets/${SOURCE_MAP_UPLOAD_SECRET} 2>/dev/null)" && cd /tmp && `)
		// The build stage's last instruction, after every check, as in the recipe.
		const all = lines(dockerfile)
		expect(all[all.indexOf(`FROM ${BASE} AS runtime`) - 2]).toBe(line)
	})

	test('the exported destination reaches the upload command as given', async () => {
		const destination = `{"url":"https://ops.example.test/x","note":"it's"}`
		const { dockerfile } = containerImage({ ...input, sourceMapUpload: destination })
		const line = lines(dockerfile).find((candidate) => candidate.includes('fabrika-source-maps'))
		if (line === undefined) throw new Error('no upload step')
		const command = line
			.slice(line.indexOf(' export ') + 1)
			.replace(/ && cd \/tmp && .*$/, ' && printenv FABRIKA_SOURCE_MAP_UPLOAD && printenv FABRIKA_SOURCE_MAP_UPLOAD_KEY')
		const shell = Bun.spawn(['sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' })
		const [out, code] = await Promise.all([new Response(shell.stdout).text(), shell.exited])
		// Without the secret mounted the bearer is empty, and the step still runs.
		expect(code).toBe(0)
		expect(out).toBe(`${destination}\n\n`)
	})

	test('installs runtime packages once, sorted, before the built tree arrives', () => {
		const { dockerfile } = containerImage({ ...input, runtimePackages: ['freshclam', 'clamav', 'clamav'] })
		const all = lines(dockerfile)
		expect(all.indexOf('RUN apk add --no-cache clamav freshclam')).toBeLessThan(all.indexOf('COPY --from=build /src /app'))
		expect(all.indexOf('RUN apk add --no-cache clamav freshclam')).toBeGreaterThan(all.indexOf(`FROM ${BASE} AS runtime`))
	})

	test('refuses what the image cannot carry safely', () => {
		const refused = (change: Partial<ContainerImageInput>, message: RegExp): void => {
			expect(() => containerImage({ ...input, ...change })).toThrow(message)
		}
		refused({ recipe: { ...input.recipe, database: { schemaChecks: 'build' } } }, /schemaChecks 'init'/)
		refused({ baseImage: 'oven/bun:1.4.4-alpine' }, /pinned by its digest/)
		refused({ baseImage: `oven/bun:1.4.4-alpine@sha256:${'A'.repeat(64)}` }, /pinned by its digest/)
		refused({ runtimeUser: 'root' }, /not root/)
		refused({ runtimeUser: '0:0' }, /not root/)
		refused({ runtimeUser: 'bun; rm -rf /' }, /not root/)
		refused({ sourceMapUpload: null }, /exactly when the recipe uploads/)
		refused({ recipe: { ...input.recipe, sourceMaps: false } }, /exactly when the recipe uploads/)
		refused({ runtimePackages: ['clamav && curl'] }, /not an Alpine package name/)
		refused({ runtimeFiles: [{ path: 'relative/ca.pem', lines: [] }] }, /absolute path/)
		refused({ runtimeFiles: [{ path: '/etc/../root/ca.pem', lines: [] }] }, /absolute path/)
		refused({ runtimeFiles: [{ path: '/app/ca.pem', lines: [] }] }, /outside the runtime root/)
		refused({ runtimeFiles: [{ path: '/etc/ca.pem', lines: ['a\nb'] }] }, /one line/)
		refused({ spaCommands: ['bun run build\nrm -rf /'] }, /one line/)
		refused({ spaCommands: ['bun run build \\'] }, /backslash/)
		refused({ sourceMapUpload: '{"a":1}\n' }, /one line/)
	})
})
