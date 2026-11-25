// The request kinds this release serves (ADR-0083 §8): every direct write a protected environment's `secrets`,
// `variables`, `data` and `registry` modes judge, Control's own rows and the writes that reach the provider or the
// environment's object alike, and an agent's grant, which IAM makes.

import type { RequestKindRegistry } from './kind'
import { recoverDataOperationKind, resumeAppEnvKind, setBackupScheduleKind, startDataOperationKind, suspendAppEnvKind } from './kinds/data'
import { createGrantKind } from './kinds/grants'
import { putEnvironmentKind, updateAppKind } from './kinds/registry'
import {
	deleteAppSecretKind,
	deleteVaultSecretKind,
	putAppSecretKind,
	rotateTokenKeyKind,
	rotateVaultSecretKind,
	setVaultSecretKind,
} from './kinds/secrets'
import { deleteAppVariableKind, putAppVariableKind } from './kinds/variables'

export const PRODUCTION_REQUEST_KINDS: RequestKindRegistry = new Map(
	[
		putAppSecretKind,
		deleteAppSecretKind,
		setVaultSecretKind,
		rotateVaultSecretKind,
		deleteVaultSecretKind,
		rotateTokenKeyKind,
		putAppVariableKind,
		deleteAppVariableKind,
		putEnvironmentKind,
		updateAppKind,
		setBackupScheduleKind,
		suspendAppEnvKind,
		resumeAppEnvKind,
		startDataOperationKind,
		recoverDataOperationKind,
		createGrantKind,
	].map((kind) => [kind.kind, kind]),
)
