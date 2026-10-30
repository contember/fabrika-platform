// The opt-in configuration of the live Zerops Box suites: both variables, or neither.

const PREFIX = 'FABRIKA_LIVE_ZBOX_'
export const ORIGIN_VAR = `${PREFIX}API_ORIGIN`
export const KEY_VAR = `${PREFIX}API_KEY`
const REQUIRED_NAMES = [ORIGIN_VAR, KEY_VAR]
const RELAY_ORIGIN_VAR = `${PREFIX}RELAY_ORIGIN`
const RELAY_TOKEN_VAR = `${PREFIX}RELAY_TOKEN`

export interface LiveBox {
	origin: string
	apiKey: string
}

/** No configuration skips; a PARTIAL configuration throws rather than producing a false green. */
export function readLiveBox(environment: Record<string, string | undefined>): LiveBox | null {
	if (!configured(environment, REQUIRED_NAMES)) {
		return null
	}
	return { origin: bareHttpsOrigin(environment, ORIGIN_VAR), apiKey: environment[KEY_VAR] ?? '' }
}

export interface LiveRelay {
	origin: string
	token: string
}

/** The relay `zbox-router.live.test.ts` sends its router requests through (`router-relay.ts`); the same rules as the Box. */
export function readLiveRelay(environment: Record<string, string | undefined>): LiveRelay | null {
	if (!configured(environment, [RELAY_ORIGIN_VAR, RELAY_TOKEN_VAR])) {
		return null
	}
	return { origin: bareHttpsOrigin(environment, RELAY_ORIGIN_VAR), token: environment[RELAY_TOKEN_VAR] ?? '' }
}

function configured(environment: Record<string, string | undefined>, names: readonly string[]): boolean {
	const missing = names.filter((name) => !present(environment[name]))
	if (missing.length === names.length) {
		return false
	}
	if (missing.length > 0) {
		throw new Error(`Incomplete live Zerops Box test configuration; missing ${missing.join(', ')}`)
	}
	return true
}

function bareHttpsOrigin(environment: Record<string, string | undefined>, name: string): string {
	const raw = environment[name] ?? ''
	const url = URL.parse(raw)
	// A credential goes to whatever this names, so it must be a bare https origin and nothing that could redirect the path.
	if (url === null || url.protocol !== 'https:' || url.origin !== raw.replace(/\/$/, '')) {
		throw new Error(`${name} must be a bare https origin, such as https://zbox-xxxx-8080.prg1.zerops.app`)
	}
	return url.origin
}

function present(value: string | undefined): boolean {
	return value !== undefined && value !== ''
}
