# ATS validation harness templates

See [the runbook](../ATS_VALIDATION.md) for setup, findings, and retesting.

Copy these files into `.benchmarks/ats-validation/` before executing them. Their
paths are relative to that lab directory; they do not run against the original ATS
checkout. Do not apply `copy-only.patch` in the original checkout.

The app copy, environments, dependency copies, and detailed test results are
intentionally excluded from Git. No application credentials are needed: the lab
uses the app's `.env.test.example` and disposable service credentials.
