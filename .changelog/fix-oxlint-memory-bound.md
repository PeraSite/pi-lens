---
section: Fixed
---

- Bound automatic oxlint lint/autofix to one concurrent Linux invocation per `PI_LENS_HOME`, including independent Pi processes and workspaces, and four threads per invocation. Preserve the 30-second wait-plus-run budget and report incomplete lint as a warning. Direct shell commands and other analyzers remain outside this bound.
