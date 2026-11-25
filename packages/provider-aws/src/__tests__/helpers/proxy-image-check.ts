// `bun run --filter @fabrika/provider-aws proxy-image:check`: builds a namespace proxy's image as the AWS build does, and
// starts it once. CI's `proxy-image` job runs it; nothing is pushed and no registry is logged in to.
//
// - The context is what Control uploads (ADR-0045): the commit's tracked files (`git archive HEAD`, so a change not yet
//   committed is not in it) and one data file, the manifest at `proxy.manifest.json`, which the AWS provider compiles
//   here from the notes fixture its tests use (`awsNamespaceProxyManifest`).
// - The image is built by the commit's recipe (`AWS_PROXY_DOCKERFILE`) for linux/amd64, as `AWS_PROXY_BUILDSPEC` builds
//   it. The recipe itself refuses an image whose binary cannot load its libraries or whose configuration Caddy refuses
//   (`ldd`, `caddy validate`).
// - The image is then started with no secrets (placeholders for what the auth service refuses to boot without). Caddy's
//   health listener must answer, and so must the auth service on its loopback port: `start.sh`, both processes and the
//   unprivileged user work together. The container and the image are removed afterwards.

import { contractDigest } from '@fabrika/auth-core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { schemaFromContract } from '../../../../app/src/contract/platform'
import { notesArtifact } from '../../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { awsAppArtifactCodec } from '../../codecs'
import { AWS_PROXY_DOCKERFILE, AWS_PROXY_MANIFEST_PATH } from '../../proxy-build'
import { awsNamespaceProxyManifest } from '../../proxy-manifest'

const ROOT = resolve(import.meta.dir, '..', '..', '..', '..', '..')
const TAG = 'fabrika-proxy-check:local'
const CONTAINER = 'fabrika-proxy-check'
/** The health listener of the recipe (`caddy.ts`'s default). */
const HEALTH_PORT = 8081
const HEALTH_ATTEMPTS = 30
/** The auth service's loopback port, which Caddy's `forward_auth` dials (the recipe's `FABRIKA_PROXY_PORT`). */
const AUTH_PORT = 9000
/**
 * What the auth service refuses to boot without, as placeholders that are no secret: the check never reaches IAM, and an
 * application without its proxy secret refuses every request (`appsWithoutProxySecret`).
 */
const PLACEHOLDER_ENV: readonly string[] = ['FABRIKA_IAM_ISSUER=https://iam.example.com', 'FABRIKA_IAM_KEY=check-only']

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

/** The manifest of one namespace with the notes application, as the AWS provider compiles it. */
function manifest(): string {
	const contract = { ...notesArtifact, tables: {}, jobs: {}, files: {}, fileKinds: {} }
	const digest = contractDigest(contract)
	const compiled = awsNamespaceProxyManifest('shared', [{
		appId: 'notes',
		env: 'prod',
		domain: 'notes.example.com',
		artifact: { provider: 'aws', version: 1, payload: awsAppArtifactCodec.encode({ contractDigest: digest, healthPath: '/healthz' }) },
		access: { contract, contractDigest: digest, schema: schemaFromContract(contract), checker: '0.9.1' },
		operationsOrigin: 'https://ops.example.com',
	}])
	return `${JSON.stringify(compiled, null, '\t')}\n`
}

/**
 * Whether the auth service answers on its loopback port inside the container: any HTTP status line from busybox's
 * `wget -S` is an answer (it reports an error status as a failure, so the exit code says nothing). While the binary
 * cannot start, `start.sh` restarts it every second and the port refuses the connection.
 */
async function authServiceAnswers(): Promise<boolean> {
	for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
		const child = Bun.spawn(['docker', 'exec', CONTAINER, 'wget', '-q', '-S', '-O', '/dev/null', `http://127.0.0.1:${AUTH_PORT}/`], {
			cwd: ROOT,
			stdout: 'ignore',
			stderr: 'pipe',
		})
		const [, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
		if (/^\s*HTTP\/1\.[01] \d{3}/m.test(stderr)) return true
		await Bun.sleep(1000)
	}
	return false
}

async function healthAnswers(): Promise<boolean> {
	const published = await read(['docker', 'port', CONTAINER, `${HEALTH_PORT}/tcp`])
	const address = published?.split('\n')[0]
	if (address === undefined || address === '') return false
	for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
		const answer = await fetch(`http://${address}/healthz`, { redirect: 'manual' }).catch(() => null)
		if (answer?.status === 200) return true
		await Bun.sleep(1000)
	}
	return false
}

async function main(): Promise<void> {
	const context = await mkdtemp(join(tmpdir(), 'fabrika-proxy-image-'))
	try {
		await run(['sh', '-c', `git archive --format=tar HEAD | tar -x -C '${context}'`])
		const manifestPath = join(context, AWS_PROXY_MANIFEST_PATH)
		// The data file goes where the commit holds nothing (ADR-0045); a commit that holds the path is refused.
		if (await Bun.file(manifestPath).exists()) throw new Error(`the commit holds ${AWS_PROXY_MANIFEST_PATH}`)
		if (!await Bun.file(join(context, AWS_PROXY_DOCKERFILE)).exists()) throw new Error(`the commit holds no ${AWS_PROXY_DOCKERFILE}`)
		await Bun.write(manifestPath, manifest())

		await run(['docker', 'build', '--platform', 'linux/amd64', '--file', join(context, AWS_PROXY_DOCKERFILE), '--tag', TAG, context])
		const env = PLACEHOLDER_ENV.flatMap((pair) => ['--env', pair])
		await run(['docker', 'run', '--detach', '--name', CONTAINER, '--platform', 'linux/amd64', ...env, '--publish', `127.0.0.1::${HEALTH_PORT}`, TAG])
		if (!await healthAnswers()) {
			await run(['docker', 'logs', CONTAINER]).catch(() => {})
			throw new Error(`the proxy image's health listener did not answer 200 on :${HEALTH_PORT}`)
		}
		// Caddy's health route is a static answer: the auth service must answer too, or it is crash-looping.
		if (!await authServiceAnswers()) {
			await run(['docker', 'logs', CONTAINER]).catch(() => {})
			throw new Error(`the proxy image's auth service did not answer on 127.0.0.1:${AUTH_PORT}`)
		}
		console.info(`proxy image: built for linux/amd64; Caddy serves its health route on :${HEALTH_PORT} and the auth service answers on :${AUTH_PORT}`)
	} finally {
		await read(['docker', 'rm', '--force', CONTAINER])
		await read(['docker', 'image', 'rm', TAG])
		await rm(context, { recursive: true, force: true })
	}
}

if (import.meta.main) {
	try {
		await main()
	} catch (error) {
		console.error(`proxy-image:check failed: ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	}
}
