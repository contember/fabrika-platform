// The paths a dev workspace sandbox's base image and its deploy agree on. The base image's scripts
// (`packages/provider-zerops/sandbox/`) spell the same paths; a change here changes them there too.

/** The application root inside a sandbox: what a deploy extracts the source into and the launcher runs from. */
export const SANDBOX_APP_ROOT = '/app'

/** State that survives a re-bootstrap, which replaces only the application root. */
export const SANDBOX_STATE_DIR = '/var/lib/fabrika'

/** The launcher's environment, written 0600 through the file API: the one way a credential reaches a sandbox process. */
export const SANDBOX_ENV_FILE = `${SANDBOX_STATE_DIR}/env`

/** The generated build script; it holds no credential, and the build reads none. */
export const SANDBOX_BUILD_SCRIPT = `${SANDBOX_STATE_DIR}/build.sh`

/** Where the source archive lands before it is extracted. */
export const SANDBOX_SOURCE_ARCHIVE = '/tmp/fabrika-source.tar.gz'

/** The base image's PID 1: PostgreSQL, then the launcher when a deploy left one. Every other script is uploaded. */
export const SANDBOX_INIT_COMMAND: readonly string[] = ['/bin/sh', '/usr/local/lib/fabrika/init.sh']

/** Where each deploy uploads the helper scripts, one directory per version; `current` names the one in use. */
export const SANDBOX_BIN_DIR = `${SANDBOX_STATE_DIR}/bin`
export const SANDBOX_BIN_POINTER = `${SANDBOX_BIN_DIR}/current`

/** The launcher's output, which only root reads. */
export const SANDBOX_LAUNCHER_LOG = `${SANDBOX_STATE_DIR}/launcher.log`

/**
 * The database the launcher provisions with: the sandbox's local superuser. The deploy writes it without a password;
 * `run-launcher.sh` adds the password, which stays in the sandbox in a file only root reads.
 */
export const SANDBOX_DATABASE_URL = 'postgres://postgres@127.0.0.1:5432/postgres'

/** The connections each process opens: one launcher, one application and a migration share a local PostgreSQL of 100. */
export const SANDBOX_DATABASE_CONNECTIONS = 10

/** The size of one workspace sandbox. */
export const SANDBOX_CPUS = 2
export const SANDBOX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024
