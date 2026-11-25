# Review and merge

All changes reach `main` through pull requests, merged by squash. Start from current `main`.
Decide what the change should do and write down the case that will show it works. Keep
unrelated fixes in separate pull requests so each change can be reviewed and reverted on its own.

Open a draft pull request while the change is in progress. Changes to behavior need a regression
test that exercises a realistic case and verifies the expected outcome.

Review the final commit and its relevant callers and tests. Resolve blocking findings before
merging. The PR records validation, review scope and findings, risk, and how the change can be
reverted or recovered. Pure copy changes can use an author check where the configured branch
rules permit it.

Before merging, verify that CI passes for the head being merged, that the head includes the
current base or merges into it without conflicts, and that outstanding feedback has been
resolved. Re-review substantive changes made after approval. Changes to the review gates and
merge automation require explicit maintainer approval of the final change.

## Changes that need additional review

- **Personal data.** Anything that reads, stores, sends, or exposes health data needs a focused
  review of what leaves the device, who can read it, deletion, retries, and error recovery.
- **Authentication and authorization.** Pairing, tokens, and endpoint access need a focused
  review of the trust boundary, denied-access tests, and a way to disable or roll back the change.
- **Storage and sync.** Changes to stored data or the sync protocol must keep existing data
  readable and come with tests that use realistic prior data.
- **Deploy and credential changes** need evidence that fork PRs run without release credentials
  and that release jobs only publish the reviewed revision.
