import { context } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { expect, test } from 'vitest'

import { parseConfig, setConfig } from '../src/config'
import { WorkerTracerProvider } from '../src/provider'
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

test('uses the provider configuration when a platform callback has no active config context', () => {
	const processor = new SimpleSpanProcessor(new InMemorySpanExporter())
	const config = parseConfig({
		instrumentation: {
			instrumentGlobalCache: false,
			instrumentGlobalFetch: false,
		},
		service: { name: 'test' },
		spanProcessors: [processor],
	})
	const provider = new WorkerTracerProvider([processor], resourceFromAttributes({ 'service.name': 'test' }), config)

	const span = provider.getTracer('application').startSpan('platform callback')
	span.end()

	expect(span.spanContext().traceId).toHaveLength(32)
})
