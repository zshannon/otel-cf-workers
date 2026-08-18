---
'@zshannon/otel-cf-workers': patch
---

Skip zero-length source chunks while instrumenting streamed response bodies so Workers byte streams continue to the next payload chunk instead of throwing or stalling.
