# Review mode — comments on a running application

Review mode lets the user click through a running web application (a prototype, a mock, a dev server) and leave
comments on its elements, the way they comment on a canvas. A comment stays a note until the user sends it to you.
You receive sent threads as markdown, change the code, and answer each thread; the answer appears next to the element.

Review mode has no session ID. Threads belong to a **project**: a name in the widget's script tag. The commands default
to `CANVAS_REVIEW_PROJECT`, then to the git repository's directory name; pass `--project <name>` when the tag names a
different one.

## Setup

1. Print the tag and add it to the application's HTML page, in development only:

   ```bash
   bunx agent-canvas review snippet --project <name>
   # <script src="http://localhost:19400/assets/review.js" data-project="<name>"></script>
   ```

   The widget loads from the daemon. `bunx agent-canvas daemon start` starts it if it is not running; `review watch`
   starts it too.

2. Tell the user to open the application and use **Comment** in the bottom-right toolbar: click an element, or select
   text first, write the comment, then **Send to Claude** or **Save note**.

## Loop

Start the watcher right away. The toolbar shows the user "Claude is listening" while it runs. Do NOT poll, sleep, or
check proactively.

**Claude Code**: run the streaming watcher with the Monitor tool and its longest timeout:

```bash
bunx agent-canvas review watch --follow --project <name>
```

It keeps one connection open and prints every batch the user sends as one event, so it needs no restart between
batches. Its only other stdout line is the one that ends the watch when the daemon stays unreachable. Re-arm the
monitor when it expires.

**Other hosts**: run the one-shot watcher in the background. It prints one batch and exits; start it again after
answering:

```bash
bunx agent-canvas review watch --project <name>
```

The output lists each thread with:

- `Page` — the URL the comment was made on, hash route included.
- `Element` — ARIA role and accessible name, the way you would target the element in a browser.
- `Selector` — a CSS path to the element.
- `Components` — React components that own the element, outermost first (React development builds only). Search the
  code for the innermost one first.
- `Selected text` — when the user commented on a text selection.
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
