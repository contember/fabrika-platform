// Run by public-kick.test.ts in a process of its own, which the test then kills: it boots the fixture on the schema its
// argument names, submits one signup, and prints `taken` once the kicked run holds the signup's row in its open
// transaction. Prints the URL never.

import { Database } from '@fabrika/db'
import { bootApp, environment, frameworkEnvFor, ORIGIN } from '../implement/harness'
import { signupApp } from './src/app'

const url = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''
const schema = process.argv[2] ?? ''
const { implementation, variables } = signupApp({
	started: () => Promise.resolve(),
	taken: async () => {
		console.log('taken')
		// Held until the test kills this process; the timer keeps it alive meanwhile.
		await Bun.sleep(60_000)
	},
	welcomed: () => {},
})
const app = bootApp(implementation, {
	environment: environment({ ...frameworkEnvFor(implementation), ...variables, TURNSTILE_SECRET: 'unused' }),
	database: Database.postgres({ url, schema, max: 2 }),
})
const answer = await app.fetch(
	new Request(`${ORIGIN}/api/visitors.signup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email: 'di@example.test' }),
	}),
	// As the Bun adapter serves a request: the kicked run is a task of the request's execution context.
	{ waitUntil: () => {} },
)
console.log(`answer: ${answer.status}`)
