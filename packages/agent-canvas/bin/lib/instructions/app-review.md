# Review mode — comments on a running application

Review mode lets the user click through a running web application (a prototype, a mock, a dev server) and leave
comments on its elements, the way they comment on a canvas. A comment stays a note until the user sends it to you.
You receive sent threads as markdown, change the code, and answer each thread; the answer appears next to the element.

Review mode has no session ID. Threads belong to a **project**. The commands default to `CANVAS_REVIEW_PROJECT`, then
to the git repository's directory name; pass `--project <name>` to name another.

## Setup

Open the application through the review proxy. The application stays as it is:

```bash
bunx agent-canvas review open <url> --project <name>
```

`<url>` is where the application's dev server runs, e.g. `http://localhost:5173/`; read it from the running server or
the project's dev script, and ask the user when you cannot tell. The daemon serves the application on a port of its own
with the widget added to every HTML page, opens it in the user's browser and prints the address. Hot reload passes
through. The port stays the same across daemon restarts. Only applications on `localhost` can be opened.

When the user wants the widget on the application's own address instead, add the tag to its HTML page in development
only:

```bash
bunx agent-canvas review snippet --project <name>
# <script src="http://localhost:19400/assets/review.js" data-project="<name>"></script>
```

Tell the user to use **Comment** in the bottom-right toolbar: click an element, or select text first, write the
comment, then **Send to Claude** or **Save note**.

## Loop

Start the watcher right away. The toolbar shows the user "Claude is listening" while it runs. Do NOT poll, sleep, or
check proactively.

**Claude Code**: open the application and watch in one command, with the Monitor tool and its longest timeout:

```bash
bunx agent-canvas review open <url> --follow --project <name>
```

Its first stdout line is the address the user reviews at. Then it keeps one connection open and prints every batch the
user sends as one event. Its only other stdout line is the one that ends the watch when the daemon stays unreachable.
When the monitor expires, re-arm it with `bunx agent-canvas review watch --follow --project <name>`, which does not
open the browser again. With the snippet instead of the proxy, use that command from the start.

**Other hosts**: run the one-shot watcher in the background. It prints one batch and exits; start it again after
answering:

```bash
bunx agent-canvas review watch --project <name>
```

The output lists each thread with:

- `Page` — the URL the comment was made on, hash route included. Through the proxy it carries the proxy's port; the
  path and the hash are the application's.
- `Where` — the page heading and the section or dialog around the element.
- `Element` — ARIA role and accessible name, the way you would target the element in a browser.
- `Selector` — a CSS path to the element.
- `Components` — React components that own the element, outermost first.
- `Source` — `file:line:column` where the element and its nearest components are written, innermost first. Start
  there. It needs React 19 in development and source maps from the dev server; without them, search for the innermost
  component instead.
- `Selected text` — when the user commented on a text selection.
- `Screenshot` — when the user attached one: a PNG of the element in its surroundings, the element outlined in red.
  Read it; it shows what the user sees, which matters for visual comments.
- `Markup` — the element's HTML, trimmed: classes, attributes and structure, not whole subtrees.
- The conversation so far.

For each thread:

1. Make the change. The application's dev server reloads it; the user sees it in place.
2. Answer the thread:

   ```bash
   bunx agent-canvas review reply <thread-id> "<what you changed>" --resolve --project <name>
   ```

   Leave out `--resolve` when you ask a question back; the thread returns to the user.

With the one-shot watcher, start `review watch` again for the next batch.

If the user says they already sent comments and no watcher was running, take them with `review fetch`. `review list`
shows every thread that is not resolved, notes included.
