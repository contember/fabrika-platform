import {
	FABRIKA_APP_ORIGIN,
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_APP_ID,
	FABRIKA_IAM_ISSUER,
	type FrameworkVariableName,
	isConnectUrlVariable,
	isFrameworkVariableName,
	PLATFORM_RECEIVERS,
	platformTransportVariables,
} from '@fabrika/auth-core'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

/** The managed variables that carry no credential: identities, origins and the release. Every other one is a Worker secret. */
const PUBLIC_MANAGED_VARIABLES: ReadonlySet<string> = new Set<FrameworkVariableName>([
	'FABRIKA_RELEASE',
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_ISSUER,
	FABRIKA_IAM_APP_ID,
	'FABRIKA_APP_ID',
	'FABRIKA_ENVIRONMENT',
	'FABRIKA_IAM_RPC_URL',
	FABRIKA_APP_ORIGIN,
])

const PLATFORM_URL_VARIABLES: ReadonlySet<string> = new Set(PLATFORM_RECEIVERS.map((receiver) => platformTransportVariables(receiver).url))

/** Whether a managed variable may be a plain Worker var. Fail closed: a name not known to be public is a secret. */
export const isPublicManagedVariable = (name: string): boolean =>
	PUBLIC_MANAGED_VARIABLES.has(name) || isConnectUrlVariable(name) || PLATFORM_URL_VARIABLES.has(name)

export interface ManagedSplit {
	readonly vars: Readonly<Record<string, string>>
	readonly secrets: Readonly<Record<string, string>>
}

/** The values a deploy writes, split into plain vars and Worker secrets; a null value is one the deploy no longer writes. */
export const splitManagedEnvironment = (managed: Readonly<Record<string, string | null>>): ManagedSplit => {
	const vars: Record<string, string> = {}
	const secrets: Record<string, string> = {}
	for (const [name, value] of Object.entries(managed)) {
		if (value === null) continue
		if (isPublicManagedVariable(name)) vars[name] = value
		else secrets[name] = value
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

/** The framework secrets a Worker still holds that this deploy no longer writes: a renamed or removed managed variable. */
export const staleManagedSecrets = (present: readonly string[], written: Readonly<Record<string, string>>): readonly string[] =>
	present.filter((name) => isFrameworkVariableName(name) && !Object.hasOwn(written, name))
