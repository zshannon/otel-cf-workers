import { context } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { expect, test } from 'vitest'

import { parseConfig, setConfig } from '../src/config'
import { WorkerTracer } from '../src/tracer'

test('resolves request configuration from an explicitly supplied context', () => {
	const processor = new SimpleSpanProcessor(new InMemorySpanExporter())
	const tracer = new WorkerTracer([processor], resourceFromAttributes({ 'service.name': 'test' }))
	const configured = setConfig(
		parseConfig({
			instrumentation: {
				instrumentGlobalCache: false,
				instrumentGlobalFetch: false,
			},
			service: { name: 'test' },
			spanProcessors: [processor],
		}),
		context.active(),
	)

	const span = tracer.startSpan('deferred work', {}, configured)
	span.end()

	expect(span.spanContext().traceId).toHaveLength(32)
})
