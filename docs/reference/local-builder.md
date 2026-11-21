# Local builder and an installed platform

The builder keeps application design, coding agents, source code and preview processes on the developer's machine. The installed platform owns application registration, environment placement, credentials and deployment execution. The connected workflow targets Zerops and the `zerops-app` preset.

## Prerequisites

An administrator prepares the installation, a ready application namespace, GitHub source access and the application's domain. The source repository must already exist. The builder does not create namespaces, configure a GitHub App, create repositories, or bind custom domains.

The approving person needs IAM-resolved Control permissions for the application: `app.manage`, `deploy.trigger` and `deploy.read`. Creating an application, and later changing its repository or its GitHub source binding, requires global `app.manage`; the builder key, scoped to the application, can do neither. Selecting a new placement through namespace discovery requires `namespace.manage`; the local builder never receives it. A Control-only bootstrap override does not supply delegable IAM permissions.

## Connect a project

```bash
fabrika builder init --url=https://control.example.com
```

For a new project, connected initialization selects `zerops-app`. Plain initialization retains its existing default. An existing compatible builder project can connect with:

```bash
fabrika builder connect --url=https://control.example.com
fabrika builder status --json
```

The CLI opens the installed console. The person creates or selects the application and reviews its initial environment placement. The console saves a non-secret connection receipt, then approves an app-scoped machine credential. A receipt records the selected coordinates; it does not reserve a domain or provider resource.

The daemon polls IAM and retrieves the key directly. The browser never receives the key. The key permits application management, including deletion and all environments, plus deployment and run inspection for that application. It expires after thirty days and can be revoked in the console's builder connections view.

`--no-open` leaves browser navigation to the user through the local dashboard; CLI output does not print the approval proof. Repeated initialization preserves existing artifacts and connection settings. A malformed existing configuration is refused rather than replaced.

## Develop and deploy

Continue the builder's normal reviewed phase loop. Task packets include the connected application and placement so the local agent can generate matching provider configuration.

Set the application's actual local preview address:

```bash
fabrika builder preview --url=http://localhost:4300
```

This address is distinct from the installed application's public origin. The command records the URL; it does not start the development server.

Before deployment, commit and push the intended application revision using the user's normal Git workflow. The builder does not create commits or push. Deployment requires a clean repository-root configuration and descriptor. HEAD must be on an attached branch and equal its remote tip; detached HEAD and older commits behind the remote tip are refused.

```bash
fabrika builder deploy --wait --timeout=600 --json
```

The daemon compiles the configuration in a separate process without platform credentials, updates the selected environment through Control, and triggers the immutable commit SHA. First environment creation uses the connection receipt's placement. Later updates read and preserve the current registry's domain, public origin, namespace and trigger settings.

A failed update does not trigger deployment. A saved run can be inspected after daemon restart. A successful run reports the configured application URL; that result does not establish independent HTTP reachability. The existing Control executor reads current registration when it starts a run, so this flow does not snapshot the manifest against concurrent registry edits.

## Credential custody and recovery

- `.fabrika/config.json` stores only non-secret connection and preview metadata.
- The daemon stores credentials separately under `~/.fabrika-builder/credentials`, outside registered projects, with private file permissions. It pins the approved origins independently of mutable project configuration.
- Browser, coding-agent and compiler inputs do not contain the machine key. This is process-state isolation, not a sandbox against arbitrary code running as the same operating-system user.
- Authorization attempts expire after ten minutes. Approval and redemption use independent proofs.
- IAM stores only credential hashes. If the exchange succeeds but its response or local persistence is lost, the key cannot be retrieved again. Revoke the issued credential in the console and start a new connection.

```bash
fabrika builder disconnect
```

Disconnect removes local custody. **It does not revoke server access.** Use the console to revoke the authorization. Revocation prevents fresh credential minting; already issued access tokens remain usable until their normal expiry.

Disconnect is refused while deployment preparation or a remote run remains active. Observation failures retain the run and block another deployment rather than treating a network failure as a failed deploy.

Two recovery cases require special care:

- If a credential expires or is revoked while a saved run is active, the daemon retains that run but cannot observe it. Reconnection for an active run is not supported. The local target stays blocked, including after restart; inspect the actual run in the platform console.
- If Control accepts a submission but its response is lost before the daemon saves the run ID, the daemon preserves the target reservation. There is no automatic reset or retrigger. Console inspection does not itself release that local reservation.

## Protocol ownership

IAM owns device authorization at `/auth/device/*` and its private human-management methods. Control exposes protected pairing and receipt procedures through `/api/rpc`. The exact public discovery path is `/.well-known/fabrika-builder`. The self-contained `/builder/connect` page captures the approval fragment into tab-local storage and removes it before navigating to the protected console page.

The CLI and local UI call the daemon's `/api/project/:id/*` interface. They do not import daemon implementation or call Control with a browser-held machine credential. Local HTTP and WebSocket admission validates the authority and browser origin before dispatch. The routes only the CLI calls (pushing a canvas, which binds a session to a project root, consuming feedback and gates, resetting a session, posting build events, and the wait WebSocket) also require the daemon's CLI capability: a random value the daemon writes on start to `daemon-auth-token` beside its pid file (`0600` in a `0700` directory), which the CLI sends in `X-Builder-CLI-Token` (the wait WebSocket in its `cli_token` query parameter). Another local process or OS user reaches the loopback port without browser headers, so admission by authority and origin alone does not tell it from the CLI.

Every other route and WebSocket but `/health`, `/assets/*` and the link route `/open` requires the dashboard's credential or the CLI capability: the dashboard page, `/`, the session list, phase state, session metadata, artifacts, canvases, skeletons, revision feedback and draft answers (read and write), the build stream, every `/api/project/:id/*` route and the `/ws/session/:id` WebSocket. The CLI sends its capability on the reads it makes too. The dashboard's credential is a secret in the daemon's data directory (`ui-token`, mode `0600`; the daemon sets the directory to `0700` on start), held by the browser as an `HttpOnly; SameSite=Strict` cookie named after the port, `fabrika-builder-ui-<port>`. A browser gets it only through a link the CLI asks the daemon for: `init` prints it as `browserUrl` and opens it unless `--no-open`, `gate open` does so for a session the push creates, and `fabrika builder dashboard [--no-open]` prints a fresh one. A push answers with the link in `signInUrl` and keeps `browserUrl` the plain page URL, because a CLI of an earlier release hands `browserUrl` to the opener as a process argument. The link carries a one-time code, valid for an hour, which `/open` trades for the cookie before it continues to the session's page. The CLI never passes the link to the browser opener as a process argument, which every OS user can read: it writes the link into a `0600` file in its `0700` temporary directory and opens that file. A browser without the cookie gets a page that names `fabrika builder dashboard`; an open dashboard reloads to that page when the daemon refuses it. The secret survives a daemon restart, so open tabs keep working; deleting `ui-token` signs every browser out. Two risks remain. Browsers send one host's cookies to every port of it, so a server on another `127.0.0.1` port that the same browser visits receives the cookie. And while the daemon is down (after a reboot, a stop, or during a restart), an open dashboard tab and a browser that restores its session keep sending the cookie to whatever listens on the daemon's port; another OS user who binds that port meanwhile receives it, and the secret still works against the next daemon until `ui-token` is deleted. The daemon forwards no request to another local server.

See [ADR-0042](../decisions/0042-connect-local-builders-through-human-consent.md) for the ownership decision and [`@fabrika/builder`](../../packages/builder/README.md) for the phase loop.
