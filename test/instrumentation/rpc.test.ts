import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api'
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { beforeAll, beforeEach, expect, test, vi } from 'vitest'

import { AsyncLocalStorageContextManager } from '../../src/context'
import { parseConfig, setConfig } from '../../src/config'
import { instrumentState } from '../../src/instrumentation/do'
import { extractRPCContext, injectRPCContext } from '../../src/instrumentation/rpc'
import { instrumentServiceBinding } from '../../src/instrumentation/service'
import { WorkerTracerProvider } from '../../src/provider'

type Call = { carrier: Record<string, string> }

const exporter = new InMemorySpanExporter()
const processor = new SimpleSpanProcessor(exporter)
const encoder = new TextEncoder()

function createConfig() {
	return parseConfig({
		instrumentation: { instrumentGlobalCache: false, instrumentGlobalFetch: false },
		propagator: new CompositePropagator({
			propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
		}),
		rpc: {
			carrier: (args) => (args[0] as Call).carrier,
			serviceName: (binding) => (binding === 'persistence' ? 'PersistenceEntrypoint' : binding),
		},
		service: { name: 'rpc-test' },
		spanProcessors: [processor],
	})
}

beforeAll(() => {
	context.setGlobalContextManager(new AsyncLocalStorageContextManager())
	new WorkerTracerProvider(
		[processor],
		resourceFromAttributes({ 'service.name': 'rpc-test' }),
		createConfig(),
	).register()
})

beforeEach(() => exporter.reset())

test('injects and extracts RPC context through the configured standard propagator', () => {
	const config = createConfig()
	const configured = setConfig(config, context.active())
	const client = trace.getTracer('client').startSpan('client call', {}, configured)
	const clientContext = propagation.setBaggage(
		trace.setSpan(configured, client),
		propagation.createBaggage({ tenant: { value: 'flick' } }),
	)
	const args: [Call] = [{ carrier: {} }]

	injectRPCContext(clientContext, args, config)
	const serverParent = extractRPCContext(context.active(), args, config)
	const server = trace.getTracer('server').startSpan('server call', { kind: SpanKind.SERVER }, serverParent)
	server.end()
	client.end()

	expect(args[0].carrier['traceparent']).toMatch(/^00-/)
	expect(args[0].carrier['baggage']).toBe('tenant=flick')
	expect(server.spanContext().traceId).toBe(client.spanContext().traceId)
	expect((server as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId).toBe(
		client.spanContext().spanId,
	)
	expect(propagation.getBaggage(serverParent)?.getEntry('tenant')?.value).toBe('flick')
})

test('instruments a service-binding RPC client through the server boundary', async () => {
	const config = createConfig()
	const configured = setConfig(config, context.active())
	const binding = instrumentServiceBinding(
		{
			async ingest(call: Call) {
				const serverParent = extractRPCContext(context.active(), [call], config)
				return trace
					.getTracer('server')
					.startActiveSpan('persistence/ingest server', { kind: SpanKind.SERVER }, serverParent, (span) => {
						span.end()
						return call.carrier['traceparent']
					})
			},
		} as unknown as Fetcher,
		'persistence',
	)
	const request = trace.getTracer('request').startSpan('request', {}, configured)
	const requestContext = trace.setSpan(configured, request)
	const call = { carrier: {} }
	const result = await context.with(requestContext, () =>
		(binding as unknown as { ingest(value: Call): Promise<string> }).ingest(call),
	)
	request.end()

	expect(result).toMatch(/^00-/)
	const spans = exporter.getFinishedSpans()
	const client = spans.find(({ kind }) => kind === SpanKind.CLIENT)
	const server = spans.find(({ kind }) => kind === SpanKind.SERVER)
	expect(client?.name).toBe('PersistenceEntrypoint/ingest')
	expect(client?.parentSpanContext?.spanId).toBe(request.spanContext().spanId)
	expect(server?.spanContext().traceId).toBe(client?.spanContext().traceId)
	expect(server?.parentSpanContext?.spanId).toBe(client?.spanContext().spanId)
	expect(client?.attributes).toMatchObject({
		'rpc.method': 'PersistenceEntrypoint/ingest',
		'rpc.system.name': 'cloudflare.workers',
	})
})

test('keeps a service-binding RPC client span open through its streamed response', async () => {
	const config = createConfig()
	const configured = setConfig(config, context.active())
	const binding = instrumentServiceBinding(
		{
			async stream(_call: Call) {
				return new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							controller.enqueue(encoder.encode('hello'))
							controller.close()
						},
					}),
				)
			},
		} as unknown as Fetcher,
		'persistence',
	)
	const request = trace.getTracer('request').startSpan('request', {}, configured)
	const response = await context.with(trace.setSpan(configured, request), () =>
		(binding as unknown as { stream(value: Call): Promise<Response> }).stream({ carrier: {} }),
	)

	expect(exporter.getFinishedSpans().map(({ name }) => name)).not.toContain('PersistenceEntrypoint/stream')
	expect(await response.text()).toBe('hello')
	await Promise.resolve()
	request.end()

	const client = exporter.getFinishedSpans().find(({ name }) => name === 'PersistenceEntrypoint/stream')
	expect(client?.kind).toBe(SpanKind.CLIENT)
	expect(client?.parentSpanContext?.spanId).toBe(request.spanContext().spanId)
})

test('binds Durable Object callbacks to the active span and configured context', async () => {
	const config = createConfig()
	const configured = setConfig(config, context.active())
	const blockConcurrencyWhile = vi.fn((callback: () => Promise<void>) => context.with(ROOT_CONTEXT, callback))
	const state = instrumentState({
		blockConcurrencyWhile,
		storage: {},
	} as unknown as DurableObjectState)
	const parent = trace.getTracer('callback').startSpan('durable object setup', {}, configured)

	await context.with(trace.setSpan(configured, parent), () =>
		state.blockConcurrencyWhile(async () => {
			const child = trace.getTracer('callback').startSpan('durable object callback')
			child.end()
		}),
	)
	parent.end()

	expect(blockConcurrencyWhile).toHaveBeenCalledOnce()
	const callback = exporter.getFinishedSpans().find(({ name }) => name === 'durable object callback')
	expect(callback?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
})
