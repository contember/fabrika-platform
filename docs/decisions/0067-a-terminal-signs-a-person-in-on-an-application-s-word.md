---
id: 0067
title: A terminal signs a person in on an application's word
status: proposed
date: 2026-10-21
---

# 0067 — A terminal signs a person in on an application's word

## Context

Some installations have shared computers on their premises: a touch screen at the entrance, a tablet on a
workshop wall. Everyone who uses one also has a personal account, but nobody types an email address and a
15-character password on it to record that they arrived at work. They identify with something quick: a short
PIN, an RFID key fob on a USB reader, later perhaps a phone. The session that results must be the person's own,
with their identity and roles, and it must also carry authority that only exists on that computer: recording
attendance is allowed on the entrance screen, not from home.

The platform has nothing for this today:

- **Human sign-in is OIDC or a password** ([ADR-0020](0020-compose-human-authentication-methods.md)). A PIN is
  not a password, and a key fob UID is not a secret at all.
- **A session carries exactly one principal's permissions.** `mintToken` resolves the session's principal and
  nothing else (`packages/iam/src/tokens.ts:48`). A key bound to a principal can only narrow that principal's
  set (`tokens.ts:279`), never add to it.
- **The proxy reads one credential per request** ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)
  §3), so "the person's session plus the computer's key" cannot be two credentials on one request.
- **Builder device authorization** ([ADR-0042](0042-connect-local-builders-through-human-consent.md)) is a
  different thing: it hands a local daemon a key for Control, not a browser a human session. Its names
  (`device_authorizations`, `iam/src/device.ts`) are taken; this ADR calls the shared computer a **terminal**.

How a person identifies on a terminal differs between applications and changes over time: one application
wants a PIN with its own similarity rules, another a fob, a third both. Building each method into IAM would make
every one a platform release. So the identification belongs to the application, and the platform has to make
an application's claim "this is person P, standing at terminal T" safe to act on.

The hard constraint is the session handoff ([ADR-0023](0023-one-session-per-host.md)). A session reaches an
application's host only through a code that the proxy redeems with the verifier cookie it set on that browser
when the login started. A flow in which the application starts the handoff would have no verifier, and dropping
the verifier would reopen the login CSRF that ADR-0023 closed.

## Decision

**We will let an administrator enrol a browser as a terminal, and let an application that the terminal names
assert which person is at it. IAM, not the application, then signs that person in, through the unchanged
handoff. The session it issues carries the person's identity, the person's permissions limited by the
terminal's ceiling, and the permissions the terminal adds.**

### 1. A terminal is an enrolled browser

An administrator with the IAM permission `terminals.manage` opens `/auth/terminals/enroll` on the computer,
signed in with their personal account, and names it. IAM then, in one batch:

- creates a `service` principal for the terminal and a `terminals` row beside it (label, who enrolled it,
  when, `revoked_at`, the profile below), following the pattern of workloads, which are also service
  principals with a side table;
- sets `__Host-px_terminal` on IAM's host: a random token, stored only as a hash, `HttpOnly`, `Secure`,
  `SameSite=Lax`;
- revokes the administrator's login on that browser and clears its cookie, so the terminal is never left
  signed in as the person who set it up;
- writes an audit event.

The terminal's **profile** says what it is for:

| Field         | Meaning                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `asserters`   | the applications that may assert a person on this terminal                                                   |
| `ceiling`     | per application, the patterns of the person's own permissions that survive on the terminal; empty by default |
| grants        | ordinary `grants` rows on the terminal's principal: what the terminal adds                                   |
| `session_ttl` | how long a person's session on it lasts; default 5 minutes, at most 1 hour                                   |

Revoking a terminal sets `revoked_at` and revokes every session issued on it. The cookie then opens nothing.

**Invariant: a terminal cookie is not a session.** No proxy reads it and no request is authorized by it. IAM
reads it on its own host, only to start an identification.

### 2. IAM sends a terminal's browser to the application to identify the person

The flow starts the way every sign-in starts. The browser opens the application, the proxy has no session for
it, and it bounces to `/auth/login` with its handoff state and challenge, keeping the verifier in its own
cookie (ADR-0023, unchanged).

`/auth/login` then checks, in this order:

1. If the browser holds a personal login, that login wins, exactly as today. An administrator can still use a
   terminal for maintenance.
2. If the browser holds a valid terminal cookie and the handoff's application is one of the terminal's
   `asserters`, IAM opens an **identification**. It also checks that the application declares an
   identification page. An identification is a row holding:
   - the terminal;
   - the application;
   - the whole handoff (return URL, state, challenge);
   - a random id, stored as a hash;
   - an expiry of two minutes.

   IAM then redirects the browser to the application's identification page with the id.
3. Otherwise IAM shows the normal sign-in page.

The application declares its identification page in its contract, as a path on its own origin. IAM resolves
that path against the handoff's return origin, which the application's registry has already validated.

### 3. The application asserts the person; IAM signs them in

The identification page is the application's own: a PIN pad, a "hold your fob to the reader" screen, both.
It is a public endpoint, because nobody is signed in yet. The application sends what the person entered to
its own public procedure, which runs as its workload ([ADR-0063](0063-a-public-procedure-runs-as-its-own-workload.md)).
The procedure then talks to IAM over the transport of
[ADR-0064](0064-applications-reach-the-platform-over-a-receiver-verified-transport-key.md):

- `inspectIdentification(id)` returns the terminal's id and label and the expiry. The application needs the
  terminal to throttle guesses per terminal.
- `assertIdentity(id, principalId)` is the application's word. IAM takes the asserting application from the
  verified transport identity, never from the input. It consumes the identification (single use) and checks
  that:
  - the identification has not expired and belongs to this application;
  - the terminal is still enrolled and still lists this application;
  - the principal is an active internal user. External principals ([ADR-0051](0051-external-principals.md))
    never sign in on a terminal.

  IAM then writes a login session for the person with `authentication_method = 'terminal_assertion'`,
  `terminal_id`, `asserted_by` and the terminal's `session_ttl`, in the same batch as the consumption. No browser
  ever holds that login's token. It exists as the parent of the application session. IAM returns its own
  completion URL, `/auth/terminals/complete?identification=<id>`, which carries no code.
- `cancelIdentification(id)` ends an identification that the person abandoned.

The application redirects the browser to the completion URL. IAM issues the handoff code there only when:

- the browser holds the `__Host-px_terminal` cookie of the terminal that the identification belongs to;
- the identification was asserted, is not yet completed, and completes within a minute of the assertion;
- the asserted login is still valid.

IAM then 302s to the proxy's callback. The proxy redeems the code with the verifier it set when the bounce
started, sets the child session and lands on the original return URL. To the proxy this is an ordinary sign-in.

A proxy that receives a code at its callback without a verifier cookie for the code's state redeems it anyway,
with a verifier made for no challenge. IAM consumes a code before it compares the verifier, so the code is spent.

**Invariant: only IAM issues a code, only against a handoff that the proxy started, and only to the terminal's own
browser.** An application never holds a code or a verifier. An asserter can send the terminal's browser to
`/auth/login` with a handoff that it made itself, so it may know the state and the verifier. The completion step
keeps the code on the terminal, and the terminal's proxy holds no verifier for that state and spends the code. A
leaked identification id or completion URL buys nothing elsewhere: the completion refuses every other browser.

**Invariant: a failed identification costs the application, not IAM.** IAM sees only assertions. Throttling
guesses (PIN tries, unknown fobs) is the application's duty, and the identification hands it the terminal to
key that throttle on.

### 4. What a terminal session may do

`mintToken`, for a session that carries `terminal_id`, computes:

```
permissions = (person's resolved permissions filtered by the terminal's ceiling for this app)
              ∪ (the terminal principal's resolved permissions for this app)
```

The ceiling narrows the way an OAuth scope narrows a person's permissions: each of the person's entries yields the
narrower of itself and every ceiling pattern it overlaps, with its own scope. A person's `*` under a ceiling `a.read`
keeps `a.read`; a person's `a.read` under a ceiling `a.*` keeps `a.read`. The added entries carry the source `terminal`.

**Invariant: the ceiling is never absent.** An application's assertion is weaker than the person's own
credential. A buggy or compromised asserter can name anybody, so what it can obtain must be bounded by
something the administrator chose. An empty ceiling, the default, means the person brings only their identity
to the terminal.

**Invariant: a terminal session mints only for the application that asserted it.** It is a child bound to
that application, and the parent carries `asserted_by`. IAM refuses to use it for any other audience. That
includes IAM's own administration audience, which re-resolves permissions from the subject and would otherwise
bypass the ceiling.

Validity: every use joins the session to its terminal, so a revoked terminal ends its sessions at once.
Already-minted access tokens stay valid for the rest of their TTL, as with every revocation (ADR-0022 §4).

### 5. Ending a session on a terminal

A terminal changes hands every few minutes, so ending a session must not wait for a token to expire. The proxy
gets a sign-out path on the application's host, `/__fabrika/auth/signout`, with two properties:

- it is same-origin only;
- it clears the application's session cookie, drops that session's cached token, and redirects to IAM
  `/auth/terminals/release?app=…&redirect=…`.

IAM checks the redirect against the application's return origins. It then revokes the active terminal
sessions of the browser's terminal and sends the browser back. The next request bounces to sign-in, and §2
opens the next identification.

The session TTL is the backstop when nobody signs out. An application should still sign out after its kiosk
action and after a short idle time.

### 6. What an application sees

The access token keeps `ptype: 'user'` and `sub` = the person. It gains two optional claims:

- `amr: 'terminal_assertion'`;
- `terminal: { id, label }`.

The framework exposes them as `ctx.principal.terminal`. There is no new caller kind: a person on a terminal is
`human`. An endpoint meant only for terminals requires an action that only a terminal grants. Ownership checks
stay where ADR-0022 §5 puts them, in the application's own data layer: "record attendance" is granted app-wide
and the handler records it for `ctx.principal`.

IAM writes `terminal_id` and `asserted_by` into `auth_log` for the identification, the assertion, the
redemption and every mint. The values come from the session row, never from what an application sent.

## Consequences

- An application chooses how people identify on its terminals and can change that without a platform release.
  A PIN store, its hashing, similarity rules and throttling live in the application.
- An asserting application is trusted to name the right person. The ceiling, the `asserters` list, the
  single-use identification tied to a proxy-started handoff, and the audit trail bound what a wrong assertion
  can do. They do not stop an asserter from naming a colleague within those bounds. Installations should keep
  the ceiling empty where the identification is weak: a fob UID can be cloned.
- New persisted state, through new immutable migrations in both dialects:
  - the `terminals` and `terminal_identifications` tables;
  - `sessions.terminal_id` and `sessions.asserted_by`, and `terminal_assertion` in the
    `authentication_method` CHECK;
  - `terminal_id` and `asserted_by` columns in `auth_log`.

  The terminal's principal is an ordinary `service` row, so `principals` needs no rebuild.
- `sessionUsable` gets a case for `terminal_assertion`. It is usable whenever the terminal is enrolled; there is
  no installation switch, because no person can enable the method for themselves.
- The proxy gains one path, the sign-out of §5. ADR-0022's invariant "the proxy writes a long-lived cookie on
  exactly one path" holds; the new path only clears one. A proxy older than this release has no sign-out path,
  so a terminal application needs a proxy that serves it. The compatibility checks of
  [ADR-0062](0062-a-platform-release-serves-older-framework-releases.md) refuse to publish such an application
  behind an older proxy.
- The token claims are optional and additive. An older framework ignores them, so an application that never
  uses terminals is unaffected.
- `fabrika platform upgrade` applies the migrations. Nothing changes until an administrator enrols a terminal.

## Alternatives considered

- **A PIN as an IAM sign-in method.** Safer in one respect: no application ever sees the credential. But it
  fixes one identification method into the platform, its rules (length, similarity, lockout) become platform
  configuration, and a fob or a phone would each be another method in ADR-0020. Rejected in favour of the
  application's word bounded by a ceiling.
- **The application starts the handoff after verifying the PIN.** This was the first design: the terminal held
  its own session on the application's host, and the application exchanged it for the person's. It cannot work
  without breaking ADR-0023. The application holds no handoff verifier, so either it gets to set the verifier
  cookie, which makes it the binding authority, or the binding goes, which reopens login CSRF. The redemption
  also copies the parent's principal (`packages/iam/src/handoff.ts:124`), so a terminal parent cannot yield a
  person child. Letting IAM redirect to the application and back keeps the handoff exactly as it is.
- **A device principal type and a device caller.** A third `principals.type` needs a rebuild of `principals`
  in SQLite. A device caller would need a proxy that reads sessions for non-human callers and accepts a
  non-user `ptype` (`packages/proxy-core/src/authorize.ts:388`, `:512`). With identification as a redirect, no
  request is ever made by the terminal itself, so neither is needed.
- **Union without a ceiling: the person's permissions plus the terminal's.** It is the simplest rule. It is also
  the one where a four-digit PIN, or a fob read from a pocket, unlocks an administrator's full authority on a
  shared screen.
- **A `self` scope that IAM binds to the person at mint.** IAM scopes are opaque coordinates owned by the
  application. Binding one to the person needs a mapping from principal to application data that IAM does not
  have. Ownership already belongs in the application's data layer (ADR-0022 §5).
