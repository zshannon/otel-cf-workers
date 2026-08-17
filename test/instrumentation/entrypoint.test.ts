import { context, defaultTextMapSetter, SpanKind, SpanStatusCode, trace, TraceFlags } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'

import { instrumentEntrypoint } from '../../src/sdk'
import type { RPCTrigger } from '../../src/types'

type IngestArgs = { events: string[]; traceContext: Record<string, string> }
type StreamArgs = { mode: 'cancel' | 'error' | 'success'; traceContext: Record<string, string> }

const encoder = new TextEncoder()

test('records a standard RPC server span with propagated parentage and nested work', async () => {
	const exporter = new InMemorySpanExporter()
	const waitUntil = vi.fn<ExecutionContext['waitUntil']>()
	const triggers: RPCTrigger[] = []

	class PersistenceEntrypoint extends WorkerEntrypoint {
		async ingestAuthorizationEvents({ events }: IngestArgs): Promise<number> {
			return trace.getTracer('database').startActiveSpan('database.models.user.ingest', async (span) => {
				span.end()
				return events.length
			})
		}

		async streamAuthorizationEvents({ mode }: StreamArgs): Promise<Response> {
			if (mode === 'error') {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.error(new Error('stream failed'))
						},
					}),
				)
			}
			if (mode === 'cancel') {
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
						controller.enqueue(encoder.encode('hello'))
						controller.close()
					},
				}),
			)
		}
	}

	const InstrumentedPersistenceEntrypoint = instrumentEntrypoint(PersistenceEntrypoint, (_env, trigger) => {
		if (typeof trigger === 'object' && 'type' in trigger && trigger.type === 'rpc') triggers.push(trigger)
		return {
			instrumentation: {
				instrumentGlobalCache: false,
				instrumentGlobalFetch: false,
			},
			rpc: { carrier: (args) => (args[0] as IngestArgs | StreamArgs).traceContext },
			service: { name: 'persistence-test' },
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		}
	})
	const persistence = new InstrumentedPersistenceEntrypoint({ waitUntil } as unknown as ExecutionContext, {})
	const remoteParent = {
		isRemote: true,
		spanId: '0123456789abcdef',
		traceFlags: TraceFlags.SAMPLED,
		traceId: '0123456789abcdef0123456789abcdef',
	}
	const traceContext: Record<string, string> = {}
	new W3CTraceContextPropagator().inject(
		trace.setSpanContext(context.active(), remoteParent),
		traceContext,
		defaultTextMapSetter,
	)

	await expect(persistence.ingestAuthorizationEvents({ events: ['one', 'two'], traceContext })).resolves.toBe(2)
	await Promise.all(waitUntil.mock.calls.map(([promise]) => promise))

	expect(triggers).toEqual([{ method: 'ingestAuthorizationEvents', type: 'rpc' }])
	expect(waitUntil).toHaveBeenCalledOnce()
	const spans = exporter.getFinishedSpans()
	const server = spans.find(({ kind }) => kind === SpanKind.SERVER)
	expect(spans.map(({ name }) => name)).toEqual([
		'database.models.user.ingest',
		'PersistenceEntrypoint/ingestAuthorizationEvents',
	])
	expect(server?.spanContext().traceId).toBe(remoteParent.traceId)
	expect(server?.parentSpanContext?.spanId).toBe(remoteParent.spanId)
	expect(spans[0]?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId)
	expect(server?.attributes).toMatchObject({
		'rpc.method': 'PersistenceEntrypoint/ingestAuthorizationEvents',
		'rpc.system.name': 'cloudflare.workers',
	})

	waitUntil.mockClear()
	const flush = async () => {
		const pending = waitUntil.mock.calls.splice(0).map(([promise]) => promise)
		await Promise.all(pending)
	}
	const success = await persistence.streamAuthorizationEvents({ mode: 'success', traceContext })
	expect(exporter.getFinishedSpans().map(({ name }) => name)).not.toContain(
		'PersistenceEntrypoint/streamAuthorizationEvents',
	)
	expect(await success.text()).toBe('hello')
	await flush()

	const failed = await persistence.streamAuthorizationEvents({ mode: 'error', traceContext })
	await expect(failed.text()).rejects.toThrow('stream failed')
	await flush()

	const cancelled = await persistence.streamAuthorizationEvents({ mode: 'cancel', traceContext })
	await cancelled.body?.cancel('client disconnected')
	await flush()

	const streamSpans = exporter
		.getFinishedSpans()
		.filter(({ name }) => name === 'PersistenceEntrypoint/streamAuthorizationEvents')
	expect(streamSpans).toHaveLength(3)
	expect(streamSpans.filter(({ status }) => status.code === SpanStatusCode.ERROR)).toHaveLength(2)
	expect(triggers).toEqual([
		{ method: 'ingestAuthorizationEvents', type: 'rpc' },
		{ method: 'streamAuthorizationEvents', type: 'rpc' },
		{ method: 'streamAuthorizationEvents', type: 'rpc' },
		{ method: 'streamAuthorizationEvents', type: 'rpc' },
	])
})
