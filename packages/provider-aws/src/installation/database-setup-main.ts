// The database setup's entry: the command of the platform's setup task (`services.ts`), which the operator's command
// runs once on install and on every upgrade, before the services start. It connects as the instance's master user and
// runs `awsDatabaseSetupSteps` (`database.ts`): each service's user and database, closed to the others.
//
// Its variables are the task definition's: the instance's address as plain values, every password a secret its
// execution role alone reads. It prints the step it failed at, never a password.

import { SQL } from 'bun'
import {
	AWS_DATABASE_SERVICES,
	awsDatabaseAdminUrl,
	type AwsDatabaseService,
	awsDatabaseSession,
	awsDatabaseSetupSteps,
	runAwsDatabaseSetup,
} from './database'

/** The setup task's variables. */
export const AWS_DATABASE_SETUP_VARIABLES = {
	host: 'FABRIKA_AWS_DATABASE_HOST',
	port: 'FABRIKA_AWS_DATABASE_PORT',
	adminPassword: 'FABRIKA_AWS_DATABASE_ADMIN_PASSWORD',
} satisfies Readonly<Record<string, string>>

/** The variable a service's database password reaches the setup in. */
export function awsDatabaseSetupPasswordVariable(service: AwsDatabaseService): string {
	return `FABRIKA_AWS_DATABASE_${service.toUpperCase()}_PASSWORD`
}

function required(variables: Readonly<Record<string, string | undefined>>, name: string): string {
	const value = variables[name]?.trim() ?? ''
	if (value === '') throw new Error(`aws: the database setup's ${name} is not set`)
	return value
}

/** Runs the setup with `variables` (the process's environment). */
export async function runDatabaseSetupTask(variables: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
	const port = Number(required(variables, AWS_DATABASE_SETUP_VARIABLES.port))
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`aws: the database setup's ${AWS_DATABASE_SETUP_VARIABLES.port} is not a port`)
	}
	const outputs = { host: required(variables, AWS_DATABASE_SETUP_VARIABLES.host), port, clientGroupId: '' }
	const passwords: Record<AwsDatabaseService, string> = { iam: '', control: '', operations: '' }
	for (const service of AWS_DATABASE_SERVICES) passwords[service] = required(variables, awsDatabaseSetupPasswordVariable(service))
	const steps = awsDatabaseSetupSteps(passwords)
	const sql = new SQL({
		url: awsDatabaseAdminUrl(outputs, required(variables, AWS_DATABASE_SETUP_VARIABLES.adminPassword)),
		adapter: 'postgres',
		max: 1,
	})
	try {
		await runAwsDatabaseSetup(awsDatabaseSession(sql), steps)
	} finally {
		await sql.close()
	}
}

if (import.meta.main) {
	try {
		await runDatabaseSetupTask()
		console.info('aws: the database setup is done')
	} catch (error) {
		// Its own errors name a step or a variable, never a value; anything else is cut to its kind.
		console.error(error instanceof Error && error.message.startsWith('aws: ') ? error.message : 'aws: the database setup failed')
		process.exit(1)
	}
}
