#!/usr/bin/env bun

import { reconcileSchema } from '@fabrika/auth'
import { environmentAliases } from '@fabrika/platform'
import { exampleAppId, exampleAppSchema } from '../fabrika.schema'

function required(value: string | undefined, name: string): string {
	if (value === undefined || value === '') {
		throw new Error(`Missing required env var ${name}`)
	}
	return value
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

	const url = required(
		environmentAliases.read(
			{ FABRIKA_IAM_URL: process.env['FABRIKA_IAM_URL'], PROPUSTKA_URL: process.env['PROPUSTKA_URL'] },
			{ canonical: 'FABRIKA_IAM_URL', legacy: 'PROPUSTKA_URL' },
		),
		'FABRIKA_IAM_URL',
	)
	const adminKey = environmentAliases.read(
		{
			FABRIKA_IAM_ADMIN_KEY: process.env['FABRIKA_IAM_ADMIN_KEY'],
			PROPUSTKA_ADMIN_KEY: process.env['PROPUSTKA_ADMIN_KEY'],
		},
		{ canonical: 'FABRIKA_IAM_ADMIN_KEY', legacy: 'PROPUSTKA_ADMIN_KEY' },
	)
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
