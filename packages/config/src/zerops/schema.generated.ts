// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source: Zerops' published JSON schema for `zerops-import.yaml`
// https://api.app-prg1.zerops.io/api/rest/public/settings/import-project-yml-json-schema.json
//
// Regenerate with `bun packages/config/scripts/generate-zerops-types.ts`. This is a FAITHFUL
// transcription of the platform contract — it is deliberately NOT the app-authoring surface.
// What an app may actually declare is `./types.ts`, which subtracts the fields fabrika owns
// (see ADR-0004: `envIsolation` and project-level env are compiler-owned, never authorable).

/** Only one project can be defined. */
export interface ZeropsImportProject {
	/** The name of the new project. Duplicates are allowed. */
	name: string
	/** Description of the new project. */
	description?: string
	/**
	 * Project core package.
	 * Zerops default: `"LIGHT"`.
	 */
	corePackage?: 'LIGHT' | 'SERIOUS'
	/** One or more string tags. Tags do not have functional meaning, they only provide better orientation in projects. */
	tags?: string[]
	/** List of environment variables of project configuration. */
	envVariables?: Record<string, string>
	/**
	 * Defines the visibility scope for environment variables. Allowed values: none (no isolation, everyone sees all
	 * variables), service (isolation at service level, each service can only see its own variables). Explicit variable
	 * referencing is still possible regardless of the isolation setting.
	 */
	envIsolation?: string
	/**
	 * Defines who is authorized to access the service via SSH. Values can be combined using spaces (e.g., project vpn). To
	 * exclude a specific access type, use a negative prefix (e.g., -vpn). Allowed values: project (anyone from the project),
	 * vpn (anyone from the VPN), service (anyone from the same service), service@name (anyone from the service named "name").
	 */
	sshIsolation?: string
	/**
	 * When enabled, project domain includes both AAAA records and an A record pointing to Zerops shared IPv4 address. When
	 * disabled, the A record is not defined. If the project has its own dedicated IPv4 address, the domain always contains an
	 * A record with this assigned IPv4 address.
	 */
	sharedIpv4?: boolean
	/** Defines project's primary/fallback location'. */
	location?: 'eu-central' | 'us-east-1' | 'us-west-1'
}

export interface ZeropsImportService {
	/**
	 * The unique service identifier. Limitations: duplicates in the same project forbidden; maximum 25 characters, lowercase
	 * ASCII letters (a-z) or numbers (0-9) only.
	 */
	hostname: string
	/** Specifies the service type and version. */
	type: ZeropsServiceType
	/**
	 * Deprecated, use Type version only. Defines the operation mode of the service.
	 * @deprecated
	 */
	mode?: string
	/**
	 * List of key-value pairs. Environment variables that are blurred by default in Zerops GUI. Can be edited or deleted in
	 * Zerops GUI.
	 */
	envSecrets?: Record<string, string>
	/**
	 * List of key-value pairs in .env format. Environment variables that are blurred by default in Zerops GUI. Can be edited
	 * or deleted in Zerops GUI.
	 */
	dotEnvSecrets?: string
	/** Insert full nginx config. */
	nginxConfig?: string
	/** Object storage size in GB. */
	objectStorageSize?: number
	/** Select a predefined AWS S3 bucket access policy. */
	objectStoragePolicy?: 'custom' | 'private' | 'public-read' | 'public-objects-read' | 'public-write' | 'public-read-write'
	/**
	 * Define your own AWS S3 bucket access policy. See AWS docs for details. Use {{ .BucketName }} placeholder if you need to
	 * use bucket name in your custom policy rules.
	 */
	objectStorageRawPolicy?: string
	/** A URL of a Github or Gitlab repository used for a one-time build of your service. */
	buildFromGit?: string
	/** Set true, if you want to start service without code. */
	startWithoutCode?: boolean
	/**
	 * Set true, if you want to enable a public access to your service via a Zerops subdomain. Not suitable for production.
	 * Zerops default: `false`.
	 */
	enableSubdomainAccess?: boolean
	/**
	 * Services are sorted before creation by priority in descending order, i.e. the higher the priority the sooner the service
	 * is created.
	 */
	priority?: number
	/** Vertical autoscaling settings. */
	verticalAutoscaling?: ZeropsVerticalAutoscaling
	/** Minimum number of containers of the service. */
	minContainers?: number
	/** Maximum number of containers of the service. */
	maxContainers?: number
	/** Defines the autoscaling profile for the service. */
	profile?: string
	/** Json formatted list of overrides for the selected autoscaling profile. */
	profileOverrides?: unknown
	/** Mount shared storages to the service, buildFromGit must be filled. */
	mount?: string[]
	/** Set true, if you want to enable CDN for the object storage bucket. Currently only relevant for object storage services. */
	enableCdn?: boolean
	/**
	 * Defines the visibility scope for environment variables. Allowed values: none (no isolation, everyone sees all
	 * variables), service (isolation at service level, each service can only see its own variables). Explicit variable
	 * referencing is still possible regardless of the isolation setting. When set at the service level, these values override
	 * any project-level defined isolation settings.
	 */
	envIsolation?: string
	/**
	 * Defines who is authorized to access the service via SSH. Values can be combined using spaces (e.g., project vpn). To
	 * exclude a specific access type, use a negative prefix (e.g., -vpn). Allowed values: project (anyone from the project),
	 * vpn (anyone from the VPN), service (anyone from the same service), service@name (anyone from the service named "name").
	 * When set at the service level, these values override any project-level defined isolation settings.
	 */
	sshIsolation?: string
	/**
	 * Deprecated, use Type version only. Optionally specifies the OS of the runtime service imported with
	 * 'startWithoutCode=true'.
	 * @deprecated
	 */
	os?: string
	zeropsSetup?: string
	zeropsYaml?: ZeropsYaml
	/** Override existing service. */
	override?: boolean
}

/** Specifies the service type and version. */
export type ZeropsServiceType =
	| 'alpine/bun@1'
	| 'alpine/bun@1.2'
	| 'alpine/bun@1.2.2'
	| 'alpine/bun@1.3'
	| 'alpine/bun@1.3.9'
	| 'alpine/bun@canary'
	| 'alpine/bun@latest'
	| 'alpine/bun@nightly'
	| 'alpine/docker@26'
	| 'alpine/docker@26.1'
	| 'alpine/docker@26.1.5'
	| 'alpine/docker@latest'
	| 'alpine/dotnet@10'
	| 'alpine/dotnet@8'
	| 'alpine/dotnet@9'
	| 'alpine/dotnet@latest'
	| 'alpine/elixir@1'
	| 'alpine/elixir@1.16'
	| 'alpine/elixir@1.16.3'
	| 'alpine/elixir@latest'
	| 'alpine/gleam@1'
	| 'alpine/gleam@1.5'
	| 'alpine/gleam@1.5.1'
	| 'alpine/gleam@latest'
	| 'alpine/go@1'
	| 'alpine/go@1.22'
	| 'alpine/go@latest'
	| 'alpine/golang@1'
	| 'alpine/golang@1.22'
	| 'alpine/golang@latest'
	| 'alpine/java@17'
	| 'alpine/java@21'
	| 'alpine/java@latest'
	| 'alpine/nginx@1.22'
	| 'alpine/nginx@latest'
	| 'alpine/nodejs@20'
	| 'alpine/nodejs@22'
	| 'alpine/nodejs@24'
	| 'alpine/nodejs@latest'
	| 'alpine/php-apache@8.1'
	| 'alpine/php-apache@8.1+2.4'
	| 'alpine/php-apache@8.3'
	| 'alpine/php-apache@8.3+2.4'
	| 'alpine/php-apache@8.4'
	| 'alpine/php-apache@8.4+2.4'
	| 'alpine/php-apache@8.5'
	| 'alpine/php-apache@8.5+2.4'
	| 'alpine/php-apache@latest'
	| 'alpine/php-nginx@8.3'
	| 'alpine/php-nginx@8.3+1.22'
	| 'alpine/php-nginx@8.4'
	| 'alpine/php-nginx@8.4+1.22'
	| 'alpine/php-nginx@8.5'
	| 'alpine/php-nginx@8.5+1.28'
	| 'alpine/php-nginx@latest'
	| 'alpine/python@3.11'
	| 'alpine/python@3.12'
	| 'alpine/python@latest'
	| 'alpine/ruby@3.3'
	| 'alpine/ruby@3.4'
	| 'alpine/ruby@4.0'
	| 'alpine/ruby@latest'
	| 'alpine/rust@1'
	| 'alpine/rust@latest'
	| 'alpine/rust@nightly'
	| 'alpine/rust@stable'
	| 'alpine/static'
	| 'alpine/static@1.0'
	| 'alpine/static@latest'
	| 'alpine/zero@0.1'
	| 'alpine/zero@latest'
	| 'alpine/zero@nightly'
	| 'alpine@3.21'
	| 'alpine@3.22'
	| 'alpine@3.23'
	| 'alpine@3.24'
	| 'alpine@latest'
	| 'clickhouse:ha@25.3'
	| 'clickhouse:single@25.3'
	| 'elasticsearch:ha@8.16'
	| 'elasticsearch:ha@9.2'
	| 'elasticsearch:single@8.16'
	| 'elasticsearch:single@9.2'
	| 'kafka:ha@3.9'
	| 'kafka:single@3.9'
	| 'mariadb:ha@10.6'
	| 'mariadb:single@10.6'
	| 'meilisearch:single@1.10'
	| 'meilisearch:single@1.20'
	| 'meilisearch:single@1.44'
	| 'nats:ha@2.10'
	| 'nats:ha@2.12'
	| 'nats:single@2.10'
	| 'nats:single@2.12'
	| 'object-storage'
	| 'objectstorage'
	| 'postgresql:ha@14'
	| 'postgresql:ha@16'
	| 'postgresql:ha@17'
	| 'postgresql:ha@18'
	| 'postgresql:single@14'
	| 'postgresql:single@16'
	| 'postgresql:single@17'
	| 'postgresql:single@18'
	| 'qdrant:ha@1.10'
	| 'qdrant:ha@1.12'
	| 'qdrant:single@1.10'
	| 'qdrant:single@1.12'
	| 'seaweedfs:ha@3'
	| 'seaweedfs:single@3'
	| 'shared-storage:ha'
	| 'shared-storage:single'
	| 'sharedstorage:ha'
	| 'sharedstorage:single'
	| 'static'
	| 'typesense:ha@27.1'
	| 'typesense:ha@30.2'
	| 'typesense:single@27.1'
	| 'typesense:single@30.2'
	| 'ubuntu/bun@1'
	| 'ubuntu/bun@1.1'
	| 'ubuntu/bun@1.1.34'
	| 'ubuntu/bun@1.2'
	| 'ubuntu/bun@1.2.2'
	| 'ubuntu/bun@1.3'
	| 'ubuntu/bun@1.3.9'
	| 'ubuntu/bun@canary'
	| 'ubuntu/bun@latest'
	| 'ubuntu/bun@nightly'
	| 'ubuntu/deno@2'
	| 'ubuntu/deno@2.0'
	| 'ubuntu/deno@2.0.0'
	| 'ubuntu/deno@latest'
	| 'ubuntu/dotnet@10'
	| 'ubuntu/dotnet@8'
	| 'ubuntu/dotnet@9'
	| 'ubuntu/dotnet@latest'
	| 'ubuntu/elixir@1'
	| 'ubuntu/elixir@1.16'
	| 'ubuntu/elixir@1.16.2'
	| 'ubuntu/elixir@latest'
	| 'ubuntu/gleam@1'
	| 'ubuntu/gleam@1.5'
	| 'ubuntu/gleam@1.5.1'
	| 'ubuntu/gleam@latest'
	| 'ubuntu/go@1'
	| 'ubuntu/go@1.22'
	| 'ubuntu/go@latest'
	| 'ubuntu/golang@1'
	| 'ubuntu/golang@1.22'
	| 'ubuntu/golang@latest'
	| 'ubuntu/java@17'
	| 'ubuntu/java@21'
	| 'ubuntu/java@latest'
	| 'ubuntu/nginx@1.22'
	| 'ubuntu/nginx@latest'
	| 'ubuntu/nodejs@20'
	| 'ubuntu/nodejs@22'
	| 'ubuntu/nodejs@24'
	| 'ubuntu/nodejs@latest'
	| 'ubuntu/php-apache@8.1'
	| 'ubuntu/php-apache@8.1+2.4'
	| 'ubuntu/php-apache@8.3'
	| 'ubuntu/php-apache@8.3+2.4'
	| 'ubuntu/php-apache@8.4'
	| 'ubuntu/php-apache@8.4+2.4'
	| 'ubuntu/php-apache@8.5'
	| 'ubuntu/php-apache@8.5+2.4'
	| 'ubuntu/php-apache@latest'
	| 'ubuntu/php-nginx@8.3'
	| 'ubuntu/php-nginx@8.3+1.22'
	| 'ubuntu/php-nginx@8.4'
	| 'ubuntu/php-nginx@8.4+1.22'
	| 'ubuntu/php-nginx@8.5'
	| 'ubuntu/php-nginx@8.5+1.28'
	| 'ubuntu/php-nginx@latest'
	| 'ubuntu/python@3.11'
	| 'ubuntu/python@3.12'
	| 'ubuntu/python@3.14'
	| 'ubuntu/python@latest'
	| 'ubuntu/ruby@3.3'
	| 'ubuntu/ruby@3.4'
	| 'ubuntu/ruby@4.0'
	| 'ubuntu/ruby@latest'
	| 'ubuntu/rust@1'
	| 'ubuntu/rust@latest'
	| 'ubuntu/rust@nightly'
	| 'ubuntu/rust@stable'
	| 'ubuntu/static'
	| 'ubuntu/static@1.0'
	| 'ubuntu/static@latest'
	| 'ubuntu/zero@0.1'
	| 'ubuntu/zero@latest'
	| 'ubuntu/zero@nightly'
	| 'ubuntu@22.04'
	| 'ubuntu@24.04'
	| 'ubuntu@26.04'
	| 'ubuntu@latest'
	| 'valkey:ha@7.2'
	| 'valkey:single@7.2'
	| 'zcp@1'
	| 'zcp@latest'

/** Vertical autoscaling settings. */
export interface ZeropsVerticalAutoscaling {
	/** Fixed CPU thread count that each container of the service will be set to. */
	cpu?: number
	/** Fixed RAM in GB that each container of the service will be set to. */
	ram?: number
	/** Fixed disk space in GB that each container of the service will be set to. */
	disk?: number
	/** CPU mode that each container of the service will be set to. */
	cpuMode?: 'DEDICATED' | 'SHARED'
	/** Minimum CPU thread count that each container of the service can scale down to. */
	minCpu?: number
	/** Maximum CPU thread count that each container of the service can scale up to. */
	maxCpu?: number
	/** Minimum RAM in GB that each container of the service can scale down to. */
	minRam?: number
	/** Maximum RAM in GB that each container of the service can scale up to. */
	maxRam?: number
	/** Minimum disk space in GB that each container of the service can scale down to. */
	minDisk?: number
	/** Maximum disk space in GB that each container of the service can scale up to. */
	maxDisk?: number
	/** Number of CPU cores with which each container starts. */
	startCpuCoreCount?: number
	/** Whether to enable swap memory for containers. Swap is enabled by default. Refer to documentation for more details. */
	swapEnabled?: boolean
	/** Minimum number of unused CPU cores before a container starts scaling. */
	minFreeCpuCores?: number
	/** Minimum percentage of unused CPU cores before a container starts scaling. */
	minFreeCpuPercent?: number
	/** Minimum unused memory in GB before a container starts scaling. */
	minFreeRamGB?: number
	/** Minimum percentage of unused memory before a container starts scaling. */
	minFreeRamPercent?: number
	/** @deprecated */
	minVCpu?: number
	/** @deprecated */
	maxVCpu?: number
}

export interface ZeropsYaml {
	/** The top-level element is always zerops. */
	zerops: ZeropsYamlSetup[]
}

export interface ZeropsYamlSetup {
	/**
	 * The first element setup contains the hostname of your service. A runtime service with the same hostname must exist in
	 * Zerops. Zerops supports the definition of multiple runtime services in a single zerops.yml. This is useful when you use
	 * a monorepo. Just add multiple setup elements in your zerops.yml.
	 */
	setup: string
	/** Build pipeline configuration. */
	build?: ZeropsYamlBuild
	/** Deploy configuration. */
	deploy?: ZeropsYamlDeploy
	/** Runtime configuration. */
	run?: ZeropsYamlRun
}

/** Build pipeline configuration. */
export interface ZeropsYamlBuild {
	/** Deprecated - use base attribute. Sets the operating system for the build environment. */
	os?: string
	/** Sets the base technology for the build environment. */
	base?: string[]
	/** Customises the build environment by installing additional dependencies or tools to the base build environment. */
	prepareCommands?: string[]
	/** Defines build commands. Zerops triggers each command in the defined order in a dedicated build container. */
	buildCommands?: string[]
	deploy?: string[]
	/**
	 * Selects which files or folders will be deployed after the build has successfully finished. To filter out specific files
	 * or folders, use .deployignore file.
	 */
	deployFiles: string[]
	/** Defines which files or folders will be cached for the next build. */
	cache?: unknown
	/**
	 * Defines what files or folders will be copied from the build container to the prepare runtime container. The prepare
	 * runtime container is used to customize your runtime environment.
	 */
	addToRunPrepare?: string[]
	/** Defines the environment variables for the build environment. */
	envVariables?: Record<string, string>
}

/** Deploy configuration. */
export interface ZeropsYamlDeploy {
	/** Defines a readiness check. Requires either httpGet object or exec object. */
	readinessCheck?: ZeropsReadinessCheck
	temporaryShutdown?: boolean
}

/** Defines a readiness check. Requires either httpGet object or exec object. */
export interface ZeropsReadinessCheck {
	/** Configures the readiness check to request a local URL using a http GET method. */
	httpGet?: ZeropsHttpGetProbe
	/** Configures the readiness check to run a local command. */
	exec?: ZeropsExecProbe
	/** Time until container is marked as failed. */
	failureTimeout?: number
	/** Time interval between readiness check attempts. */
	retryPeriod?: number
}

/** Configures the readiness check to request a local URL using a http GET method. */
export interface ZeropsHttpGetProbe {
	/**
	 * The readiness check is triggered from inside of your runtime container so no https is required. If your application
	 * requires a https request, set scheme: https
	 */
	scheme?: string
	/**
	 * The readiness check is triggered from inside of your runtime container so it always uses the localhost (127.0.0.1). If
	 * you need to add a host to the request header, specify it in the host attribute.
	 */
	host?: string
	/** Defines the port of the HTTP GET request. */
	port: number
	/** Defines the URL path of the HTTP GET request. */
	path: string
}

/** Configures the readiness check to run a local command. */
export interface ZeropsExecProbe {
	/**
	 * Defines a local command to be run. The command has access to the same environment variables. A single string is
	 * required. If you need to run multiple commands create a shell script or, use a multiline format as in the example below.
	 */
	command: string
}

/** Runtime configuration. */
export interface ZeropsYamlRun {
	/** Defines one or more commands to be run each time a new runtime container is started or a container is restarted. */
	initCommands?: string[]
	/** Customises the runtime environment by installing additional dependencies or tools to the base runtime environment. */
	prepareCommands?: string[]
	/** Deprecated - use base attribute. Sets the operating system for the runtime environment. */
	os?: string
	/**
	 * Sets the base technology for the runtime environment. If you don't specify the run.base attribute, Zerops keeps the
	 * current version for your runtime.
	 */
	base?: string
	/** Defines the start command for your application. */
	start?: string
	/**
	 * Customizes the folder that will be used as the root of the publicly accessible web server content. This attribute is
	 * available only for runtimes with webservers.
	 */
	documentRoot?: string
	/** Sets the custom webserver configuration. This attribute is available only for runtimes with webservers. */
	siteConfigPath?: string
	envReplace?: ZeropsEnvReplace
	/** Defines a health check. */
	healthCheck?: ZeropsHealthCheck
	routing?: ZeropsRouting
	/** Specifies one or more internal ports on which your application will listen. */
	ports?: ZeropsPort[]
	/** Defines the environment variables for the runtime environment. */
	envVariables?: Record<string, string>
	/** Defines the start commands for the runtime environment. */
	startCommands?: ZeropsStartCommand[]
	/**
	 * A list of cron jobs with their respective schedule (timing), the command to run (command), and additional options like
	 * allContainers and workingDir.
	 */
	crontab?: ZeropsCrontabEntry[]
}

export interface ZeropsEnvReplace {
	target: string[]
	delimiter: string[]
}

/** Defines a health check. */
export interface ZeropsHealthCheck {
	/** Configures the health check to request a local URL using a http GET method. */
	httpGet?: ZeropsHttpGetProbe
	/** Configures the health check to run a local command. */
	exec?: ZeropsExecProbe
	/** Time until container fails after consecutive health check failures (reset by success). */
	failureTimeout?: number
	/** Time until container is disconnected and becomes publicly unavailable. */
	disconnectTimeout?: number
	/** Time until container is connected and becomes publicly available. */
	recoveryTimeout?: number
	/** Time interval between health check attempts. */
	execPeriod?: number
}

export interface ZeropsRouting {
	root?: string
	/**
	 * Content of default Access-Control headers (Allow-Origin, Allow-Methods, Allow-Headers and Expose-Headers), e.g. "'*'
	 * always"
	 */
	cors?: string
	redirects?: ZeropsRoutingRedirect[]
	headers?: ZeropsRoutingHeader[]
}

export interface ZeropsRoutingRedirect {
	/**
	 * Relative or an absolute (defined by with http://) path to be matched against request location. May contain * at the end
	 * for regex.
	 */
	from: string
	/** Relative or an absolute (defined by with http://) path to redirect user to. */
	to: string
	/**
	 * Which HTTP status code to use for the redirect. If not set, and To and From are relative, an internal/masked redirect
	 * will be used.
	 */
	status?: number
	/**
	 * Whether part of the path after From should be preserved. Used to forward contents of one directory to another in
	 * non-masked redirects.
	 */
	preservePath?: boolean
	/** Whether query parameters should be preserved. Used in non-masked redirects. */
	preserveQuery?: boolean
}

export interface ZeropsRoutingHeader {
	/** Relative path to be matched against request location. May contain * at the end for prefix-based match. */
	for: string
	/** Header name as Key and raw content as Value, e.g. "Access-Control-Allow-Origin": "'*' always" */
	values: Record<string, string>
}

export interface ZeropsPort {
	/** Defines the protocol. Allowed values are TCP or UDP. Default value is TCP. */
	protocol?: string
	/**
	 * Defines the port number. You can set any port number between 10 and 65435. Ports outside this interval are reserved for
	 * internal Zerops systems.
	 */
	port: number
	description?: string
	/**
	 * Set to true if a web server is running on the port. Zerops uses this information for the configuration of public access.
	 * True is available only in combination with the TCP protocol. Default value is false.
	 */
	httpSupport?: boolean
}

export interface ZeropsStartCommand {
	name?: string
	command: string
	workingDir?: string
	/** Defines one or more commands to be run each time a new runtime container is started or a container is restarted. */
	initCommands?: string[]
}

export interface ZeropsCrontabEntry {
	/** Defines when the cron job runs in standard cron format. */
	timing: string
	/** Specifies the shell command to run at the scheduled time. */
	command: string
	/** The directory where the command will be executed (default: /var/www) */
	workingDir?: string
	/** If set to true, the job runs on all containers; otherwise, it runs on a single container (default: false) */
	allContainers: boolean
}
