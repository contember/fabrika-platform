/**
 * The keys the composed Notes container's jobs and webhooks exchange with IAM (ADR-0022 "Principal kinds").
 *
 * On a platform, a deploy has Control issue one key per workload through IAM's `workloads.issueKey` and write it as
 * `FABRIKA_<KIND>_<NAME>_KEY`. Nothing deploys the composed container, so before it starts the local stack makes the same
 * call, with Control's own client and the same provisioning key, and keeps a stored key while IAM still exchanges it.
 * `local:smoke` then hands the container the keys its deploy wrote, as the platform would.
 *
 * The keys are secrets. They live in the ignored `.state/` directory and are never logged.
 */

import { MAX_KEY_LIFETIME_SECONDS, WORKLOAD_TOKEN_PATH } from '@fabrika/auth-core'
import { declaredWorkloads, iamWorkloadKeyIssuer, type WorkloadKind } from '@fabrika/control/workload-credentials'
import { notesContract } from 'fabrika-example-zerops/fabrika.config'
import { resolve } from 'node:path'
import { z } from 'zod'
import { readStateEnv } from './machine-key'
import { LOCAL_NOTES_IAM_APP_ID, STATE_DIR } from './prepare'

const IAM_ORIGIN = 'http://iam.fabrika.localhost:18080'
const NOTES_WORKLOADS_ENV_FILE = 'notes-workloads.env'

const exchangeAnswerSchema = z.object({ ok: z.boolean() })

/** Every workload key variable of the Notes contract, with the workload it belongs to. */
export const notesWorkloadKeys = (): ReadonlyMap<string, { readonly kind: WorkloadKind; readonly name: string }> => declaredWorkloads(notesContract)

/** Whether IAM exchanges `key` for a token of a Notes workload. An answer that is not IAM's decision throws. */
export const workloadKeyExchanges = async (key: string): Promise<boolean> => {
	const response = await fetch(new URL(WORKLOAD_TOKEN_PATH, IAM_ORIGIN), {
		method: 'POST',
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		body: JSON.stringify({ app: LOCAL_NOTES_IAM_APP_ID }),
		redirect: 'manual',
	})
	if (response.status !== 200) throw new Error(`IAM answered the workload token exchange with ${response.status}`)
	return exchangeAnswerSchema.parse(await response.json()).ok
}

/** Replace the keys the composed container starts with. */
export const writeNotesWorkloadKeys = async (keys: ReadonlyMap<string, string>): Promise<void> => {
	await Bun.write(resolve(STATE_DIR, NOTES_WORKLOADS_ENV_FILE), [...keys].map(([variable, key]) => `${variable}=${key}\n`).join(''))
}

/**
 * Make sure `.state/notes-workloads.env` holds a key IAM exchanges for every Notes workload, issuing the missing ones.
 * Called once IAM knows the Notes schema, and before the composed container starts.
 */
export const ensureNotesWorkloadKeys = async (): Promise<void> => {
	const provisioningKey = readStateEnv(resolve(STATE_DIR, 'iam.env'), 'FABRIKA_IAM_PROVISIONING_KEY')
	if (provisioningKey === null) {
		throw new Error('FABRIKA_IAM_PROVISIONING_KEY is missing from the generated local credentials')
	}
	const issuer = iamWorkloadKeyIssuer({ origin: IAM_ORIGIN, provisioningKey })
	const path = resolve(STATE_DIR, NOTES_WORKLOADS_ENV_FILE)
	const keys = new Map<string, string>()
	let issued = 0
	for (const [variable, workload] of notesWorkloadKeys()) {
		const stored = readStateEnv(path, variable)
		if (stored !== null && await workloadKeyExchanges(stored)) {
			keys.set(variable, stored)
			continue
		}
		const expiresAt = Math.floor(Date.now() / 1000) + MAX_KEY_LIFETIME_SECONDS
		const fresh = await issuer.issue({ app: LOCAL_NOTES_IAM_APP_ID, kind: workload.kind, name: workload.name, expiresAt, keep: null })
		keys.set(variable, fresh.key)
		issued += 1
	}
	await writeNotesWorkloadKeys(keys)
	if (issued > 0) console.info(`Notes workload keys issued through IAM: ${issued}`)
}
