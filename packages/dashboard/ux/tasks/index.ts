import type { UxTask } from '../checks/types'
import { environmentState } from './t01-environment-state'
import { deploy } from './t02-deploy'
import { incident } from './t03-incident'
import { backups } from './t04-backups'
import { rotateSecret } from './t05-rotate-secret'
import { approvals } from './t06-approvals'
import { reach } from './t07-reach'
import { grantSelf } from './t08-grant-self'
import { environmentForm } from './t09-environment-form'
import { builder } from './t10-builder'
import { errors } from './t11-errors'

/** The application page's tasks T1-T11, in the order of the console's information architecture. */
export const tasks: readonly UxTask[] = [
	environmentState,
	deploy,
	incident,
	backups,
	rotateSecret,
	approvals,
	reach,
	grantSelf,
	environmentForm,
	builder,
	errors,
]
