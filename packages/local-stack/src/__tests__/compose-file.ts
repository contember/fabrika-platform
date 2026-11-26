import { resolve } from 'node:path'
import { APPS_PORT_VARIABLE, LOCAL_PORTS, PLATFORM_PORT_VARIABLE } from '../ports'

/** A compose file as `docker compose` reads it through `compose.ts`: the checkout's ports in place of their variables. */
export async function readComposeFile(name: 'compose.yaml' | 'compose.browser.yaml'): Promise<string> {
	const text = await Bun.file(resolve(import.meta.dir, '..', '..', name)).text()
	return text
		.replaceAll(`\${${PLATFORM_PORT_VARIABLE}:?}`, String(LOCAL_PORTS.platform))
		.replaceAll(`\${${APPS_PORT_VARIABLE}:?}`, String(LOCAL_PORTS.apps))
}
