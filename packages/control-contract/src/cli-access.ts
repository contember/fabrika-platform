// What the `fabrika` command-line client may ask IAM for on an installation's console: one OAuth resource per RPC
// path, and the presets a person approves it under (RFC 8628 device grant). A preset other than `create` names the
// one application it holds its actions at (`deploy:<app>`); IAM narrows every action to that app, whatever wider
// grant the person holds.

import { CONTROL_ACTIONS, CONTROL_SCOPES } from './access.js'

/** The console's RPC paths, each its own OAuth resource: the proxy binds a resource to exactly one row's path. */
export const CONTROL_RPC_PATH = '/api/rpc'
export const CONTROL_OPERATIONS_RPC_PATH = '/operations/api/rpc'

export const CONTROL_CLI_PRESETS = ['read', 'deploy', 'operate', 'create'] as const
export type ControlCliPreset = (typeof CONTROL_CLI_PRESETS)[number]

/** The scope dimension every preset but `create` is narrowed by. */
export const CONTROL_CLI_PRESET_PARAMETER = CONTROL_SCOPES.APP

/** One preset on one resource: the actions it may carry. */
export interface ControlCliScopeGrant {
	readonly scope: ControlCliPreset
	/** Absent only on `create`, which holds its action everywhere the person does. */
	readonly parameter?: typeof CONTROL_CLI_PRESET_PARAMETER
	readonly actions: readonly string[]
}

const READ = [CONTROL_ACTIONS.DEPLOY_READ, CONTROL_ACTIONS.DATA_READ]
const DEPLOY = [...READ, CONTROL_ACTIONS.DEPLOY_TRIGGER]

/**
 * The presets on the console's own RPC. None carries access approval, namespaces, source connections, mail or data
 * content: those stay with a person in the console.
 */
export const CONTROL_CLI_RPC_GRANTS: readonly ControlCliScopeGrant[] = [
	{ scope: 'read', parameter: CONTROL_CLI_PRESET_PARAMETER, actions: READ },
	{ scope: 'deploy', parameter: CONTROL_CLI_PRESET_PARAMETER, actions: DEPLOY },
	{ scope: 'operate', parameter: CONTROL_CLI_PRESET_PARAMETER, actions: [...DEPLOY, CONTROL_ACTIONS.SECRET_MANAGE, CONTROL_ACTIONS.APP_MANAGE] },
	// Registering an application needs `app.manage` held globally; IAM's consent page warns about it.
	{ scope: 'create', actions: [CONTROL_ACTIONS.APP_MANAGE] },
]

/** The resources a preset's grant covers: `create` concerns the console's RPC alone. */
export function controlCliPresetPaths(preset: ControlCliPreset): readonly string[] {
	return preset === 'create' ? [CONTROL_RPC_PATH] : [CONTROL_RPC_PATH, CONTROL_OPERATIONS_RPC_PATH]
}
