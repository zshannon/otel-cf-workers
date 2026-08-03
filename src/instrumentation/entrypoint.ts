import { context, type Exception, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { WorkerEntrypoint } from 'cloudflare:workers'

import { type Initialiser, setConfig } from '../config.js'
import type { RPCTrigger } from '../types.js'
import { exportSpans } from './common.js'

type Entrypoint = WorkerEntrypoint<any>
export type EntrypointClass = new (ctx: ExecutionContext, env: any) => Entrypoint

export function instrumentEntrypointClass<C extends EntrypointClass>(entrypointClass: C, initialiser: Initialiser): C {
	for (const property of Object.getOwnPropertyNames(entrypointClass.prototype)) {
		if (property === 'constructor') continue
		const descriptor = Object.getOwnPropertyDescriptor(entrypointClass.prototype, property)
		const method = descriptor?.value
		if (!descriptor || typeof method !== 'function') continue
		Object.defineProperty(entrypointClass.prototype, property, {
			...descriptor,
			async value(this: Entrypoint, ...args: unknown[]) {
				const ctx = Reflect.get(this, 'ctx') as ExecutionContext
				const env = Reflect.get(this, 'env')
				const trigger: RPCTrigger = { method: property, type: 'rpc' }
				const config = initialiser(env, trigger)
				const service = config.service.name
				const invocationContext = setConfig(config)
				return context.with(invocationContext, () =>
					trace.getTracer('RPC').startActiveSpan(
						`RPC ${service}.${property}`,
						{
							attributes: {
								'rpc.method': property,
								'rpc.service': service,
								'rpc.system': 'cloudflare',
							},
							kind: SpanKind.SERVER,
						},
						async (span) => {
							try {
								return await Reflect.apply(method, this, args)
							} catch (error) {
								span.recordException(error as Exception)
								span.setStatus({ code: SpanStatusCode.ERROR })
								throw error
							} finally {
								span.end()
								ctx.waitUntil(exportSpans(span.spanContext().traceId))
							}
						},
					),
				)
			},
		})
	}
	return entrypointClass
}
