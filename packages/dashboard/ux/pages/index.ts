import type { PageSpec } from '../checks/types'
import {
	applicationApprovals,
	applicationApprovalsEdit,
	applicationData,
	applicationOverview,
	applicationSecrets,
	applicationSettings,
} from './application'

export const pages: readonly PageSpec[] = [
	applicationOverview,
	applicationData,
	applicationApprovals,
	applicationApprovalsEdit,
	applicationSecrets,
	applicationSettings,
]
