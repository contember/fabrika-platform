/**
 * The machine credential the local stack drives the control API with.
 *
 * Since the platform proxy enforces the real `CONTROL_PROXY_GATES`, `/api/*` admits either a logged-in
 * human or a `px_` service key the proxy can exchange with IAM (`mintFromKey`). `FABRIKA_IAM_PROVISIONING_KEY`
 * is NOT such a key: IAM resolves it in `resolveCaller` for its own `/admin/*` surface and it has no
 * `credentials` row, so the proxy refuses it with `invalid_key` before control ever sees the bearer.
 *
 * So the local stack does what an operator or a CI job does: it asks IAM's admin surface, once, for a
 * real service API key, and reuses it until it stops working. Nothing here exists only locally — the
 * credential, the endpoint and the exchange are all the production ones.
 *
 * The key is a secret. It lives in the ignored `.state/` directory and is never logged.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STATE_DIR } from './prepare'

const IAM_ORIGIN = 'http://iam.fabrika.localhost:18080'
const CONTROL_ORIGIN = 'http://control.fabrika.localhost:18080'
const MACHINE_ENV_FILE = 'machine.env'
const MACHINE_KEY_NAME = 'FABRIKA_LOCAL_MACHINE_KEY'

export const machineEnvPath = (): string => resolve(STATE_DIR, MACHINE_ENV_FILE)

/** Read `NAME=value` out of one of the generated `.state/*.env` files. */
export const readStateEnv = (path: string, name: string): string | null => {
	if (!existsSync(path)) {
		return null
	}
	const line = readFileSync(path, 'utf8').split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}=`))
	const value = line?.slice(name.length + 1)
	return value === undefined || value === '' ? null : value
}

/** The machine key a previous `up` provisioned, or null. */
export const readMachineKey = (): string | null => readStateEnv(machineEnvPath(), MACHINE_KEY_NAME)

/** The machine key, or a message naming the command that creates one. */
export const requireMachineKey = (): string => {
	const key = readMachineKey()
	if (key === null) {
		throw new Error(`${MACHINE_KEY_NAME} is missing from ${machineEnvPath()} — run \`bun run local:up\``)
	}
	return key
}

const property = (value: unknown, key: string): unknown =>
	typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined

/** Does this key still buy an authorized control-plane call through the proxy? */
const stillWorks = async (key: string): Promise<boolean> => {
	try {
		const response = await fetch(`${CONTROL_ORIGIN}/api/namespaces`, {
			headers: { accept: 'application/json', authorization: `Bearer ${key}` },
			redirect: 'manual',
		})
		return response.ok
	} catch {
		return false
	}
}

const provision = async (provisioningKey: string): Promise<string> => {
	const response = await fetch(`${IAM_ORIGIN}/admin/api-keys`, {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			origin: IAM_ORIGIN,
			authorization: `Bearer ${provisioningKey}`,
		},
		// No `app`: a cross-app grant, so the same credential works for every service the local stack
		// fronts. `['*']` is the only pattern a cross-app grant accepts today.
		body: JSON.stringify({ label: 'local stack machine operator', type: 'service', permissions: ['*'] }),
	})
	if (!response.ok) {
		throw new Error(`IAM refused to provision the local machine key (${response.status})`)
	}
	const body: unknown = await response.json()
	const apiKey = property(body, 'apiKey')
	if (typeof apiKey !== 'string' || apiKey === '') {
		throw new Error('IAM did not return a local machine key')
	}
	return apiKey
}

/**
 * Make sure `.state/machine.env` holds a key that authorizes the control API, provisioning one if the
 * stored key is missing or no longer resolves. Called after the composition reports healthy.
 */
export const ensureMachineKey = async (): Promise<void> => {
	const provisioningKey = readStateEnv(resolve(STATE_DIR, 'iam.env'), 'FABRIKA_IAM_PROVISIONING_KEY')
	if (provisioningKey === null) {
		throw new Error('FABRIKA_IAM_PROVISIONING_KEY is missing from the generated local credentials')
	}
	const existing = readMachineKey()
	if (existing !== null && await stillWorks(existing)) {
		return
	}
	const key = await provision(provisioningKey)
	await Bun.write(machineEnvPath(), `${MACHINE_KEY_NAME}=${key}\n`)
	console.info('Local stack machine key provisioned through IAM')
}
