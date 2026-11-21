# Agent Canvas

Interactive browser-based visual canvas for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Create rich, annotatable JSX documents that render in the browser — with revision history, inline annotations, and structured feedback that flows back to Claude.

![License](https://img.shields.io/npm/l/agent-canvas)
![npm](https://img.shields.io/npm/v/agent-canvas)

![Agent Canvas](docs/light.png)

## What it does

When Claude needs to present a plan, review, explanation, or decision — instead of dumping markdown in the terminal — it renders a full interactive canvas in your browser. You can:

- **Annotate** any element with inline comments
- **Choose options**, fill inputs, rate with sliders
- **Browse files** referenced in the canvas
- **Review revisions** as Claude iterates
- **Send structured feedback** back to Claude in one click
- **Hand off secrets locally** without placing values in model context or feedback

## Install

```bash
# Register the skill and hooks in Claude Code
bunx agent-canvas install global    # for all projects
bunx agent-canvas install local     # for current project only
```

This installs:

- The `/canvas` skill so Claude knows how to use it
- A `SessionStart` hook that sets up session IDs automatically

**Requires [Bun](https://bun.sh/) runtime.**

## Usage in Claude Code

Once installed, use the `/canvas` command to create a canvas:

```
> /canvas Plan the authentication refactor
> /canvas Show me an architecture overview
> /canvas Review this PR
```

Claude creates a JSX document, pushes it to a local daemon, and opens it in your browser at `http://localhost:19400/s/<session-id>`. The
first push opens a link that signs the browser in to the daemon; another browser, or one that lost its cookie, gets a fresh
link from `bunx agent-canvas open --session <session-id>`.

### Flow patterns

Claude uses different canvas flows depending on the task:

| Flow         | When                                                | Rounds                                                     |
| ------------ | --------------------------------------------------- | ---------------------------------------------------------- |
| **Feature**  | Vague requests ("add auth")                         | Discovery → Requirements → Plan → Implementation → Summary |
| **Plan**     | Clear requirements                                  | Plan → Implementation → Summary                            |
| **Explain**  | "How does X work?"                                  | Single canvas                                              |
| **Review**   | Code/architecture review                            | Findings → Fix Plan → Summary                              |
| **Decision** | Choosing between options                            | Single canvas with comparison                              |
| **Runbook**  | User must complete manual setup or provide a secret | Instructions → secure handoff → command → result           |

### Files from the user

`<FileDrop id label accept maxBytes required>` lets the user hand the agent a file from the canvas. The daemon stores it with the session (`sessions/<id>/assets/<field>/`, mode 0600), caps a file at 25 MB and a session at 100 files and 250 MB, and keeps the files until the session directory is removed; nothing deletes them automatically. A field's files stay listed on later revisions. The feedback lists their absolute paths; the agent reads them with its own tools. No route serves them back, so an upload is never rendered as a page or run as a script.

### Threads and following a session

Submitted feedback labels each of the user's own annotations with its id; a remote reviewer's has none and opens no
thread. The agent can answer one annotation with `bunx agent-canvas reply <annotation-id> "<text>" [--resolve]`; the
reply appears under the annotation in the sidebar, where the user can answer back. The thread stays visible on later
revisions and is kept until the session directory is removed; nothing deletes it automatically. The user's answer
reaches the agent through `watch` and `fetch` like a submit. Answering a thread whose reply the agent has not read yet
is refused until `watch` hands that reply over.

`bunx agent-canvas watch --follow` keeps watching instead of exiting after the first answer. It prints one block per
submit, thread reply, render error and remote-feedback arrival, for hosts that turn each output line into an event
(Claude Code's Monitor). For remote feedback it prints only the count and the reviewers' self-typed names; their text
reaches the agent when the user includes it in a submit. A remote-feedback arrival is a best-effort notice: one that
comes while the watcher is reconnecting is not repeated.

### Local secret handoff

Runbooks can use `SecretInput` when a command needs a token that must stay out of feedback and model context. The browser stores the value only in the local daemon's memory. Feedback contains the field ID and environment variable name, not the value.

The agent then runs the target command through the local wrapper:

```bash
bunx agent-canvas exec \
  --session <session-id> \
  --secret SERVICE_TOKEN=service-token \
  -- service-cli deploy
```

Secret resolution requires a daemon capability available to the CLI but not to canvas JavaScript. A new canvas revision, daemon shutdown, or session cleanup clears the value. The target command must not print its environment or credentials.

The daemon answers only requests addressed to `localhost`, `127.0.0.1` or `[::1]` on its port. It refuses state-changing requests and WebSocket upgrades from any origin other than its own UI, requires the CLI capability on the routes only the CLI calls (push, feedback, secret resolution, thread replies and claims, review agent routes), and never serves its own runtime or data directory through the file routes. Every other route but `/health`, `/assets/*`, the link route `/open` and the review widget's CORS preflights requires the UI credential or the CLI capability, so a process that reaches the port without either reads no file, session, feedback, review thread or secret status through the daemon. The UI credential is a secret each daemon start makes afresh and holds in memory only, held by the browser as an `HttpOnly; SameSite=Strict` cookie named after the port. A browser gets it only through a link the CLI prints (`push`, `open`, `review open`, `review snippet`): the link carries a one-time code, valid for an hour, which `/open` trades for the cookie before it continues to the page the code names. The CLI never passes such a link as a process argument, which every OS user can read: it writes the link into a file only its owner reads, in its runtime directory, and opens that file. A daemon restart (`daemon restart`, a version change, the restart after a failed compile) signs every browser out: an open tab reloads to the page that names `agent-canvas open`, which prints a fresh link. So a cookie a browser keeps sending to the daemon's port while the daemon is down (after a reboot, a stop, or during a restart), which another OS user who binds that port meanwhile receives, opens nothing against the next daemon. A fresh secret per start was chosen over serving the UI on a dedicated `*.localhost` host: cookies ignore the port, so a host of its own would still send a secret that survives restarts to whoever binds the daemon's port, and the review widget, which runs on the application's `localhost` origin, would no longer get the `SameSite=Strict` cookie from another site. Two risks remain. Browsers send cookies to every port of `localhost`, so an application served on another `localhost` port receives the cookie and can replay it; the review proxy strips it before it forwards a request to the application under review, but an application opened directly is trusted with it, and any page on a `localhost` port in the same browser can read review threads and queue review requests with it. And an older release left the data directory as the default umask made it, readable by other OS users, until a daemon of this release starts and closes it. The file routes serve a session's project root and, outside it, only the files its canvases name in `FilePreview path`, `Markdown file`, `ImageView src` or `Download path`, symlinks resolved; they list no directory outside it. `/api/download`, behind `<Download path>`, serves only a named file, inside the root too, as an `application/octet-stream` attachment. The canvas author controls that list, so it stops reads of paths no canvas names, not a hostile canvas. The canvas page carries a Content-Security-Policy that lets canvas JavaScript connect only to the daemon. Images, fonts, stylesheets and media may come from any https origin, and such a URL, like a navigation, can still carry data out. Every other daemon response carries an inert policy, so a frame or window of it cannot be scripted past the page's. The daemon and the CLI keep their runtime files (pid file, CLI capability, logs, link files, compile scratch, uploads) in the user's runtime directory, `$XDG_RUNTIME_DIR/agent-canvas`, else `agent-canvas-<uid>` in the system temp directory, made `0700`; a symlink, a file or another user's directory in its place is refused rather than followed. Where `XDG_RUNTIME_DIR` is unset and the temp directory is shared, another OS user can still create `agent-canvas-<uid>` first and keep the daemon from starting; the CLI then names the directory, and setting `XDG_RUNTIME_DIR` to a private directory gets around it. A CLI run with another `XDG_RUNTIME_DIR` than the running daemon finds no capability; `agent-canvas daemon restart` from it starts one it can use. `push` keeps a directory under the old `<tmpdir>/agent-canvas`, where skills installed by earlier releases keep canvases, private as the daemon did, and refuses one that is a symlink or another user's. `agent-canvas dir` prints the directory; the skill keeps canvas files under it.

### Review mode

Review mode puts the same comment loop on a running web application: a prototype, a mock or any dev server. Open the
application through the daemon's review proxy:

```bash
bunx agent-canvas review open http://localhost:5173/ --project my-app
```

The daemon serves the application on a port of its own with the widget added to every HTML page (hot reload passes
through) and opens it in the browser. To keep the application's own address, add the widget's tag to its page in
development instead: `bunx agent-canvas review snippet --project my-app`.

The widget mounts a toolbar in its own shadow root. The reviewer clicks **Comment**, picks an element or selects text,
and saves the comment as a note or sends it to the agent. The agent waits with `bunx agent-canvas review watch` (`--follow` keeps waiting),
receives each thread with its page URL, the element's role and accessible name, a CSS path, the React components that
own it with their source positions (resolved through the dev server's source maps), the trimmed markup and, when the
reviewer attaches one, a screenshot of the tab, changes the code and answers with `bunx agent-canvas review reply <thread> "<text>" --resolve`. The answer and
the thread's state show up next to the element.

Threads are stored per project under the daemon's data directory. The daemon accepts widget requests only from loopback
origins (`localhost`, `127.0.0.1`, `*.localhost`) and agent requests only from clients that send no `Origin`, so a web
page cannot queue work for the agent. The widget's routes also require the UI cookie: the widget sends its requests with
credentials, and the daemon answers the exact requesting origin. The cookie is `SameSite=Strict`, so the browser attaches
it only from an application on `localhost`, as the proxy serves it; with the snippet, open the application at
`http://localhost:<port>`, not `127.0.0.1`, and open the link `review snippet` prints once in that browser. The agent
routes that act on threads require the CLI capability.
The review proxy answers only requests addressed to `localhost`, `127.0.0.1` or
`[::1]` on its own port, and refuses state-changing requests and WebSocket upgrades from any origin other than its own,
so a web page cannot drive the application through it.

#### Remote review

The same loop works on a deployed application. `bunx agent-canvas review share https://prototype.example.com --project my-app`
creates a project on the share worker and prints a `<script>` tag for the application and a link for the reviewer. The
link carries the project and an AES-GCM key in its fragment, which never reaches a server: the widget seals every
anchor, comment and screenshot before sending it, the CLI opens them, and the worker stores and relays ciphertext. The
widget mounts only for a browser that opened the link, so the tag can stay in a public deployment. The worker accepts
widget requests only from the origin the project was shared for, and agent requests only with the token `share`
stored on this machine. `watch`, `reply`, `fetch` and `list` work as above.

## Theming

Agent Canvas supports light and dark themes, automatically matching your system preference.

A project can set its own colours and fonts in `.agent-canvas/theme.css` at its root; they apply to the canvases and
the UI around them. The daemon accepts only `--color-*` and `--font-*` variables on `:root`, `[data-theme="light"]`
and `[data-theme="dark"]`, with balanced plain values, and serves its own rebuild of them, so a theme cannot load a
URL or style the page otherwise. The file must stay inside the project (no symlink out) and under 64 KB. A file that
breaks a rule is not applied; the daemon log and the browser console give the line. The `template-dashboard` and
`template-slides` instructions topics are starting points for a status dashboard and a deck.

**Dark mode**

![](docs/dark.png)

## Development

### Reusable packages

| Package                                                                                                    | Use without the Agent Canvas shell                                     |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`@fabrika/daemon-kit`](https://github.com/contember/fabrika-platform/tree/main/packages/daemon-kit)       | Bun daemon lifecycle, HTTP routing, WebSocket channels and CLI waiters |
| [`@fabrika/annotations`](https://github.com/contember/fabrika-platform/tree/main/packages/annotations)     | Annotation state, editors and text/block/region locators               |
| [`@fabrika/canvas-kernel`](https://github.com/contember/fabrika-platform/tree/main/packages/canvas-kernel) | JSX compiler, revisions, renderer and interactive canvas components    |

The kernel depends on the other two; neither depends on the kernel. All ship as
TypeScript sources and are released together with `agent-canvas` from the
[`fabrika-platform`](https://github.com/contember/fabrika-platform) repository.

### Share client

`agent-canvas/share` shares a compiled canvas from another host through the same share worker and wire format the
daemon uses, with end-to-end encryption on by default. `agent-canvas/share/responses` holds only the schema of the
structured answers, for code that must not load the encryption helpers.

```ts
import { compileJsx } from '@fabrika/canvas-kernel/server'
import {
	createShare,
	decryptFeedbackEntry,
	fetchShareFeedback,
	importShareKey,
	revokeShareOnWorker,
} from 'agent-canvas/share'

const endpoint = 'https://canvas.example.com'
const compiled = await compileJsx(jsx)
if (!compiled.ok) throw new Error(compiled.error)
const share = await createShare({
	version: 1,
	origin: {
		sessionId: 'doc-1',
		revision: 1,
		createdAt: new Date().toISOString(),
	},
	canvasFiles: [{ filename: 'plan.jsx', compiledJs: compiled.js }],
	runtime: { componentsVersion: '<agent-canvas version>' },
}, { endpoint })
// share.url carries the key in its #k= fragment; keep it and share.ownerToken secret.
if (!share.encryptionKey || !share.ownerToken) {
	throw new Error('expected an encrypted share with an owner token')
}

const key = await importShareKey(share.encryptionKey)
let since = '' // keep it between polls
const page = await fetchShareFeedback(endpoint, share.shareId, since)
for (const wire of page.entries) {
	try {
		const entry = await decryptFeedbackEntry(wire, key)
		// entry.responses: structured answers to Choice, MultiChoice, UserInput and RangeInput;
		// entry.droppedResponses: how many did not fit the wire shape and were left out.
	} catch {
		// One entry that does not decrypt; the others still count.
	}
}
// page.malformed: ids of entries that did not match the wire format.
since = page.latestAt ?? since

await revokeShareOnWorker(endpoint, share.shareId, share.ownerToken)
```

Compile with the `@fabrika/canvas-kernel` of the same release: the worker serves the runtime it was deployed with.

### Local commands

```bash
bun install
bun run build                  # build client assets
bun daemon/build.ts --watch    # watch mode

# Test with demo canvas
bun bin/agent-canvas.ts daemon start
CANVAS_SESSION_ID=demo bun bin/agent-canvas.ts push example --label "Demo"   # opens the canvas through a one-time link
bun bin/agent-canvas.ts open --session demo                                  # a fresh link for another browser
```

## License

MIT
