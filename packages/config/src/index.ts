// @fabrika/config — the provider-neutral app-authoring surface.

export type { AppConfigBase, AppPipeline } from '@fabrika/provider-contract'
export { defineApp } from './defineApp'

// Re-export the IAM declarations shared by every provider authoring package.
export type { AppActionDef, AppGates, AppSchema, AppScopeDef, CredentialLocation, GateKind, GateRule, RoleDef } from '@fabrika/auth-core'
