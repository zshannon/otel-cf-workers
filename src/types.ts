import {
	Attributes,
	Context,
	Span,
	SpanOptions,
	TextMapGetter,
	TextMapPropagator,
	TextMapSetter,
} from '@opentelemetry/api'
import { ReadableSpan, Sampler, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPExporterConfig } from './exporter.js'
import { FetchHandlerConfig, FetcherConfig } from './instrumentation/fetch.js'
import { TailSampleFn } from './sampling.js'

export type OrPromise<T extends any> = T | Promise<T>

export type ResolveConfigFn<Env = any> = (env: Env, trigger: Trigger) => TraceConfig
export type ConfigurationOption = TraceConfig | ResolveConfigFn

export type PostProcessorFn = (spans: ReadableSpan[]) => ReadableSpan[]

export type ExporterConfig = OTLPExporterConfig | SpanExporter

export interface InitialSpanInfo {
	name: string
	options: SpanOptions
	context?: Context
}

export interface HandlerInstrumentation<T extends Trigger, R extends any> {
	getInitialSpanInfo: (trigger: T) => InitialSpanInfo
	getAttributesFromResult?: (result: R) => Attributes
	instrumentResult?: (result: R, context: Context) => InstrumentedResult<R>
	instrumentTrigger?: (trigger: T) => T
	executionSucces?: (span: Span, trigger: T, result: R) => void
	executionFailed?: (span: Span, trigger: T, error?: any) => void
}

export interface InstrumentedResult<R> {
	completion?: Promise<void>
	result: R
}

export type TraceFlushableSpanProcessor = SpanProcessor & { forceFlush: (traceId?: string) => Promise<void> }

export interface HandlerConfig {
	fetch?: FetchHandlerConfig
}

export type RPCCarrierHook = (args: readonly unknown[]) => unknown | undefined

export interface RPCInstrumentationConfig {
	/** Return the application-owned carrier sent as part of the RPC arguments. */
	carrier?: RPCCarrierHook
	/** Read propagation fields from the carrier. Defaults to direct object access. */
	getter?: TextMapGetter
	/** Write propagation fields to the carrier. Defaults to direct object assignment. */
	setter?: TextMapSetter
	/** Resolve a service-binding name to the RPC interface name used by the server. */
	serviceName?: (binding: string) => string
}

export interface ServiceConfig {
	name: string
	namespace?: string
	version?: string
}

export interface ParentRatioSamplingConfig {
	acceptRemote?: boolean
	ratio: number
}

type HeadSamplerConf = Sampler | ParentRatioSamplingConfig
export interface SamplingConfig<HS extends HeadSamplerConf = HeadSamplerConf> {
	headSampler?: HS
	tailSampler?: TailSampleFn
}

export interface InstrumentationOptions {
	instrumentGlobalFetch?: boolean
	instrumentGlobalCache?: boolean
}

interface TraceConfigBase {
	service: ServiceConfig
	handlers?: HandlerConfig
	fetch?: FetcherConfig
	postProcessor?: PostProcessorFn
	sampling?: SamplingConfig
	propagator?: TextMapPropagator
	rpc?: RPCInstrumentationConfig
	instrumentation?: InstrumentationOptions
}

interface TraceConfigExporter extends TraceConfigBase {
	exporter: ExporterConfig
}

interface TraceConfigSpanProcessors extends TraceConfigBase {
	spanProcessors: SpanProcessor | SpanProcessor[]
}

export type TraceConfig = TraceConfigExporter | TraceConfigSpanProcessors

export function isSpanProcessorConfig(config: TraceConfig): config is TraceConfigSpanProcessors {
	return !!(config as TraceConfigSpanProcessors).spanProcessors
}

export interface ResolvedTraceConfig extends TraceConfigBase {
	handlers: Required<HandlerConfig>
	fetch: Required<FetcherConfig>
	postProcessor: PostProcessorFn
	sampling: Required<SamplingConfig<Sampler>>
	spanProcessors: SpanProcessor[]
	propagator: TextMapPropagator
	rpc: RPCInstrumentationConfig
	instrumentation: InstrumentationOptions
}

export interface DOConstructorTrigger {
	id: string
	name?: string
}

export interface RPCTrigger {
	method: string
	type: 'rpc'
}

export type Trigger =
	| Request
	| MessageBatch
	| ScheduledController
	| DOConstructorTrigger
	| RPCTrigger
	| 'do-alarm'
	| ForwardableEmailMessage
