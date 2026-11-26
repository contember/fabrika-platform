import type { PageSpec } from '../checks/types'
import {
	applicationAccess,
	applicationApprovals,
	applicationApprovalsEdit,
	applicationData,
	applicationOverview,
	applicationSecrets,
	applicationSettings,
} from './application'
import { applicationList } from './applications'

export const pages: readonly PageSpec[] = [
	applicationList,
	applicationOverview,
	applicationData,
	applicationApprovals,
	applicationApprovalsEdit,
	applicationSecrets,
	applicationAccess,
	applicationSettings,
]
