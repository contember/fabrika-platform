// The names of one application environment's own AWS resources, each derived from its application id and environment
// alone, never registered (the deploy, the run attempt and the environment stack read them here), so no registration
// can aim Control's signed calls at another environment's resources.

/** How many images an environment's repository keeps. */
export const AWS_KEPT_IMAGES = 20
/**
 * An application id or environment name the derived names take: no `_`, `/` or `.`, which the names join them with,
 * so no two environments derive one name, and no `-` at either end, so the discovery name it ends is a DNS label.
 */
const NAME_PART = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** An IAM role's name holds at most 64 characters. */
const MAX_ROLE_NAME = 64

/** One application environment's own AWS resources, each named from its application id and environment alone. */
export interface AwsEnvironmentResources {
	readonly service: string
	readonly repository: string
	readonly parameterPath: string
	readonly logGroup: string
	readonly taskRoleArn: string
	readonly executionRoleArn: string
	/** The environment's own CodeBuild project, its role and its log group: no build reaches another environment's. */
	readonly buildProject: string
	readonly buildRoleArn: string
	readonly buildLogGroup: string
	/** The CloudFormation stack that holds the environment's resources (`awsEnvironmentStack`). */
	readonly stackName: string
	/**
	 * The name the service is published under in its namespace's Service Connect namespace, and the host its proxy
	 * reaches it at: `e<length of app>-<app>-<env>`, a DNS label (the service's own name holds `_`, which none does).
	 */
	readonly discoveryName: string
}

/**
 * The names of an environment's resources, under the prefixes the installation's policy for Control's role is scoped
 * to (`fabrika/apps/`): an ECS service `<app>_<env>`, a repository `fabrika/apps/<app>/<env>`, the parameter path and
 * log group `/fabrika/apps/<app>/<env>` (the build's log group below it, `…/build`), the roles
 * `fabrika/apps/<app>_<env>_task`, `…_execution` and `…_build` (ADR-0004's AWS invariant: two roles, never one; the
 * build's a third), the build project `fabrika_<app>_<env>` and the stack `fabrika-app-<length of app>-<app>-<env>`,
 * whose length keeps a hyphen in the id apart from the one that joins it. An id or name outside `NAME_PART`, or a role
 * name past IAM's 64, is refused.
 */
export function awsEnvironmentResources(appId: string, env: string, accountId: string): AwsEnvironmentResources {
	const role = checkedRoleName(appId, env)
	return {
		service: role,
		repository: `fabrika/apps/${appId}/${env}`,
		parameterPath: `/fabrika/apps/${appId}/${env}`,
		logGroup: `/fabrika/apps/${appId}/${env}`,
		taskRoleArn: `arn:aws:iam::${accountId}:role/fabrika/apps/${role}_task`,
		executionRoleArn: `arn:aws:iam::${accountId}:role/fabrika/apps/${role}_execution`,
		buildProject: `fabrika_${role}`,
		buildRoleArn: `arn:aws:iam::${accountId}:role/fabrika/apps/${role}_build`,
		buildLogGroup: `/fabrika/apps/${appId}/${env}/build`,
		stackName: `fabrika-app-${appId.length}-${appId}-${env}`,
		discoveryName: awsDiscoveryName(appId, env),
	}
}

/** `<app>_<env>`, once both are names this provider takes and every role name built on it fits IAM's bound. */
function checkedRoleName(appId: string, env: string): string {
	if (!NAME_PART.test(appId) || !NAME_PART.test(env)) {
		throw new Error('aws: the application id or environment name is not one this provider names resources by')
	}
	const role = `${appId}_${env}`
	if (`${role}_execution`.length > MAX_ROLE_NAME) throw new Error('aws: the application id and environment name are too long for an IAM role name')
	return role
}

/**
 * The service's name in its namespace's Service Connect namespace, `e<length of app>-<app>-<env>`, which no account
 * changes. The role name's bound keeps it within a DNS label's 63 characters.
 */
export function awsDiscoveryName(appId: string, env: string): string {
	checkedRoleName(appId, env)
	return `e${appId.length}-${appId}-${env}`
}
