import type { PageSpec } from '../checks/types'
import { applicationApprovals, applicationData, applicationOverview, applicationSettings } from './application'

export const pages: readonly PageSpec[] = [applicationOverview, applicationData, applicationApprovals, applicationSettings]
