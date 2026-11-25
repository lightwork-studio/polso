# Contributing to Polso

Fork the repository and open a focused pull request against `main`. Describe what changes for
users, what you tested, and how to recover if the change fails. Use synthetic health data in
tests, fixtures, and screenshots. Never commit a real Health export.

Contribute only material you have permission to submit. Contributions use the license that
applies to the affected files under the [license map](LICENSE.md). Preserve existing notices
and identify any third-party material and its license in the PR.

## Local setup

Use the Node.js version in `.node-version` and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs lint, types and tests. `pnpm check:builds` bundles the iOS app as CI does.
The [app guide](apps/mobile/README.md) covers app identities and native builds.

Every pull request gets a `check` result, covering `pnpm check`, the iOS bundle and a native
build for the iOS simulator.

Read the [review workflow](docs/review-and-merge.md) before submitting changes. Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
