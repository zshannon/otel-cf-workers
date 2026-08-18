---
'@zshannon/otel-cf-workers': patch
---

Apply the configured RPC service-name resolver to WorkerEntrypoint server spans so bundle-generated class names do not leak into telemetry.
