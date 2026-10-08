#!/usr/bin/env bun

import { reconcileSchema } from '@fabrika/auth'
import { appEnvironmentId } from '@fabrika/auth-core'
import { exampleAppId, exampleAppSchema } from '../fabrika.schema'

// IAM registers the schema per environment, under `<app>@<env>` (ADR-0022 rule 6).
const iamAppId = appEnvironmentId(exampleAppId, process.env['APP_ENV'] ?? 'local')

function required(value: string | undefined, name: string): string {
	if (value === undefined || value === '') {
		throw new Error(`Missing required env var ${name}`)
	}
	return value
}

function describeSchema(): void {
	console.log(`  app:     ${iamAppId}`)
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

	const url = required(process.env['FABRIKA_IAM_ISSUER'], 'FABRIKA_IAM_ISSUER')
	const adminKey = process.env['FABRIKA_IAM_ADMIN_KEY']
	await reconcileSchema({
		url,
		app: iamAppId,
		schema: exampleAppSchema,
		...(adminKey === undefined ? {} : { adminKey }),
	})
	console.log(`Reconciled ${iamAppId}.`)
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
})
