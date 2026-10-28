// The base image of every dev workspace sandbox, built on the sandbox host from the Dockerfile context this package
// ships (`packages/provider-zerops/sandbox/`). Its name carries the hash of that context, so a release that changes the
// context builds a new base and every earlier one stays as it was.

import type { Sleeper } from '../collaborators'
import { type ZboxBase, type ZboxClient, ZboxOperationFailed } from '../zbox'

/** Every file of the build context; nothing else in the directory is sent. The scripts under `bin/` ship with each deploy. */
export const SANDBOX_BASE_CONTEXT_FILES = ['Dockerfile', 'init.sh'] as const

const CONTEXT_DIRECTORY = new URL('../../sandbox/', import.meta.url)

/** The first 12 hex of a sha256 over named files: the same bytes give the same version on every installation. */
export function contentVersion(files: Readonly<Record<string, Uint8Array>>): string {
	const hash = new Bun.CryptoHasher('sha256')
	for (const name of Object.keys(files).sort()) {
		const content = files[name]
		if (content === undefined) continue
		hash.update(`${name}\u0000${content.byteLength}\u0000`)
		hash.update(content)
	}
	return hash.digest('hex').slice(0, 12)
}

/** Reads `names` from the directory `relative` to the package's `sandbox/`. */
export async function readSandboxFiles(relative: string, names: readonly string[]): Promise<Record<string, Uint8Array>> {
	const directory = new URL(relative, CONTEXT_DIRECTORY)
	const files: Record<string, Uint8Array> = {}
	for (const name of names) files[name] = await Bun.file(new URL(name, directory)).bytes()
	return files
}

/** How long a base build may take. Measured: the package install and the flatten take well under a minute. */
const BASE_BUILD_DEADLINE_MS = 15 * 60_000

/** How often a base another call is building is read again. */
const BASE_POLL_MS = 3_000

export interface SandboxBaseContext {
	/** `fabrika-dev-<first 12 hex of the context's sha256>`. */
	readonly name: string
	readonly files: Readonly<Record<string, Uint8Array>>
}

/** The name of the base a context builds: the same bytes name the same base on every installation. */
export function sandboxBaseName(files: Readonly<Record<string, Uint8Array>>): string {
	return `fabrika-dev-${contentVersion(files)}`
}

/** The context this package ships. */
export async function readSandboxBaseContext(): Promise<SandboxBaseContext> {
	const files = await readSandboxFiles('./', SANDBOX_BASE_CONTEXT_FILES)
	return { name: sandboxBaseName(files), files }
}

/** The context as the plain tar archive `POST /base-build` takes. */
export async function sandboxBaseArchive(context: SandboxBaseContext): Promise<Uint8Array<ArrayBuffer>> {
	return new Bun.Archive({ ...context.files }).bytes()
}

export interface EnsureSandboxBaseOptions {
	readonly signal: AbortSignal
	readonly sleep: Sleeper
}

const failedBase = (name: string, code: string | null): Error =>
	new Error(
		`zerops: the dev sandbox base \`${name}\` failed to build on the sandbox host${code === null ? '' : ` (${code})`}; `
			+ 'delete it on the sandbox host, then create the sandbox again',
	)

/**
 * The digest of the context's base on the sandbox host: the one it holds READY, or one this call builds. A base that
 * FAILED is refused rather than rebuilt over, so the failure is seen once instead of retried on every workspace.
 */
export async function ensureSandboxBase(client: ZboxClient, context: SandboxBaseContext, options: EnsureSandboxBaseOptions): Promise<string> {
	const deadline = Date.now() + BASE_BUILD_DEADLINE_MS
	const named = async (): Promise<ZboxBase | null> =>
		(await client.listBases(options.signal)).find((base) => base.name === context.name && base.status !== 'DELETED') ?? null
	let base = await named()
	if (base === null) {
		const started = await client.buildBase({ context: await sandboxBaseArchive(context), name: context.name }, options.signal)
		try {
			await client.awaitOperation(started, { signal: options.signal, deadlineMs: BASE_BUILD_DEADLINE_MS })
		} catch (error) {
			if (error instanceof ZboxOperationFailed) throw failedBase(context.name, error.code)
			throw error
		}
		base = await named()
	}
	while (base !== null && (base.status === 'PULLING' || base.status === 'FLATTENING')) {
		options.signal.throwIfAborted()
		if (Date.now() > deadline) throw new Error(`zerops: the dev sandbox base \`${context.name}\` did not become ready in time`)
		await options.sleep(BASE_POLL_MS, options.signal)
		base = await named()
	}
	if (base === null) throw new Error(`zerops: the sandbox host does not list the dev sandbox base \`${context.name}\` it built`)
	if (base.status === 'FAILED') throw failedBase(context.name, null)
	return base.digest
}
