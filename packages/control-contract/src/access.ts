/** IAM vocabulary shared by the Control runtime, its Access schema and the console. */

/** Durable IAM application id of the console — a deployed identity, not configuration branding (ADR-0024). */
export const CONTROL_APP_ID = 'vozka'

/**
 * The actions Control authorizes against. AWS-IAM-style dotted strings; IAM's `permits` matches
 * them (incl. `*` / `prefix.*` wildcards in granted roles).
 */
export const CONTROL_ACTIONS = Object.freeze({
	/** Trigger a deploy run (the manual "Deploy" button / triggerDeploy RPC). Scoped by app/environment. */
	DEPLOY_TRIGGER: 'deploy.trigger',
	/** Read deploy runs + their logs (run history API). Scoped by app/environment. */
	DEPLOY_READ: 'deploy.read',
	/** Manage the app registry (apps + app_envs CRUD, onboarding). Scoped by app (global to create). */
	APP_MANAGE: 'app.manage',
	/** Manage provider-owned deployment namespaces and their lifecycle. Global because namespaces may span apps. */
	NAMESPACE_MANAGE: 'namespace.manage',
	/**
	 * Manage SECRET VALUES + their references. Gates the app_secrets reference CRUD (scoped by app) AND
	 * writing/rotating/deleting the encrypted per-app/app-env VALUES in the vault. The value is
	 * write-only over the API; it is never returned. (Platform creds — the CF token, IAM
	 * provisioning creds — are fabrika's own Worker secrets, not managed through this action.)
	 */
	SECRET_MANAGE: 'secret.manage',
	/** Manage the platform GitHub source connection. Global because it changes control-wide credentials. */
	SOURCE_CONNECTION_MANAGE: 'source.connection.manage',
	/** Read the files of one's own Git workspaces on an authoring target (ADR-0049). Scoped by app/environment. */
	SOURCE_WORKSPACE_READ: 'source.workspace.read',
	/** Create Git workspaces and commit to them on an authoring target. Scoped by app/environment. */
	SOURCE_WORKSPACE_WRITE: 'source.workspace.write',
	/** Open a pull request from one's own workspace to the default branch. Scoped by app/environment. */
	SOURCE_PULL_REQUEST_CREATE: 'source.pull-request.create',
	/**
	 * Approve a widening of an environment's access and change its `protected` flag (ADR-0050). Outside `deploy.*`, so
	 * the operator role does not hold it; only a human user principal in the console may use it. Scoped by app/environment.
	 */
	ACCESS_APPROVE: 'access.approve',
	/**
	 * List relayed mail and read its metadata. Scoped by app/environment for an application's messages; an installation
	 * sender's messages need a global grant.
	 */
	MAIL_READ: 'mail.read',
	/** Read a relayed message's recipient, subject and bodies. Global. */
	MAIL_CONTENT_READ: 'mail.content.read',
	/** Release or drop a held message, requeue a final one, and change the gate's rules. Global. */
	MAIL_MANAGE: 'mail.manage',
})

/**
 * The scope dimensions Control authorizes within (flat + independent IAM semantics):
 *  - `app`         — scoped to one registered app (its `id`), across every environment.
 *  - `environment` — scoped to one environment name (e.g. only `stage`), across apps.
 * A grant with neither scope is global.
 */
export const CONTROL_SCOPES = Object.freeze({
	APP: 'app',
	ENVIRONMENT: 'environment',
})
