# Core fork provenance

Source: https://github.com/japa/core, tag `v10.4.0`, commit
`067418a358f151fd3892ecc6b084f719ac3eed37`.

The upstream MIT license is preserved in LICENSE.md. The source and regression
suite are checked into this runner repository so changes are reviewable without
editing an installed dependency.

Local changes:

- Skip absent dataset/context callback stages and empty setup, teardown and
  cleanup stages. Preserve the async skip-event boundary and captured hook
  runner semantics.
- Accept an explicit `null` debugging error in `Test.run` to opt out of stack
  capture. Omitted arguments still capture declaration stacks.
- Add regression coverage for datasets, dynamic cleanup, failure cleanup, and
  timeouts without declaration stacks.
- Use version `10.4.0-speed.1`; retain `time-span` as a runtime dependency because
  the checked-in source imports it.
- Quote the test glob so Node runs top-level and nested test files. Ignore build
  output in linting.

Build and pack this package alongside runner `5.4.0-speed.2`. Install both
local tarballs together; neither prerelease has been published to npm.
