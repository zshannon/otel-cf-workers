import { context, SpanStatusCode, trace } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { expect, test } from 'vitest'

import { AsyncLocalStorageContextManager } from '../../src/context'
import { parseConfig, setConfig } from '../../src/config'
import { instrumentResponseBody, recordSpanError } from '../../src/instrumentation/common'
import { WorkerTracer } from '../../src/tracer'

const encoder = new TextEncoder()

function setup() {
	const exporter = new InMemorySpanExporter()
	const processor = new SimpleSpanProcessor(exporter)
	const tracer = new WorkerTracer([processor], resourceFromAttributes({ 'service.name': 'streaming-test' }))
	const config = parseConfig({
		instrumentation: { instrumentGlobalCache: false, instrumentGlobalFetch: false },
		service: { name: 'streaming-test' },
		spanProcessors: [processor],
	})
	const configured = setConfig(config, context.active())
	const span = tracer.startSpan('fetchHandler GET', {}, configured)
	const responseContext = trace.setSpan(configured, span)
	const observe = (completion?: Promise<void>) => {
		void completion?.then(
			() => span.end(),
			(error) => {
				recordSpanError(span, error)
				span.end()
			},
		)
	}
	return { exporter, observe, responseContext, span, tracer }
}

test('keeps the server span open and callback context active until a byte stream closes', async () => {
	context.setGlobalContextManager(new AsyncLocalStorageContextManager())
	const { exporter, observe, responseContext, span, tracer } = setup()
	const response = context.with(
		responseContext,
		() =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						const child = tracer.startSpan('lazy work', {}, context.active())
						child.end()
						controller.enqueue(encoder.encode('hello'))
						controller.close()
					},
				}),
			),
	)
	const instrumented = instrumentResponseBody(response, responseContext)
	observe(instrumented.completion)

	expect(exporter.getFinishedSpans().map(({ name }) => name)).not.toContain('fetchHandler GET')
	const reader = instrumented.result.body?.getReader({ mode: 'byob' })
	const chunk = await reader?.read(new Uint8Array(16))
	expect(new TextDecoder().decode(chunk?.value)).toBe('hello')
	expect((await reader?.read(new Uint8Array(16)))?.done).toBe(true)
	await instrumented.completion

	const spans = exporter.getFinishedSpans()
	expect(spans).toHaveLength(2)
	expect(spans.find(({ name }) => name === 'lazy work')?.parentSpanContext?.spanId).toBe(span.spanContext().spanId)
})

test('skips empty response chunks', async () => {
	let pullCount = 0
	const instrumented = instrumentResponseBody(
		new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					if (pullCount++ === 0) {
						controller.enqueue(new Uint8Array())
						return
					}
					controller.enqueue(encoder.encode('hello'))
					controller.close()
				},
			}),
		),
		context.active(),
	)

	expect(await instrumented.result.text()).toBe('hello')
	await expect(instrumented.completion).resolves.toBeUndefined()
})

test('ends and records a streamed response error', async () => {
	const { exporter, observe, responseContext } = setup()
	const error = new Error('stream failed')
	const instrumented = instrumentResponseBody(
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(error)
				},
			}),
		),
		responseContext,
	)
	observe(instrumented.completion)

	await expect(instrumented.result.text()).rejects.toThrow('stream failed')
	await expect(instrumented.completion).rejects.toThrow('stream failed')
	const spans = exporter.getFinishedSpans()
	expect(spans).toHaveLength(1)
	expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR)
	expect(spans[0]?.attributes['error.type']).toBe('Error')
	expect(spans[0]?.events[0]?.name).toBe('exception')
})

test('ends a streamed response span when the consumer cancels', async () => {
	const { exporter, observe, responseContext } = setup()
	const instrumented = instrumentResponseBody(
		new Response(
			new ReadableStream<Uint8Array>({
				pull() {
					return new Promise(() => {})
				},
			}),
		),
		responseContext,
	)
	observe(instrumented.completion)

	await instrumented.result.body?.cancel('client disconnected')
	await expect(instrumented.completion).rejects.toThrow('client disconnected')
	const spans = exporter.getFinishedSpans()
	expect(spans).toHaveLength(1)
	expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR)
})
