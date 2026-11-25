// The request kinds this release serves (ADR-0083 §8): Control's local registry writes. A write that reaches outside
// Control (a provider's secret, an environment's provider registration, suspension, a data operation) is not here yet.

import type { RequestKindRegistry } from './kind'
import { setBackupScheduleKind } from './kinds/data'
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
	].map((kind) => [kind.kind, kind]),
)
