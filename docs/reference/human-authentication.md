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
   proxy completes the sign-in through the normal handoff. Any other action
   lands on IAM's own origin.

Reset requests from `/auth/forgot-password` always return the same browser
response. They do not reveal whether the address exists, is disabled, has a
password, or is ambiguous. Self-service recovery is shown only when email is
available. Without email, an administrator issues a manual reset link.

Passwords are normalized to Unicode NFC. New passwords must contain 15–256
Unicode code points. IAM rejects a small whole-password common list and exact
account-context values. It does not require character classes. Stored verifiers
use versioned PBKDF2-HMAC-SHA256 parameters, a random per-password salt, and no
reversible password value.

Login failures are throttled by separate hashed account and deployment-wide
abuse keys. Recovery has separate account and deployment-wide buckets. Unknown,
ambiguous, disabled, and non-password users receive the same response and incur
password-derivation work until a bucket blocks; blocked requests skip the
expensive derivation.

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

See [ADR-0020](../decisions/0020-compose-human-authentication-methods.md) for the
decision and rejected mode/temporary-password alternatives.
