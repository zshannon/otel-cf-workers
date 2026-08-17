import { SpanStatusCode, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { expect, test, vi } from 'vitest'

import { instrument } from '../../src/sdk'

const encoder = new TextEncoder()

test('keeps fetch spans open through streamed response success, error, and cancellation', async () => {
	const exporter = new InMemorySpanExporter()
	const error = new Error('stream failed')
	const handler = instrument(
		{
			fetch(request: Request) {
				const path = new URL(request.url).pathname
				if (path === '/error') {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.error(error)
							},
						}),
					)
				}
				if (path === '/cancel') {
					return new Response(
						new ReadableStream<Uint8Array>({
							pull() {
								return new Promise(() => {})
							},
						}),
					)
				}
				return new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							const child = trace.getTracer('application').startSpan('lazy work')
							child.end()
							controller.enqueue(encoder.encode('hello'))
							controller.close()
						},
					}),
				)
			},
		},
		{
			instrumentation: { instrumentGlobalCache: false, instrumentGlobalFetch: false },
			service: { name: 'streaming-handler-test' },
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		},
	)
	const waitUntil = vi.fn<ExecutionContext['waitUntil']>()
	const ctx = { waitUntil } as unknown as ExecutionContext
	const flush = async () => {
		const pending = waitUntil.mock.calls.splice(0).map(([promise]) => promise)
		await Promise.all(pending)
	}

	const success = await handler.fetch?.(new Request('https://example.com/success'), {}, ctx)
	expect(exporter.getFinishedSpans().map(({ name }) => name)).not.toContain('fetchHandler GET')
	expect(await success?.text()).toBe('hello')
	await flush()

	const failed = await handler.fetch?.(new Request('https://example.com/error'), {}, ctx)
	await expect(failed?.text()).rejects.toThrow('stream failed')
	await flush()

	const cancelled = await handler.fetch?.(new Request('https://example.com/cancel'), {}, ctx)
	await cancelled?.body?.cancel('client disconnected')
	await flush()

	const spans = exporter.getFinishedSpans()
	const handlers = spans.filter(({ name }) => name === 'fetchHandler GET')
	expect(handlers).toHaveLength(3)
	expect(handlers.filter(({ status }) => status.code === SpanStatusCode.ERROR)).toHaveLength(2)
	expect(spans.find(({ name }) => name === 'lazy work')?.parentSpanContext?.spanId).toBe(
		handlers[0]?.spanContext().spanId,
	)
})
