// `bun run --filter @fabrika/provider-aws platform-image:check`: builds the platform services' image as the AWS images
// build does, and checks what it holds. CI's `platform-image` job runs it; nothing is pushed and no registry is logged in
// to.
//
// - The context is the commit's tracked files (`git archive HEAD`, so a change not yet committed is not in it), as the
//   build's checkout of the release commit is, its `.git` aside (`platform.Dockerfile.dockerignore` keeps it out there).
// - The image is built by the commit's recipe (`AWS_SERVICES_DOCKERFILE`) for linux/amd64, as `AWS_IMAGES_BUILDSPEC`
//   builds it, so the recipe's own ignore file decides the context, as it does in the build.
// - The image must hold the console Control serves (`packages/dashboard/dist/index.html`) and each service's entry, and
//   run as the unprivileged user. The image is removed afterwards.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AWS_SERVICES_DOCKERFILE } from '../../installation/images'

const ROOT = resolve(import.meta.dir, '..', '..', '..', '..', '..')
const TAG = 'fabrika-platform-check:local'
/** What the image must hold: the console Control serves, and each service's entry (its task definition's command). */
const REQUIRED_FILES: readonly string[] = [
	'packages/dashboard/dist/index.html',
	'packages/iam/src/node/server.ts',
	'packages/control/src/aws/server.ts',
	'packages/operations/src/node/server.ts',
]

/** Runs a command at the repository root with its output shown, and fails on a non-zero exit. */
async function run(command: readonly string[], cwd: string = ROOT): Promise<void> {
	const child = Bun.spawn([...command], { cwd, stdout: 'inherit', stderr: 'inherit' })
	const code = await child.exited
	if (code !== 0) throw new Error(`${command.slice(0, 2).join(' ')} exited ${code}`)
}

/** Runs a command and answers its standard output, or null on a non-zero exit. */
async function read(command: readonly string[]): Promise<string | null> {
	const child = Bun.spawn([...command], { cwd: ROOT, stdout: 'pipe', stderr: 'ignore' })
	const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
	return code === 0 ? stdout.trim() : null
}

async function main(): Promise<void> {
	const context = await mkdtemp(join(tmpdir(), 'fabrika-platform-image-'))
	try {
		await run(['sh', '-c', `git archive --format=tar HEAD | tar -x -C '${context}'`])
		if (!await Bun.file(join(context, AWS_SERVICES_DOCKERFILE)).exists()) throw new Error(`the commit holds no ${AWS_SERVICES_DOCKERFILE}`)
		await run(['docker', 'build', '--platform', 'linux/amd64', '--file', join(context, AWS_SERVICES_DOCKERFILE), '--tag', TAG, context])
		for (const file of REQUIRED_FILES) {
			const held = await read(['docker', 'run', '--rm', '--platform', 'linux/amd64', '--entrypoint', 'test', TAG, '-f', `/app/${file}`])
			if (held === null) throw new Error(`the services' image holds no ${file}`)
		}
		const user = await read(['docker', 'run', '--rm', '--platform', 'linux/amd64', '--entrypoint', 'id', TAG, '-un'])
		if (user !== 'bun') throw new Error(`the services' image runs as ${user ?? 'an unknown user'}, not bun`)
		console.info(`platform image: built for linux/amd64; it holds the console and each service's entry, and runs as bun`)
	} finally {
		await read(['docker', 'image', 'rm', TAG])
		await rm(context, { recursive: true, force: true })
	}
}

if (import.meta.main) {
	try {
		await main()
	} catch (error) {
		console.error(`platform-image:check failed: ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	}
}
