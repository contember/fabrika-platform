import type { PageSpec } from '../checks/types'
import { applicationApprovals, applicationApprovalsEdit, applicationData, applicationOverview, applicationSettings } from './application'

export const pages: readonly PageSpec[] = [applicationOverview, applicationData, applicationApprovals, applicationApprovalsEdit, applicationSettings]
