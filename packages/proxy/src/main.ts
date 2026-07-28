/**
 * The Bun entrypoint — what `bun build --compile` turns into the `fabrika-proxy` binary that ships
 * next to the Caddy binary in `deployFiles`.
 *
 * It binds to LOOPBACK on purpose. The auth service must never be publicly routable: it answers
 * "is this request allowed" and hands back a signed token, so a reachable one is a token oracle.
 * Caddy is the only thing that may dial it.
 */

import { MemoryTokenCache } from './cache'
import { readProxyEnv } from './env'
import { HttpIamGateway } from './iam'
import { consoleLogger } from './log'
import { parseProxyManifest } from './manifest'
import { createVerifyService } from './service'

const env = readProxyEnv(Bun.env)

const raw: unknown = await Bun.file(env.manifestPath).json()
const manifest = parseProxyManifest(raw)
if (manifest === null) {
	// A manifest we do not fully understand is a gate list nobody wrote. Refuse to start; Caddy then
	// gets connection-refused on /verify and denies every request with a 502.
	consoleLogger.error('invalid proxy manifest', { path: env.manifestPath })
	process.exit(1)
}

const service = createVerifyService({
	manifest,
	iam: new HttpIamGateway({ origin: env.iamUrl, timeoutMs: env.iamTimeoutMs, ...(env.iamKey === undefined ? {} : { key: env.iamKey }) }),
	issuer: env.iamUrl,
	cache: env.cacheEnabled ? new MemoryTokenCache() : null,
	logger: consoleLogger,
})

Bun.serve({
	port: env.port,
	hostname: '127.0.0.1',
	fetch: service,
})

consoleLogger.info('proxy auth service listening', { port: env.port, apps: manifest.apps.length, cache: env.cacheEnabled })
