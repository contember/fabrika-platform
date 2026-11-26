import { IAM_APP_ID } from '@fabrika/iam-contract'

/**
 * The one source of the installation itself (`origin = 'installation'`), for signals that belong to no application:
 * sign-ins happen at IAM. Its app id is IAM's, and only an app-scoped grant at that id or a global grant reaches it
 * (`access.ts`); an environment-scoped grant never does. The leading underscore is outside the catalog's coordinate
 * pattern (`catalog.ts`), so Control can never name this coordinate.
 */
export const INSTALLATION_SOURCE = Object.freeze({
	appId: IAM_APP_ID,
	environment: '_installation',
	displayName: 'Installation',
})
