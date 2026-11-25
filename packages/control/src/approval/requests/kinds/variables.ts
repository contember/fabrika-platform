// The `variables` kinds (ADR-0083 §1, §8): an application variable set or deleted, in one environment or in the
// all-environments layer. A variable's value is shown in clear to everyone who manages the application, so the row
// stores it as the procedure takes it. Each executes through the use case its procedure runs.

import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { z } from 'zod'
import { fail } from '../../../api/domain'
import { assertAppVarWritable, deleteAppVarUseCase, putAppVarUseCase } from '../../../api/registry/configuration'
import { requestKind, type RequestKindContext } from '../kind'
import {
	agentText,
	appIdField,
	generationsField,
	generationsOf,
	layerCoordinates,
	layerField,
	layerName,
	observed,
	outcomeOf,
	ownText,
	registryContext,
	shown,
} from './shared'

const putVariableInput = z.object({
	appId: appIdField,
	variable: z.object({ name: z.string().min(1), value: z.string().min(1), env: layerField, notSecret: z.boolean().optional() }),
})
type PutVariableInput = z.infer<typeof putVariableInput>

const variableNameInput = z.object({ appId: appIdField, name: z.string().min(1), env: layerField })
type VariableNameInput = z.infer<typeof variableNameInput>

/** What a variable write binds: the environments it reaches, and the value stored now. */
const variableBefore = z.object({ generations: generationsField, value: z.string().nullable() })
type VariableBefore = z.infer<typeof variableBefore>

async function storedVariable(c: RequestKindContext, appId: string, env: string | null, name: string): Promise<string | null> {
	const row = (await c.repositories.registry.listAppVars(appId)).find((item) => item.env === env && item.name === name)
	return row?.value ?? null
}

async function variableBeforeOf(c: RequestKindContext, appId: string, env: string | null, name: string): Promise<VariableBefore> {
	return { generations: await generationsOf(c, appId, env), value: await storedVariable(c, appId, env, name) }
}

export const putAppVariableKind = requestKind<PutVariableInput, VariableBefore>({
	kind: 'apps.variables.put',
	category: 'variables',
	input: putVariableInput,
	before: variableBefore,
	coordinates: (input) => layerCoordinates(input.appId, input.variable.env),
	requesterAction: CONTROL_ACTIONS.APP_MANAGE,
	requesterAt: 'app',
	admit: (c, input) => assertAppVarWritable(c, input.appId, input.variable),
	captureBefore: (c, input) => variableBeforeOf(c, input.appId, input.variable.env ?? null, input.variable.name),
	execute: (c, input, execution) =>
		outcomeOf(async () => {
			const row = await putAppVarUseCase(registryContext(c, execution), input.appId, input.variable)
			return { name: row.name, env: row.env, value: row.value }
		}),
	follow: async (c, input) => {
		const { name, value } = input.variable
		const env = input.variable.env ?? null
		return observed((await storedVariable(c, input.appId, env, name)) === value, { name, env, value })
	},
	describe: (input, before) => ({
		summary: [
			ownText('Set variable '),
			agentText(input.variable.name),
			...(before === null
				? [ownText(` of ${layerName(input.appId, input.variable.env ?? null)}`)]
				: [ownText(` of ${layerName(input.appId, input.variable.env ?? null)} to `), agentText(input.variable.value)]),
		],
		facts: [
			{ label: 'Variable', value: agentText(input.variable.name) },
			// Once set, the new value is what the variable holds, so it is shown only where the value now is.
			before === null
				? { label: 'New value', value: ownText(`${[...input.variable.value].length} characters`) }
				: { label: 'Before → after', value: agentText(`${shown(before.value)} → ${input.variable.value}`) },
			...(input.variable.notSecret === true
				? [{ label: 'Not a secret', value: ownText('the agent says the value is not a credential, which Control would otherwise refuse') }]
				: []),
		],
	}),
})

export const deleteAppVariableKind = requestKind<VariableNameInput, VariableBefore>({
	kind: 'apps.variables.delete',
	category: 'variables',
	input: variableNameInput,
	before: variableBefore,
	coordinates: (input) => layerCoordinates(input.appId, input.env),
	requesterAction: CONTROL_ACTIONS.APP_MANAGE,
	requesterAt: 'app',
	admit: async (c, input) => {
		if ((await storedVariable(c, input.appId, input.env ?? null, input.name)) === null) fail(404, 'var not found')
	},
	captureBefore: (c, input) => variableBeforeOf(c, input.appId, input.env ?? null, input.name),
	execute: (c, input, execution) =>
		outcomeOf(async () => {
			await deleteAppVarUseCase(registryContext(c, execution), input.appId, input.name, input.env ?? null)
			return { name: input.name, env: input.env ?? null }
		}),
	follow: async (c, input) =>
		observed((await storedVariable(c, input.appId, input.env ?? null, input.name)) === null, { name: input.name, env: input.env ?? null }),
	describe: (input, before) => ({
		summary: [ownText('Delete variable '), agentText(input.name), ownText(` of ${layerName(input.appId, input.env ?? null)}`)],
		facts: [{ label: 'Variable', value: agentText(input.name) }, ...(before === null ? [] : [{ label: 'Now', value: agentText(shown(before.value)) }])],
	}),
})
