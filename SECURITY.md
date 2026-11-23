# Security policy

## Reporting a vulnerability

Report a vulnerability privately, never in a public issue, pull request or discussion.

1. **GitHub private vulnerability reporting** is the main way: open
   [a private report](https://github.com/contember/fabrika-platform/security/advisories/new) from the repository's
   Security tab. Only the maintainers see it.
2. **Email** [security@contember.com](mailto:security@contember.com) if you cannot use GitHub.

Say which release or commit you tested, which provider (Cloudflare or Zerops), the steps that reproduce the problem and
what an attacker gains. A proof of concept against your own installation helps; do not test against an installation
you do not own.

## Which versions get fixes

fabrika is before 1.0. The maintainers fix vulnerabilities in the newest release only. The release process provides
the means ([`release-process.md`](docs/reference/release-process.md)):

- **The newest release on npm's `latest` dist-tag** gets a fix as a patch release cut from its tag
  ([cutting a hotfix](docs/reference/release-process.md#cutting-a-hotfix)).
- **Prereleases** (the `next` dist-tag and the release channels) get it in their next prerelease
  ([release channels](docs/reference/release-process.md#release-channels)).
- **Older releases** get no back-port: upgrade the installation to the fixed release. A fix in a framework package an
  application pins (`@fabrika/app`, `@fabrika/auth`, `@fabrika/db`, …) reaches that application when it raises its own
  pin to the fixed release and the installation runs a release whose
  [framework window](docs/reference/release-process.md#the-framework-window) includes it.

## Dependencies

The repository has Dependabot alerts enabled; CI runs no separate dependency audit. Report a vulnerable dependency
that fabrika exposes the same way as any other vulnerability.

## What to expect after a report

1. A maintainer acknowledges the report and confirms or disputes the vulnerability, asking for detail when needed.
2. A confirmed vulnerability is fixed in the advisory's temporary private fork and released as above. The maintainers set the
   disclosure date and agree it with you where they can; until then, please keep the details private.
3. The fix is published as a GitHub security advisory, with a CVE where it applies, crediting you unless you prefer
   otherwise.

## Support

This repository promises no support or uptime. Support for an installation can be arranged by contract with the
authors. What the platform's design guarantees, and what stays with the organization that runs it, is in
[`docs/reference/security-guarantees.md`](docs/reference/security-guarantees.md).
