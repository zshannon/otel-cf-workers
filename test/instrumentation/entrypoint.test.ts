import { trace } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'

import { instrumentEntrypoint } from '../../src/sdk'
import type { RPCTrigger } from '../../src/types'

test('records an RPC span and its nested ingestion work without a network exporter', async () => {
	const exporter = new InMemorySpanExporter()
	const waitUntil = vi.fn<ExecutionContext['waitUntil']>()
	const triggers: RPCTrigger[] = []

	class PersistenceEntrypoint extends WorkerEntrypoint {
		async ingestAuthorizationEvents(events: string[]): Promise<number> {
			return trace.getTracer('database').startActiveSpan('database.models.user.ingest', async (span) => {
				span.end()
				return events.length
			})
		}
	}

	const InstrumentedPersistenceEntrypoint = instrumentEntrypoint(PersistenceEntrypoint, (_env, trigger) => {
		if (typeof trigger === 'object' && 'type' in trigger && trigger.type === 'rpc') triggers.push(trigger)
		return {
			instrumentation: {
				instrumentGlobalCache: false,
				instrumentGlobalFetch: false,
			},
			service: { name: 'persistence-test' },
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		}
	})
	const persistence = new InstrumentedPersistenceEntrypoint({ waitUntil } as unknown as ExecutionContext, {})

	await expect(persistence.ingestAuthorizationEvents(['one', 'two'])).resolves.toBe(2)
	await Promise.all(waitUntil.mock.calls.map(([promise]) => promise))

	expect(triggers).toEqual([{ method: 'ingestAuthorizationEvents', type: 'rpc' }])
	expect(waitUntil).toHaveBeenCalledOnce()
	const spans = exporter.getFinishedSpans()
	expect(spans.map(({ name }) => name)).toEqual([
		'database.models.user.ingest',
		'RPC persistence-test.ingestAuthorizationEvents',
	])
	expect(spans[0]?.parentSpanContext?.spanId).toBe(spans[1]?.spanContext().spanId)
	expect(spans[1]?.attributes).toMatchObject({
		'rpc.method': 'ingestAuthorizationEvents',
		'rpc.service': 'persistence-test',
		'rpc.system': 'cloudflare',
	})
})
