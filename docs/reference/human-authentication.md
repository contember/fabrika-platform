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

OIDC issuer, client ID, admission domains, and client secret are required only
when OIDC is enabled. Enabling an email sender does not enable password login,
and enabling password login does not provision a credential for any user.

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
expensive derivation. Public forms use same-origin checks, an enforced 16 KiB
stream limit, safe redirect
validation, no-referrer and no-store headers, a restrictive CSP, and
frame-ancestor protection.

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
behind the gate.

A machine that calls the control plane, Operations, or any deployed app uses an
**IAM-issued service key**: an operator (or CI, once bootstrapped) provisions one
through IAM's admin surface with the provisioning key, and the resulting `px_…`
credential is what the proxy exchanges for an access token. The local stack does
exactly this and stores the result in `.state/machine.env`.

A service key is bound to the app it was provisioned for. Provisioning it with no
`app` makes it cross-app, which is the right choice for an operator credential
that drives several planes and the wrong one for an integration that needs only
one.

See [ADR-0020](../decisions/0020-compose-human-authentication-methods.md) for the
decision and rejected mode/temporary-password alternatives.
