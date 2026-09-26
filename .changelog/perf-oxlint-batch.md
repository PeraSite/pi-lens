---
section: Changed
---

- Batch compatible concurrent oxlint diagnostic requests within one Pi process, retaining four threads, the shared Linux lock, per-file attribution, and the 30-second total budget. Recheck ambiguous/partial coverage individually, reject source drift, and keep autofix and Vite+ single-file.
