// The composed Notes container and the apps proxy follow the deploy the Zerops emulator activated. The emulator runs no
// code, so after a deploy the composition stands in for the platform: it takes the endpoint table Control published on
// the namespace proxy, the contract digest, workload keys and membership transport the deploy wrote, and the source of
// the deployed commit.
// Nothing here decides access: an approved snapshot is the only thing Control publishes (ADR-0050).

import { FABRIKA_CONTRACT_DIGEST } from '@fabrika/auth-core'
import { ZEROPS_NAMESPACE_PROXY_HOSTNAME } from '@fabrika/provider-zerops'
import { isApplicationEntry, parseProxyManifestJson } from '@fabrika/proxy-core/manifest'
import { cp, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { compose, type ComposeOptions } from './compose'
import { LOCAL_SOURCE_AGENT_CHANGE_DIRECTORY, LOCAL_SOURCE_FIXTURE_DIRECTORY } from './local-source-contract'
import { loadLocalSourceFixtures } from './local-source-fixtures/fixture'
import { requireMachineKey } from './machine-key'
import { MEMBERSHIP_KEY_VARIABLE, MEMBERSHIP_URL_VARIABLE, writeNotesMembershipTransport } from './membership-key'
import { controlRequest, type EmulatorSnapshot, emulatorSnapshot, notesServiceId } from './notes-deploy'
import { buildNotesSpa, LOCAL_NOTES_IAM_APP_ID, localAppsProxyManifest, STATE_DIR, writeAppsProxyConfig, writeNotesContractDigest } from './prepare'
import { completedRunSchema } from './smoke-schemas'
import { notesWorkloadKeys, writeNotesWorkloadKeys } from './workload-keys'

/** Where the composed container runs a fixture commit other than the workspace example; rewritten by every follow. */
const NOTES_SOURCE_DIRECTORY = 'notes-source'
const CONTAINER_STATE_DIR = '/workspace/packages/local-stack/.state'

/** The one value of `key` the emulator holds on `serviceId`; it may be a secret, so it is never printed. */
function soleVariable(snapshot: EmulatorSnapshot, serviceId: string, key: string): string {
	const value = optionalVariable(snapshot, serviceId, key)
	if (value === null) throw new Error(`the Zerops emulator holds no single ${key}`)
	return value
}

/** The value of `key` on `serviceId`, or null when the deploy wrote none. More than one is never a deploy's. */
function optionalVariable(snapshot: EmulatorSnapshot, serviceId: string, key: string): string | null {
	const records = snapshot.serviceEnv.filter((record) => record.serviceStackId === serviceId && record.key === key)
	if (records.length > 1) throw new Error(`the Zerops emulator holds more than one ${key}`)
	const content = records[0]?.content ?? ''
	return content === '' ? null : content
}

/**
 * Copy the agent change commit's files where the container can run them, with the example's install beside them, and
 * build its SPA, which the platform build would write and the commit does not hold.
 */
async function stageAgentChangeSource(): Promise<string> {
	const target = resolve(STATE_DIR, NOTES_SOURCE_DIRECTORY)
	await rm(target, { recursive: true, force: true })
	await cp(resolve(STATE_DIR, LOCAL_SOURCE_FIXTURE_DIRECTORY, LOCAL_SOURCE_AGENT_CHANGE_DIRECTORY), target, { recursive: true })
	// Relative, so it resolves to the example's install on the host and in the container alike.
	await symlink('../../../../examples/zerops-app/node_modules', resolve(target, 'node_modules'))
	await buildNotesSpa(target)
	return `${CONTAINER_STATE_DIR}/${NOTES_SOURCE_DIRECTORY}`
}

/**
 * Make the composition serve what the emulator's active Notes version deployed, and answer its commit. Only the two
 * pinned application commits can be followed: the workspace example, and the agent change.
 */
export async function followNotesDeploy(options: Pick<ComposeOptions, 'browser'> = {}): Promise<string> {
	const fixtures = await loadLocalSourceFixtures(resolve(STATE_DIR, LOCAL_SOURCE_FIXTURE_DIRECTORY))
	const snapshot = await emulatorSnapshot()
	const serviceId = notesServiceId(snapshot)
	const service = snapshot.services.find((candidate) => candidate.id === serviceId)
	const version = snapshot.appVersions.find((candidate) => candidate.id === service?.activeAppVersionId)
	if (version?.status !== 'ACTIVE' || version.name === undefined) throw new Error('the Zerops emulator has no active Notes version')
	const runId = version.name
	const { commitSha } = completedRunSchema.parse(await controlRequest('runs.get', requireMachineKey(), { runId }))
	const digest = version.runEnvVariables?.[FABRIKA_CONTRACT_DIGEST]
	if (digest === undefined) throw new Error('the active Notes version carries no contract digest')

	const proxies = snapshot.services.filter((candidate) =>
		candidate.projectId === version.projectId && candidate.name === ZEROPS_NAMESPACE_PROXY_HOSTNAME
	)
	if (proxies.length !== 1 || proxies[0] === undefined) throw new Error('the Notes project holds no single namespace proxy')
	// What the namespace proxy serves is the manifest its active version's archive carried (ADR-0045).
	const proxy = proxies[0]
	const served = snapshot.appVersions.find((candidate) => candidate.id === proxy.activeAppVersionId)?.uploadedProxyManifest
	const published = served === undefined ? null : parseProxyManifestJson(served)
	const entry = published?.apps.find((app) => app.id === LOCAL_NOTES_IAM_APP_ID)
	if (entry === undefined || !isApplicationEntry(entry) || entry.snapshot !== digest) {
		throw new Error('the namespace proxy does not serve the endpoint table of the active Notes contract')
	}

	let root: string | undefined
	if (commitSha === fixtures.agentChange.commitSha) root = await stageAgentChangeSource()
	else if (commitSha !== fixtures.application.commitSha) throw new Error(`deploy ${runId} is of commit ${commitSha}, which no local fixture holds`)

	const keys = new Map<string, string>()
	for (const variable of notesWorkloadKeys().keys()) keys.set(variable, soleVariable(snapshot, serviceId, variable))
	await writeNotesWorkloadKeys(keys)
	const membershipUrl = optionalVariable(snapshot, serviceId, MEMBERSHIP_URL_VARIABLE)
	const membershipKey = optionalVariable(snapshot, serviceId, MEMBERSHIP_KEY_VARIABLE)
	if ((membershipUrl === null) !== (membershipKey === null)) throw new Error('the Notes deploy wrote half of the membership transport')
	await writeNotesMembershipTransport(membershipUrl === null || membershipKey === null ? null : { url: membershipUrl, key: membershipKey })
	await writeNotesContractDigest(digest)
	const { endpoints, reservedPrefixes, snapshot: tableSnapshot, csp } = entry
	await writeAppsProxyConfig(localAppsProxyManifest({ endpoints, reservedPrefixes, snapshot: tableSnapshot, csp }))

	const composeOptions = { ...options, showOutput: false, ...(root === undefined ? {} : { env: { FABRIKA_LOCAL_NOTES_ROOT: root } }) }
	await compose(['up', '--detach', '--wait', '--force-recreate', 'notes'], composeOptions)
	await compose(['up', '--detach', '--wait', '--force-recreate', '--no-deps', 'apps-proxy-auth', 'apps-proxy'], composeOptions)
	return commitSha
}
