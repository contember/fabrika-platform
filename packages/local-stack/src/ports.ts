import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The host ports of one checkout's stack, so two worktrees can run theirs side by side: the platform proxy on the base,
 * the apps proxy on the next port. Every public origin carries its port, and inside a container a `*.localhost` origin
 * reaches loopback (`loopback-forward.ts`), so the containers listen on these same ports, not only the host publish.
 */
export const LOCAL_PORT_BASE_VARIABLE = 'FABRIKA_LOCAL_PORT_BASE'
export const DEFAULT_LOCAL_PORT_BASE = 18080
/** What `prepareLocalStack` records, so every later command of this checkout finds its stack without the variable. */
export const PORTS_FILE = resolve(import.meta.dir, '..', '.state', 'ports.env')

/** The variables `compose.yaml` interpolates; every compose call of this package passes them. */
export const PLATFORM_PORT_VARIABLE = 'FABRIKA_LOCAL_PLATFORM_PORT'
export const APPS_PORT_VARIABLE = 'FABRIKA_LOCAL_APPS_PORT'

export interface LocalPorts {
	readonly platform: number
	readonly apps: number
}

export function parseLocalPortBase(text: string, source: string): number {
	const base = /^\d{1,5}$/.test(text) ? Number(text) : Number.NaN
	if (!(base >= 1024 && base <= 65_534)) {
		throw new Error(`${source}: ${LOCAL_PORT_BASE_VARIABLE} must be a port from 1024 to 65534 (the apps proxy takes the next one)`)
	}
	return base
}

export function parsePortsFile(text: string): number {
	const match = new RegExp(`^${LOCAL_PORT_BASE_VARIABLE}=(\\S*)\\n?$`).exec(text)
	if (match === null) throw new Error(`${PORTS_FILE} is malformed; explicitly reset the local stack`)
	return parseLocalPortBase(match[1] ?? '', PORTS_FILE)
}

/** The base this checkout's stack was prepared on, or undefined before its first prepare. */
export const readRecordedPortBase = (file: string = PORTS_FILE): number | undefined =>
	existsSync(file) ? parsePortsFile(readFileSync(file, 'utf8')) : undefined

/** The variable when set, else the base this checkout's stack was prepared on, else the default. */
export function resolveLocalPorts(env: Record<string, string | undefined>, recorded: number | undefined): LocalPorts {
	const requested = env[LOCAL_PORT_BASE_VARIABLE]
	const base = requested === undefined || requested === '' ? (recorded ?? DEFAULT_LOCAL_PORT_BASE) : parseLocalPortBase(requested, 'environment')
	return { platform: base, apps: base + 1 }
}

export const LOCAL_PORTS: LocalPorts = resolveLocalPorts(process.env, readRecordedPortBase())

export const localComposeEnv = (ports: LocalPorts = LOCAL_PORTS): Record<string, string> => ({
	[PLATFORM_PORT_VARIABLE]: String(ports.platform),
	[APPS_PORT_VARIABLE]: String(ports.apps),
})

const platformOrigin = (host: string): string => `http://${host}.fabrika.localhost:${LOCAL_PORTS.platform}`
const appsOrigin = (host: string): string => `http://${host}.fabrika.localhost:${LOCAL_PORTS.apps}`

export const IAM_ORIGIN = platformOrigin('iam')
export const CONTROL_ORIGIN = platformOrigin('control')
export const OPERATIONS_ORIGIN = platformOrigin('errors')
export const NOTES_ORIGIN = appsOrigin('notes')
/** A second Notes environment `local:seed` registers; nothing serves it. */
export const NOTES_TEST_ORIGIN = appsOrigin('notes-test')
/** A sibling host of the console, for the smoke's same-site admission check. */
export const SIBLING_ORIGIN = platformOrigin('sibling')
