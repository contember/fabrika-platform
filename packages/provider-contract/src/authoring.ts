import type { AppSchema } from '@fabrika/auth-core'

/** Provider-neutral build inputs and environment requirements declared by an app. */
export interface AppPipeline {
	/** Source directory relative to the app config file. Defaults to `.`. */
	workerDir?: string
	/** Shell command that builds the deployable artifact. */
	build?: string
	/** Secret names that must resolve before deployment. */
	secrets?: string[]
	/** Non-secret variable names that must resolve before deployment. */
	vars?: string[]
}

/** App metadata shared by every provider-specific authoring config. */
export interface AppConfigBase {
	/** Stable app id, unique within one control plane. */
	id: string
	/** The app-owned authorization vocabulary reconciled into IAM. */
	schema?: AppSchema
	/** Provider-neutral build and environment requirements. */
	pipeline?: AppPipeline
}
