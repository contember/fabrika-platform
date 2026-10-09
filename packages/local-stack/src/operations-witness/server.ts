// The witness's process in the local composition. It reads the managed Operations values the browser suite sets and
// bundles the SDK page script once at start.

import { createBunHandler } from '@fabrika/app/bun'
import { parseJwks, TokenVerifier } from '@fabrika/jwks'
import { witnessApp } from './app'
import { WITNESS_IAM_APP_ID } from './placement'

const required = (name: string): string => {
	const value = process.env[name]
	if (value === undefined || value.trim() === '') throw new Error(`${name} is required`)
	return value
}

const issuer = required('FABRIKA_IAM_ISSUER')
const verifier = new TokenVerifier({
	issuer,
	getJwks: async () => {
		const jwks = parseJwks(await (await fetch(new URL('/.well-known/jwks.json', issuer))).json())
		if (jwks === null) throw new Error('IAM answered no key set')
		return jwks
	},
})
const build = await Bun.build({ entrypoints: [new URL('./browser.ts', import.meta.url).pathname], target: 'browser', minify: true })
const script = build.outputs[0]
if (!build.success || script === undefined) throw new Error('the Operations SDK witness script did not build')

const handler = createBunHandler(witnessApp, {
	verified: async (token) => (await verifier.verify(token, WITNESS_IAM_APP_ID)).ok,
	fixture: { dsn: required('FABRIKA_OPERATIONS_DSN'), release: required('FABRIKA_RELEASE'), script: await script.text() },
}, { onBackgroundError: () => console.error('background task failed') })

const server = Bun.serve({ port: 3000, hostname: '0.0.0.0', fetch: handler.fetch })
console.info(`Operations SDK witness listening on ${server.port}`)
process.on('SIGTERM', () => void server.stop(false).then(() => process.exit(0)))
