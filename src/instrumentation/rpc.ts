import { Context, defaultTextMapGetter, defaultTextMapSetter } from '@opentelemetry/api'

import { ResolvedTraceConfig } from '../types.js'

export function extractRPCContext(
	parentContext: Context,
	args: readonly unknown[],
	config?: ResolvedTraceConfig,
): Context {
	const carrier = config?.rpc.carrier?.(args)
	if (carrier === undefined || !config) return parentContext
	return config.propagator.extract(parentContext, carrier, config.rpc.getter || defaultTextMapGetter)
}

export function injectRPCContext(spanContext: Context, args: readonly unknown[], config?: ResolvedTraceConfig): void {
	const carrier = config?.rpc.carrier?.(args)
	if (carrier === undefined || !config) return
	config.propagator.inject(spanContext, carrier, config.rpc.setter || defaultTextMapSetter)
}

export function rpcSpanName(service: string, method: string): string {
	return `${service}/${method}`
}

export function rpcServiceName(binding: string, config?: ResolvedTraceConfig): string {
	return config?.rpc.serviceName?.(binding) || binding
}

export function rpcSpanAttributes(service: string, method: string) {
	return {
		'rpc.system.name': 'cloudflare.workers',
		'rpc.method': rpcSpanName(service, method),
	}
}
