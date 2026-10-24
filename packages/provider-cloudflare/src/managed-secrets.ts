import { isFrameworkVariableName } from '@fabrika/auth-core'
import type { ProviderManagedEnvironment } from '@fabrika/provider-contract'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export interface ManagedSplit {
	readonly vars: Readonly<Record<string, string>>
	readonly secrets: Readonly<Record<string, string>>
}

/** The values a deploy writes: a credential as a Worker secret, any other as a plain var; a null value is not written. */
export const splitManagedEnvironment = (managed: ProviderManagedEnvironment): ManagedSplit => {
	const vars: Record<string, string> = {}
	const secrets: Record<string, string> = {}
	for (const [name, { value, credential }] of Object.entries(managed)) {
		if (value === null) continue
		if (credential) secrets[name] = value
		else vars[name] = value
	}
	return { vars, secrets }
}

/**
 * Run `body` with the secrets in a JSON file only its owner reads, in a directory of its own, removed however `body`
 * ends. `body` gets null when there is nothing to write.
 */
export const withSecretsFile = async <T>(secrets: Readonly<Record<string, string>>, body: (path: string | null) => Promise<T>): Promise<T> => {
	if (Object.keys(secrets).length === 0) return body(null)
	const dir = await mkdtemp(join(tmpdir(), 'fabrika-secrets-'))
	try {
		const path = join(dir, 'secrets.json')
		await writeFile(path, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' })
		return await body(path)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

const secretListSchema = z.array(z.object({ name: z.string() }))

/** The names `wrangler secret list --format json` printed. */
export const parseSecretNames = (stdout: string): readonly string[] => {
	let decoded: unknown
	try {
		decoded = JSON.parse(stdout)
	} catch {
		decoded = undefined
	}
	const list = secretListSchema.safeParse(decoded)
	if (!list.success) throw new Error('wrangler secret list printed no readable list of secrets')
	return list.data.map((secret) => secret.name)
}

/**
 * The framework secrets a Worker still holds that this deploy no longer writes. Wider than `staleManagedVariables`: the
 * executor writes no framework secret of its own, so any other one is stale.
 */
export const staleManagedSecrets = (present: readonly string[], written: Readonly<Record<string, string>>): readonly string[] =>
	present.filter((name) => isFrameworkVariableName(name) && !Object.hasOwn(written, name))
