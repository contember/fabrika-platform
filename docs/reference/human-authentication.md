# Human authentication

IAM composes OIDC and password authentication as independent capabilities. The
combination is derived from two switches; there is no separate hybrid mode.

| OIDC | Password | Login behavior                                                 |
| ---- | -------- | -------------------------------------------------------------- |
| on   | off      | `/auth/login` continues directly to OIDC.                      |
| off  | on       | `/auth/login` renders the password form.                       |
| on   | on       | The form offers both password and OIDC continuation.           |
| off  | off      | Configuration is invalid and startup or materialization fails. |

The runtime switches are `OIDC_ENABLED` and `PASSWORD_ENABLED`. An installation
sets them through `FABRIKA_IAM_OIDC_ENABLED` and
`FABRIKA_IAM_PASSWORD_ENABLED`. Missing switches retain the compatibility mode:
OIDC enabled and password disabled. New installations write both explicitly.

With OIDC enabled, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` are all
required and startup fails without any of them, on **both** runtimes. Refusing to
boot beats serving a method that can only fail at the redirect. A local
`wrangler dev` therefore runs password-only.

The human-admission allowlist (`FABRIKA_IAM_HUMAN_EMAIL_DOMAINS` /
`FABRIKA_IAM_HUMAN_EMAILS`, a `*` in either meaning admit-all) governs
self-provisioning at the OIDC callback only, and is matched against the
IdP-verified email. It is not required configuration: empty and without a `*` it
admits only already-known or invited principals and bootstrap admins, which is
fail-closed. Password login never self-provisions, so it does not consult the list.

Enabling an email sender does not enable password login, and enabling password
login does not provision a credential for any user.

## Per-user state

Every user can have one password state:

- `disabled` — no password login is permitted;
- `pending` — an administrator enabled enrollment, but the user has not chosen a
  password;
- `enabled` — a password verifier exists and password login is permitted.

The Access user detail shows the global availability and per-user state of both
methods. Administrators can issue or reissue enrollment, issue reset for an
enabled account, and disable password login. They never set or read a password.

A principal's activation is independent of its OIDC subject. OIDC claiming or a
completed password enrollment activates an invited user. Services are active at
creation. Browser sessions record whether OIDC or password created them.
Replacing or disabling a password revokes password sessions only; valid OIDC
sessions remain active.

An operator lists and revokes a principal's sessions from the Access plane
(`sessions.list` / `sessions.revoke` / `sessions.revokeAll`). Revoking an IAM session
also ends every app session derived from it, because a child session is valid only
while its parent is — the lookup joins to the parent on every use, so it is one
statement rather than a sweep. An access token already minted stays valid for the
rest of its TTL; that bound is what local verification buys.

## User administration in the console

The user detail opens on **Access**, followed by **Sign-in**, **Activity** and
**Account**. Its identity and account status stay visible in every section.

- Access shows each assignment's application, role, scope, expiration and author.
  `grants.update` edits it within its original application, retaining its id and
  author. The change and its before/after audit record commit together. Editing
  also advances the principal's delegation revision, because it can remove authority.
- Permissions are resolved separately for each application through the token
  resolver. Disabled accounts have no usable permissions; their assignments remain.
  Cross-app assignments and bootstrap administration reach platform services only.
- Sign-in groups application sessions under their IAM sign-in, with pagination.
  `SessionDto.status` keeps the stored lifecycle; `unavailableReason` additionally
  reports an ended parent, a disabled account or a disabled sign-in method.
  Signing out everywhere covers every session, including those on other pages.
- Password links show their issue time, expiration and whether they are closed.
  A closed link can have been used, replaced or revoked; metadata cannot tell which.
  Connected OAuth clients can be inspected and disconnected by installation administrators.
- Activity distinguishes changes **to** the person (`subjectPrincipalId`) from
  actions **by** the person (`principalId`, the existing actor filter), and provides
  a separate sign-in decision history. Audit and connected-client reads require
  installation administration. Other controls reflect the same live management
  rules their IAM mutations enforce.

Access changes and sign-outs do not invalidate already issued access tokens;
their default lifetime is five minutes. Disabling an account keeps its sessions
as well as its assignments, so enabling it can restore an unexpired session.

## A browser already signed in

A browser that holds an IAM login opens an application its login has not used yet: IAM asks `Continue
as <label>` or `Use another account` before it hands the login to that application. It does not ask
when the login already holds a session there, or when the login is less than a minute old. `Use another
account` signs the browser out of every application, then shows the sign-in page for the same
application. See [Session handoff](cross-host-sso.md) for the rules.

## Enrollment and reset

Enrollment and reset share one action-token flow:

1. IAM creates a random, one-hour token and stores only its hash. The browser URL
   carries the plaintext in its fragment, which is not sent in HTTP requests or
   access logs; the action page copies it into the same-origin POST form.
2. With an email sender, IAM sends the action URL and the admin API returns the
   destination address and expiry.
3. Without a sender, the admin API returns the URL in that response only so the
   operator can copy it through a trusted channel.
4. A `GET` renders the form without consuming the token, so mail-link scanners
   cannot invalidate it.
5. The same-origin `POST` validates the password and atomically consumes the
   token, stores the verifier, activates the principal, and revokes older
   password sessions.
6. The answer signs the browser in to IAM. An action that keeps an application
   (below) then lands on that application's registered return origin, whose
   proxy completes the sign-in through the normal handoff without asking which
   account, because the login is new. Any other action lands on IAM's own origin.

Reset requests from `/auth/forgot-password` always return the same browser
response. They do not reveal whether the address exists, is disabled, has a
password, or is ambiguous. Self-service recovery is shown only when email is
available. Without email, an administrator issues a manual reset link.

Passwords are normalized to Unicode NFC. A new password must contain from the
installation's minimum to 256 Unicode code points. The minimum is 15 until an
installation administrator sets another (`passwordPolicy.set`, Settings →
Passwords in the console, audited as `iam.password_policy.update`); it applies to
every principal at the next enrollment, reset or invitation enrollment and never
to a stored password. It may go down to 4 on the Bun target and to 15 on a
Cloudflare Worker, whose verifiers are cheaper (backlog 201). A stored value
outside that range applies 15; a read that fails answers 500 and stores nothing. IAM rejects the 10 000
most common passwords (SecLists), a few Czech and long common ones, and exact
account-context values, whatever the minimum. It does not require character
classes. Stored verifiers
use versioned PBKDF2-HMAC-SHA256 parameters, a random per-password salt, and no
reversible password value.

Each composition root picks the PBKDF2 cost its runtime can derive. The Bun
target (Zerops) uses 600,000 iterations, the OWASP recommendation. The
Cloudflare Worker uses 100,000 iterations, because production Workers refuse
PBKDF2 above that count. workerd, miniflare and Bun do not enforce that cap, so
local runs cannot show the failure. A login rehashes a stored verifier whose
count differs from the runtime's cost, so verifiers converge. A verifier above
the runtime's cap, such as one that a Bun installation wrote, never verifies on
a Worker; that user resets the password. Local lopata and miniflare runs do not
enforce the cap either, so an account created locally before this cost applied
holds a 600,000-iteration verifier and cannot sign in until its password is
reset. Production Cloudflare never stored one, because hashing threw there.

Login failures are throttled by separate hashed account and deployment-wide
abuse keys. Recovery has separate account and deployment-wide buckets. Unknown,
ambiguous, disabled, and non-password users receive the same response and incur
password-derivation work until a bucket blocks; blocked requests skip the
expensive derivation.

A successful password login also sets a signed known-device cookie,
`__Host-fabrika_device` (`HttpOnly`, `SameSite=Lax`, 90 days), naming the principal
and a random device id. A later login that presents a valid one for the SAME
principal it targets skips the account and deployment-wide buckets and spends a
bucket of its own instead: 10 failures in 15 minutes, after which the cookie
stops exempting until the block passes. Its failures do not count against the
account. A missing, forged, expired or other principal's cookie changes nothing.
So a client that fills the account or deployment-wide bucket cannot lock out a
user signing in again from a browser that signed in before.

Login and recovery each have a third bucket, keyed on a hash of the client
address, so one client cannot exhaust the deployment-wide bucket and deny the
installation. IAM does not derive that address: the composition root names the
one header its own ingress overwrites — `CF-Connecting-IP` on Cloudflare, where
IAM sits behind the edge, and `X-Fabrika-Client-Ip` on the Bun target, where the
proxy writes it after deleting the caller's. An installation whose ingress
cannot see the client names no header and keeps only the account and
deployment-wide buckets. On Zerops that is the current state: whether the
project balancer forwards a trustworthy client address is unconfirmed, so
`trusted_proxies` is unset and every client shares the balancer's bucket.

Unlike the other two, the client bucket counts every attempt rather than every
failure, decides admission from the returned row of the statement that records
it, and is not cleared by a successful login. Public forms use same-origin checks, an enforced 16 KiB
stream limit, safe redirect
validation, no-referrer and no-store headers, a restrictive CSP, and
frame-ancestor protection.

## Language and the application

IAM renders its pages (sign-in, forgot password, set password, invitation and
their outcomes) and its own e-mails from a catalog in `en` and `cs`. An
application chooses the language and its display name with `locale` and
`displayName` in its contract's vocabulary; IAM reconciles both with the schema.
The words stay IAM's, and every inserted value is escaped.

The application of a request is:

- a handoff sign-in's `?app=`; its forgot-password link carries the same app;
- an invitation's application, named in the mailed link;
- a password action's stored application: the one its forgot-password request
  came from.

An application IAM does not know, or one without a `locale`, gets the
installation's default language, `en`. Without a `displayName`, the sign-in and
password pages and mails name no application, and an invitation names it by its
id. An administrator's action and IAM's own
forgot-password page also use the default. A link's `?app=` only picks words;
where a completed action or invitation lands is decided by the stored
application and its registered return origin.

An application may also word IAM's e-mails itself with `mail` in its vocabulary:
per message (`invitation`, `enrollment`, `reset`) and language, a one-line
subject and a plain text with `{{name}}` placeholders from a closed set per
message. The text must place `{{actionUrl}}`, the link IAM builds. IAM fills the
placeholders, sends the text as filled, and builds the HTML part itself: the
escaped text as paragraphs and its own button to the link. The checker refuses
an unknown placeholder or a text without the link, and so does the reconcile. A
message or a language without a template gets IAM's catalog wording.

A template may carry its own `html` body instead of IAM's, in a closed subset
(`mailHtmlTokens` in `@fabrika/auth-core`): text structure only, no attribute but
a link's `href`, and a link only to `{{actionUrl}}`, `{{appUrl}}` or a `mailto:`
address. IAM renders it from its tokens, never from its source, with every value
escaped. `{{appUrl}}` is built at send time from the application's first
registered return origin; a template that names it while no origin is registered
is sent in IAM's wording ([ADR-0019](../decisions/0019-portable-outbound-email.md)).

## Membership invitations

An application invites an address to a membership role through IAM's
`assignMember` (ADR-0012 §6). The address is verified by the invitation itself:

1. IAM stores a random token's hash with the application, the value, the role
   and the normalized mailbox, and mails a one-time link to
   `/auth/invitations/accept?app=<app>#token=…`. Repeating the invitation answers the open
   one and sends nothing. It expires after 7 days.
2. Without an email sender there are no invitations (`invitations_disabled`).
   Assigning an existing principal by id still works.
3. A `GET` renders the form without consuming anything; the page copies the
   fragment into the same-origin `POST` form.
4. The `POST` needs an IAM session on IAM's host. Without one the page asks the
   person to sign in and open the link again. With one, IAM accepts only when the
   signed-in principal's mailbox is the invited one, checks again that the
   inviter can still give the role, and then marks the invitation accepted and
   writes the grant in one transaction.
5. An accepted invitation lands on the application's registered return origin.
   Without one, IAM answers its outcome page.

An invitation may name the invited person's company (`label`, at most 200
characters on one line) and a personal message (at most 1000 characters of plain
text). Both reach the e-mail, IAM's wording and an application's
`{{companyLabel}}`/`{{message}}` alike, and are escaped in its HTML part. A
resend (`invitation.resend`) gives the open invitation a new link and a new
7 days and mails it again; the earlier link stops working.

### An invitation that creates its principal

An invitation to a role the application declares `external` (ADR-0051), for a
mailbox no principal holds, onboards a person IAM does not know. Nothing is
created when it is sent. When the mailbox's owner opens the link and accepts,
IAM answers a set-password form instead of asking them to sign in, provided the
installation enables password authentication and e-mail and the inviter can
still give the role. That form's `POST` creates the external principal, its
enabled password (same policy and verifier as enrollment), its grant, consumes
the invitation and writes the records, in one transaction, then signs the
browser in to IAM and lands it on the application, whose proxy completes the
handoff. This enrollment lives as long as the invitation, 7 days (ADR-0020).

- A mailbox some principal holds keeps the sign-in-and-accept steps above. An
  invitation never sets, replaces or re-enables an existing principal's
  password, a disabled principal's included.
- A mailbox the organization names — a bootstrap admin, an exact
  `HUMAN_EMAILS` entry or a `HUMAN_EMAIL_DOMAINS` domain (`*` names nobody) — is
  never created as an external: inviting it to an external role is refused with
  `internal_mailbox`.
- Two acceptances that would create the same mailbox create one principal; the
  other person signs in with it and accepts.
- A browser signed in on IAM as anyone gets no set-password form: the page
  names the invited address and asks the person to sign out or open the link
  in another browser profile. Nothing is written and the link stays valid.
- Every acceptance, this one and a signed-in one, writes only while the
  inviter is still enabled and holds its assigning role, and the application's
  schema is at the revision its check read. A reconcile, a disable or the
  removal of the assigning grant in between makes it write nothing, and the
  invitation stays open. Removing another grant of the inviter's that supplied
  one of the role's actions is not serialized with it.

## Terminals

A terminal is a shared computer, an enrolled browser, on which an application identifies a person in its own way (a
PIN, a key fob) and IAM signs that person in
([ADR-0067](../decisions/0067-a-terminal-signs-a-person-in-on-an-application-s-word.md)).

- **Enrolment.** A person holding `iam.terminals.manage` opens `/auth/terminals/enroll` on the computer and names it.
  IAM creates a `service` principal with a `terminals` row and sets `__Host-px_terminal` on IAM's host (random, stored
  as a hash, `HttpOnly`, `SameSite=Lax`, 400 days). In the same batch it revokes the enrolling login on that browser
  and writes an audit event. The cookie is not a session: no proxy reads it, and IAM reads it only to open an
  identification.
- **Profile.** `terminals.setProfile` on `/admin/rpc` (`iam.admin`) sets the label, `sessionTtl` (1–3600 s, default
  300) and the asserters: the applications that may assert a person on the terminal, each with its **ceiling**, a list
  of action patterns. Grants on the terminal's principal (`grants.create`) are what the terminal adds.
  `terminals.list` lists terminals; `terminals.revoke` ends every session issued on one.
- **Identification.** The proxy bounces to `/auth/login` as for any sign-in. A personal login on the browser wins.
  Otherwise, with a valid terminal cookie, the application among its asserters and an identification page declared,
  IAM opens an identification (single use, two minutes, holding the handoff) and redirects to
  `<return origin><identify>?identification=<id>`. In every other case IAM shows the normal sign-in.
- **Assertion.** The application's public procedure calls `inspectIdentification`, `assertIdentity` and
  `cancelIdentification` over its membership transport, with a token whose `aud` is the application. IAM takes the
  application from the transport, never from the input. `assertIdentity` accepts only an active internal user. It
  consumes the identification, writes a login with `authentication_method = 'terminal_assertion'`, the terminal and
  the terminal's TTL, and no cookie, and returns the handoff callback URL. The browser follows it, and the proxy
  redeems the code with the verifier it set at the bounce.
- **What the session may do.** The token carries the person's `sub`, `amr: 'terminal_assertion'` and
  `terminal: { id, label }`. Its permissions are the person's own, narrowed by the ceiling (a person's `*` under a
  ceiling `a.read` keeps `a.read`), plus the terminal principal's, with source `terminal`. An empty ceiling, the
  default, keeps only the person's identity. The session mints only for the asserting application, never for a
  platform audience.
- **Sign-out.** The application sends the browser to its own `/__fabrika/auth/signout?redirect=<path>` (a same-origin
  `GET`). The proxy clears the session cookie and its cached token and redirects to IAM's
  `/auth/terminals/release`. IAM checks the return address against the application's return origins, revokes the
  terminal's active sessions and sends the browser back. The next request bounces and opens a new identification.
  The session TTL is the backstop when nobody signs out.
- **Throttling** guesses is the application's duty; `inspectIdentification` names the terminal to key it on. Every
  `auth_log` row of the flow carries `terminal_id` and `asserted_by`.

An application declares `terminal: { identify: '/path' }` in its vocabulary, a path that a public SPA mount serves.
Its procedures then get `ctx.terminals`, and a person's `ctx.principal.terminal` names the terminal
([Application runtime](application-runtime.md#membership-share-links-and-the-anonymous-kinds)).

## First administrator

`IAM_BOOTSTRAP_ADMINS` authorizes an email only after identity is proven. It is
not a password and does not create a principal by itself.

For a password-only installation with email, requesting recovery for one exact
configured bootstrap mailbox can create its invited principal and send the first
enrollment action. Comparison is case-insensitive over the complete mailbox; it
does not apply domain or wildcard admission rules.

Without email, the existing `FABRIKA_IAM_PROVISIONING_KEY` bearer calls the IAM
admin RPC to invite the first user and issue a manual enrollment link. The same
path is used for later manual enrollment. Fabrika does not store or print a
bootstrap password.

## First machine caller

`FABRIKA_IAM_PROVISIONING_KEY` authenticates against IAM's own `/admin/*`
surface, which is not behind the proxy. It is **not** a credential for any other
service. It has no `credentials` row, so `mintFromKey` cannot resolve it, and the
proxy refuses it with `invalid_key` before the request reaches the application
behind it.

A machine that calls the control plane, Operations, or any deployed app uses an
**IAM-issued service key**: an operator (or CI, once bootstrapped) provisions one
through IAM's admin surface with the provisioning key, and the resulting `px_…`
credential is what the proxy exchanges for an access token. The local stack does
exactly this and stores the result in `.state/machine.env`.

A service key is bound to the app it was provisioned for. Provisioning it with no
`app` makes it cross-app, which is the right choice for an operator credential
that drives several planes and the wrong one for an integration that needs only
one. A cross-app grant reaches only the installation's own services (IAM, the
console, Operations): a token for an application `<app>@<env>` carries the grants
of that id and nothing else, and neither does the bootstrap `admin`
([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md) rule 6).

A service key's permissions are the grants of its service principal, and IAM reads them at every token exchange. To
change what a key may do, an installation administrator adds or removes a grant on the key's page in the console
(Access → Credentials → the key), or calls `grants.create` and `grants.delete` on its principal. The key keeps its
secret, so nothing is redistributed. The same rules apply as at provisioning: a registered app, a known role or catalog
actions, and no wildcard at a contract application. A user administrator cannot do this
([ADR-0058](../decisions/0058-user-administration-is-grantable-on-its-own.md) section 4). The change applies at the
key's next exchange. A caller that already holds a token, the proxy's cached one included, keeps the old permissions
until that token expires, at most five minutes. A grant at an app other than the one the key is bound to never reaches
its token, so the console offers only that app.

See [ADR-0020](../decisions/0020-compose-human-authentication-methods.md) for the
decision and rejected mode/temporary-password alternatives.
