// The opt-in configuration of the live Zerops Box suites: both variables, or neither.

const PREFIX = 'FABRIKA_LIVE_ZBOX_'
export const ORIGIN_VAR = `${PREFIX}API_ORIGIN`
export const KEY_VAR = `${PREFIX}API_KEY`
const REQUIRED_NAMES = [ORIGIN_VAR, KEY_VAR]

export interface LiveBox {
	origin: string
	apiKey: string
}

/** No configuration skips; a PARTIAL configuration throws rather than producing a false green. */
export function readLiveBox(environment: Record<string, string | undefined>): LiveBox | null {
	const configured = REQUIRED_NAMES.filter((name) => present(environment[name]))
	if (configured.length === 0) {
		return null
	}
	const missing = REQUIRED_NAMES.filter((name) => !present(environment[name]))
	if (missing.length > 0) {
		throw new Error(`Incomplete live Zerops Box test configuration; missing ${missing.join(', ')}`)
	}
	const raw = environment[ORIGIN_VAR] ?? ''
	const url = URL.parse(raw)
	// The key goes to whatever this names, so it must be a bare https origin and nothing that could redirect the path.
	if (url === null || url.protocol !== 'https:' || url.origin !== raw.replace(/\/$/, '')) {
		throw new Error(`${ORIGIN_VAR} must be a bare https origin, such as https://zbox-xxxx-8080.prg1.zerops.app`)
	}
	return { origin: url.origin, apiKey: environment[KEY_VAR] ?? '' }
}

function present(value: string | undefined): boolean {
	return value !== undefined && value !== ''
}
