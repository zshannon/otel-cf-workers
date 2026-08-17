import { context, SpanKind, trace } from '@opentelemetry/api'
import { WorkerEntrypoint } from 'cloudflare:workers'

import { type Initialiser, setConfig } from '../config.js'
import type { RPCTrigger } from '../types.js'
import { exportSpans, instrumentResponseBody, recordSpanError } from './common.js'
import { extractRPCContext, rpcSpanAttributes, rpcSpanName } from './rpc.js'

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
				const service = entrypointClass.name
				const parentContext = extractRPCContext(context.active(), args, config)
				const invocationContext = setConfig(config, parentContext)
				return context.with(invocationContext, () =>
					trace.getTracer('RPC').startActiveSpan(
						rpcSpanName(service, property),
						{
							attributes: rpcSpanAttributes(service, property),
							kind: SpanKind.SERVER,
						},
						async (span) => {
							let completion: Promise<void> | undefined
							try {
								const result = await Reflect.apply(method, this, args)
								if (result instanceof Response) {
									const instrumented = instrumentResponseBody(result, context.active())
									completion = instrumented.completion
									return instrumented.result
								}
								return result
							} catch (error) {
								recordSpanError(span, error)
								throw error
							} finally {
								if (completion) {
									ctx.waitUntil(
										completion.then(
											() => {
												span.end()
												return exportSpans(span.spanContext().traceId)
											},
											(error) => {
												recordSpanError(span, error)
												span.end()
												return exportSpans(span.spanContext().traceId)
											},
										),
									)
								} else {
									span.end()
									ctx.waitUntil(exportSpans(span.spanContext().traceId))
								}
							}
						},
					),
				)
			},
		})
	}
	return entrypointClass
}
