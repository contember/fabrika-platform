# {{REPO}}: the fabrika installation in AWS account {{ACCOUNT_ID}}, {{REGION}}

The root of trust for this installation's upgrades. Its workflow takes the installation's deployer role and runs
`fabrika platform upgrade --provider=aws` at the release [`fabrika.ref`](./fabrika.ref) pins, so the platform never
upgrades itself. No key is stored here or anywhere: AWS gives the role, through GitHub's OIDC provider, to a job of
this repository running in the `{{ENVIRONMENT}}` GitHub Environment alone.

## It upgrades an installation; it never creates one

`fabrika platform install --provider=aws` makes the installation from the operator's machine, and
`fabrika platform init --provider=aws` made this repository, its Environment and the deployer role. The whole
procedure is in `fabrika platform guide --provider=aws`.

## Protect the Environment

The deployer is an administrator of the account inside the installation's ceiling: it can make no IAM user, key or
identity provider, can neither widen nor re-trust itself, and passes roles only to the installation's services.
Whoever can run this workflow in the Environment can still do what the platform's stacks can, and a role it makes
for a service may be given a trust pointing outside the account (whoever takes it gets the ceiling, no more). So:

- **Add a required reviewer** to the `{{ENVIRONMENT}}` Environment (Settings, Environments): a person then approves
  every run before the role is taken. `init` printed the command that adds you.
- Keep the Environment restricted to `main`, and `main` protected against force pushes.
- Keep the installation's account for the installation alone: in an account shared with other workloads, the role
  could change what they run.

## Upgrading

Bump [`fabrika.ref`](./fabrika.ref) to a newer published tag of `contember/fabrika-platform` and push. The workflow
refuses anything that is not a tag. A release that changes the installation's ceilings (the permissions boundaries
every platform role carries) stops before anything moves: run that one upgrade with your own administrator
credentials, and the workflow runs the next ones.
