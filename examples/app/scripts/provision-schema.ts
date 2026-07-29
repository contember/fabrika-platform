#!/usr/bin/env bun

import { reconcileSchema } from '@fabrika/auth'
import { exampleAppId, exampleAppSchema } from '../propustka.schema'

function required(name: string): string {
	const value = process.env[name]
	if (value === undefined || value === '') {
		throw new Error(`Missing required env var ${name}`)
	}
	return value
}

function optional(name: string): string | undefined {
	const value = process.env[name]
	return value === undefined || value === '' ? undefined : value
}

function describeSchema(): void {
	console.log(`  app:     ${exampleAppId}`)
	console.log(`  scopes:  ${exampleAppSchema.scopes.map((scope) => scope.type).join(', ') || '(none)'}`)
	console.log(`  actions: ${exampleAppSchema.actions.map((action) => action.action).join(', ') || '(none)'}`)
	console.log(`  roles:   ${Object.keys(exampleAppSchema.roles).join(', ') || '(none)'}`)
}

async function main(): Promise<void> {
	if (process.argv.includes('--dry-run')) {
		console.log('DRY RUN — no changes. Would reconcile:')
		describeSchema()
		return
	}

	const url = required('PROPUSTKA_URL')
	const adminKey = optional('PROPUSTKA_ADMIN_KEY')
	await reconcileSchema({
		url,
		app: exampleAppId,
		schema: exampleAppSchema,
		...(adminKey === undefined ? {} : { adminKey }),
	})
	console.log(`Reconciled ${exampleAppId}.`)
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
})
