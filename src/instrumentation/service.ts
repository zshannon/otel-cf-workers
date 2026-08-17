import { context as api_context, SpanKind, trace } from '@opentelemetry/api'

import { getActiveConfig } from '../config.js'
import { passthroughGet, wrap } from '../wrap.js'
import { instrumentResponseBody, recordSpanError } from './common.js'
import { instrumentClientFetch } from './fetch.js'
import { injectRPCContext, rpcServiceName, rpcSpanAttributes, rpcSpanName } from './rpc.js'

type RPCMethod = (...args: unknown[]) => unknown
type Thenable = { then: (...args: unknown[]) => unknown }

function isThenable(value: unknown): value is Thenable {
	return (
		((typeof value === 'object' && value !== null) || typeof value === 'function') &&
		typeof (value as { then?: unknown }).then === 'function'
	)
}

function instrumentRPCMethod(method: RPCMethod, property: string, binding: string): RPCMethod {
	return (...args) => {
		const config = getActiveConfig()
		const service = rpcServiceName(binding, config)
		return trace
			.getTracer('RPC')
			.startActiveSpan(
				rpcSpanName(service, property),
				{ kind: SpanKind.CLIENT, attributes: rpcSpanAttributes(service, property) },
				(span) => {
					let ended = false
					const responseContext = api_context.active()
					const finish = (error?: unknown) => {
						if (ended) return
						ended = true
						if (error !== undefined) recordSpanError(span, error)
						span.end()
					}
					const settle = (value: unknown) => {
						if (!(value instanceof Response)) {
							finish()
							return value
						}

						const instrumented = instrumentResponseBody(value, responseContext)
						if (instrumented.completion) {
							void instrumented.completion.then(
								() => finish(),
								(error) => finish(error),
							)
						} else {
							finish()
						}
						return instrumented.result
					}

					try {
						injectRPCContext(responseContext, args, config)
						const result = method(...args)
						if (!isThenable(result)) return settle(result)

						return wrap(result, {
							get(target, prop, receiver) {
								if (prop !== 'then') return passthroughGet(target, prop, receiver)
								const then = passthroughGet(target, prop, receiver) as Thenable['then']
								return (onFulfilled?: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) =>
									then(
										(value: unknown) =>
											api_context.with(responseContext, () => {
												try {
													const settled = settle(value)
													return onFulfilled ? onFulfilled(settled) : settled
												} catch (error) {
													finish(error)
													throw error
												}
											}),
										(error: unknown) =>
											api_context.with(responseContext, () => {
												finish(error)
												if (onRejected) return onRejected(error)
												throw error
											}),
									)
							},
						})
					} catch (error) {
						finish(error)
						throw error
					}
				},
			)
	}
}

export function instrumentServiceBinding(fetcher: Fetcher, envName: string): Fetcher {
	return wrap(fetcher, {
		get(target, prop, receiver) {
			if (prop === 'fetch') {
				const fetcher = passthroughGet(target, prop, receiver) as Fetcher['fetch']
				return instrumentClientFetch(fetcher, () => ({ includeTraceContext: true }), {
					name: `Service Binding ${envName}`,
				})
			}

			const value = passthroughGet(target, prop, receiver)
			return prop !== 'connect' && typeof prop === 'string' && typeof value === 'function'
				? instrumentRPCMethod(value, prop, envName)
				: value
		},
	})
}
