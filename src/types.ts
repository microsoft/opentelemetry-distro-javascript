// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import type { AzureMonitorExporterOptions } from "@azure/monitor-opentelemetry-exporter";
import type { InstrumentationConfig } from "@opentelemetry/instrumentation";
import type { Resource } from "@opentelemetry/resources";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { MetricReader, ViewOptions } from "@opentelemetry/sdk-metrics";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { A365Options } from "./a365/index.js";

/**
 * Microsoft OpenTelemetry distribution version.
 */
export const MICROSOFT_OPENTELEMETRY_VERSION = "1.1.0";

/**
 * Microsoft OpenTelemetry Options
 *
 * Top-level configuration for the Microsoft OpenTelemetry distribution.
 * Global options (resource, sampling, instrumentations, processors) live here.
 * Backend-specific options are scoped under their respective keys.
 */
export interface MicrosoftOpenTelemetryOptions {
  // ── Global options ────────────────────────────────────────────────

  /** OpenTelemetry Resource */
  resource?: Resource;
  /** The rate of telemetry items tracked that should be transmitted (Default 1.0) */
  samplingRatio?: number;
  /** The maximum number of traces to sample per second (Default 5). Set to 0 to use samplingRatio instead. */
  tracesPerSecond?: number;
  /** OpenTelemetry Instrumentations configuration */
  instrumentationOptions?: InstrumentationOptions;
  /** An array of log record processors to register to the logger provider. */
  logRecordProcessors?: LogRecordProcessor[];
  /** An array of span processors to register to the tracer provider. */
  spanProcessors?: SpanProcessor[];
  /** An array of metric readers to register to the meter provider. */
  metricReaders?: MetricReader[];
  /** An array of metric views to register to the meter provider. */
  views?: ViewOptions[];

  // ── Backend-scoped options ────────────────────────────────────────

  /** Azure Monitor configuration. When provided, Azure Monitor export is enabled. */
  azureMonitor?: AzureMonitorOpenTelemetryOptions;

  /** A365 observability configuration. When provided with `enabled: true`, A365 export is enabled. */
  a365?: A365Options;

  /** Enable console exporters for traces, metrics, and logs. Auto-enabled when no other exporter is active. */
  enableConsoleExporters?: boolean;
}

/**
 * Azure Monitor scoped options.
 *
 * These options control Azure Monitor-specific behavior. Global options
 * (resource, sampling, instrumentations, processors) are defined at the
 * distro level in {@link MicrosoftOpenTelemetryOptions}.
 */
export interface AzureMonitorOpenTelemetryOptions {
  /** Enable or disable Azure Monitor export (Default true) */
  enabled?: boolean;
  /** Azure Monitor Exporter Configuration */
  azureMonitorExporterOptions?: AzureMonitorExporterOptions;
  /** Enable Live Metrics feature (Default true) */
  enableLiveMetrics?: boolean;
  /** Enable Standard Metrics feature (Default true) */
  enableStandardMetrics?: boolean;
  /** Enable log sampling based on trace (Default false) */
  enableTraceBasedSamplingForLogs?: boolean;
  /** Enable Performance Counter feature */
  enablePerformanceCounters?: boolean;
  /** Application Insights Web Instrumentation options (enabled, connectionString, src, config) */
  browserSdkLoaderOptions?: BrowserSdkLoaderOptions;
}

/**
 * OpenTelemetry Instrumentations Configuration interface
 */
export interface InstrumentationOptions {
  /** Azure SDK Instrumentation Config */
  azureSdk?: InstrumentationConfig;
  /** HTTP Instrumentation Config */
  http?: InstrumentationConfig;
  /** MongoDB Instrumentation Config */
  mongoDb?: InstrumentationConfig;
  /** MySQL Instrumentation Config */
  mySql?: InstrumentationConfig;
  /** PostgreSql Instrumentation Config */
  postgreSql?: InstrumentationConfig;
  /** Redis Instrumentation Config */
  redis?: InstrumentationConfig;
  /** Redis4 Instrumentation Config */
  redis4?: InstrumentationConfig;
  /** Bunyan Instrumentation Config */
  bunyan?: InstrumentationConfig;
  /** Winston Instrumentation Config */
  winston?: InstrumentationConfig;

  // ── GenAI & agent framework instrumentations ──────────────────────

  /**
   * OpenAI Agents SDK instrumentation.
   * Uses InstrumentationConfig shape (`enabled`, etc.) plus OpenAI-specific options.
   * Requires `@openai/agents` as an optional peer dependency.
   */
  openaiAgents?: OpenAIAgentsInstrumentationConfig;

  /**
   * LangChain instrumentation.
   * Uses InstrumentationConfig shape (`enabled`, etc.) plus LangChain-specific options.
   * Requires `@langchain/core` as an optional peer dependency.
   */
  langchain?: LangChainInstrumentationConfig;
}

/** Configuration for OpenAI Agents SDK instrumentation. */
export interface OpenAIAgentsInstrumentationConfig extends InstrumentationConfig {
  /** Custom tracer name. */
  tracerName?: string;
  /** Custom tracer version. */
  tracerVersion?: string;
  /**
   * When true, the gen_ai.input.messages attribute will be suppressed
   * on InvokeAgent scope spans.
   * @default false
   */
  suppressInvokeAgentInput?: boolean;
}

/** Configuration for LangChain instrumentation. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LangChainInstrumentationConfig extends InstrumentationConfig {}

/**
 * SDK Stats Features Configuration interface
 * @internal
 */
export interface SdkStatsFeatures {
  diskRetry?: boolean;
  aadHandling?: boolean;
  browserSdkLoader?: boolean;
  distro?: boolean;
  liveMetrics?: boolean;
  shim?: boolean;
  customerSdkStats?: boolean;
  multiIkey?: boolean;
  aksResourceDetectorPopulation?: boolean;
  a365?: boolean;
  otlp?: boolean;
}

/**
 * SDK Stats Features Mapping
 * @internal
 */
export const SdkStatsFeaturesMap = new Map<string, number>([
  ["diskRetry", 1],
  ["aadHandling", 2],
  ["browserSdkLoader", 4],
  ["distro", 8],
  ["liveMetrics", 16],
  ["shim", 32],
  ["customerSdkStats", 64],
  ["multiIkey", 128],
  ["aksResourceDetectorPopulation", 256],
  ["a365", 512],
  ["otlp", 1024],
]);

/**
 * SDK Stats Instrumentations Configuration interface
 * @internal
 */
export interface SdkStatsInstrumentations {
  /** Azure Monitor Supported Instrumentations */
  azureSdk?: boolean;
  mongoDb?: boolean;
  mySql?: boolean;
  postgreSql?: boolean;
  redis?: boolean;
  bunyan?: boolean;
  winston?: boolean;
  /** OpenTelemetry Community Instrumentations */
  amqplib?: boolean;
  cucumber?: boolean;
  dataloader?: boolean;
  fs?: boolean;
  lruMemoizer?: boolean;
  mongoose?: boolean;
  runtimeNode?: boolean;
  socketIo?: boolean;
  tedious?: boolean;
  undici?: boolean;
  cassandra?: boolean;
  connect?: boolean;
  dns?: boolean;
  express?: boolean;
  fastify?: boolean;
  genericPool?: boolean;
  graphql?: boolean;
  hapi?: boolean;
  ioredis?: boolean;
  knex?: boolean;
  koa?: boolean;
  memcached?: boolean;
  mysql2?: boolean;
  nestjsCore?: boolean;
  net?: boolean;
  pino?: boolean;
  restify?: boolean;
  router?: boolean;
}

/**
 * SDK Stats Instrumentation and Feature Option interface
 * @internal
 */
export interface SdkStatsOption {
  option: string;
  value: boolean;
}

/**
 * Application Insights Web Instrumentation Configuration interface
 */
export interface BrowserSdkLoaderOptions {
  /** Browser SDK Loader Enable */
  enabled?: boolean;
  /** Browser SDK Loader Connection String */
  connectionString?: string;
}

export const AZURE_MONITOR_OPENTELEMETRY_VERSION = "1.16.0";
export const AZURE_MONITOR_STATSBEAT_FEATURES = "AZURE_MONITOR_STATSBEAT_FEATURES";
export const AZURE_MONITOR_PREFIX = "AZURE_MONITOR_PREFIX";
export const AZURE_MONITOR_AUTO_ATTACH = "AZURE_MONITOR_AUTO_ATTACH";
export const APPLICATION_INSIGHTS_SHIM_VERSION = "APPLICATION_INSIGHTS_SHIM_VERSION";

export enum AttachTypePrefix {
  INTEGRATED_AUTO = "i",
  MANUAL = "m",
}

/**
 * Default Browser SDK Loader Source
 * @internal
 */
export const BROWSER_SDK_LOADER_DEFAULT_SOURCE = "https://js.monitor.azure.com/scripts/b/ai";

/**
 * Default Breeze endpoint.
 * @internal
 */
export const DEFAULT_BREEZE_ENDPOINT = "https://dc.services.visualstudio.com";
/**
 * Default Live Metrics endpoint.
 * @internal
 */
export const DEFAULT_LIVEMETRICS_ENDPOINT = "https://global.livediagnostics.monitor.azure.com";

/**
 * Internal attribute name for sample rate
 * @internal
 */
export const AzureMonitorSampleRate = "microsoft.sample_rate";

/**
 * Disables customer-facing SDK Stats.
 * @internal
 */
export const APPLICATIONINSIGHTS_SDKSTATS_DISABLED = "APPLICATIONINSIGHTS_SDKSTATS_DISABLED";

export enum SdkStatsFeature {
  NONE = 0,
  DISK_RETRY = 1,
  AAD_HANDLING = 2,
  BROWSER_SDK_LOADER = 4,
  DISTRO = 8,
  LIVE_METRICS = 16,
  SHIM = 32,
  CUSTOMER_SDKSTATS = 64,
  MULTI_IKEY = 128,
  AKS_RESOURCE_DETECTOR_POPULATION = 256,
  A365 = 512,
  OTLP = 1024,
}

export enum SdkStatsInstrumentation {
  /** Azure Monitor Supported Instrumentations */
  NONE = 0,
  AZURE_CORE_TRACING = 1,
  MONGODB = 2,
  MYSQL = 4,
  REDIS = 8,
  POSTGRES = 16,
  BUNYAN = 32,
  WINSTON = 64,
  /** OpenTelemetry Supported Instrumentations */
  // Console instrumentation is not supported here - occupies 128
  CUCUMBER = 256,
  DATALOADER = 512,
  FS = 1024,
  LRU_MEMOIZER = 2048,
  MONGOOSE = 4096,
  RUNTIME_NODE = 8192,
  SOCKET_IO = 16384,
  TEDIOUS = 32768,
  UNDICI = 65536,
  CASSANDRA = 131072,
  CONNECT = 262144,
  DNS = 524288,
  EXPRESS = 1048576,
  FASTIFY = 2097152,
  GENERIC_POOL = 4194304,
  GRAPHQL = 8388608,
  HAPI = 16777216,
  IOREDIS = 33554432,
  KNEX = 67108864,
  KOA = 134217728,
  MEMCACHED = 268435456,
  MYSQL2 = 536870912,
  NESTJS_CORE = 1073741824,
  NET = 2147483648,
  PINO = 4294967296,
  RESTIFY = 8589934592,
  ROUTER = 17179869184,
  AMQPLIB = 34359738368,
}

/**
 * SDK Stats Instrumentation Mapping
 * @internal
 */
export const SdkStatsInstrumentationMap = new Map<string, number>([
  ["@opentelemetry/instrumentation-amqplib", SdkStatsInstrumentation.AMQPLIB],
  ["@opentelemetry/instrumentation-cucumber", SdkStatsInstrumentation.CUCUMBER],
  ["@opentelemetry/instrumentation-dataloader", SdkStatsInstrumentation.DATALOADER],
  ["@opentelemetry/instrumentation-fs", SdkStatsInstrumentation.FS],
  ["@opentelemetry/instrumentation-lru-memoizer", SdkStatsInstrumentation.LRU_MEMOIZER],
  ["@opentelemetry/instrumentation-mongoose", SdkStatsInstrumentation.MONGOOSE],
  ["@opentelemetry/instrumentation-runtime-node", SdkStatsInstrumentation.RUNTIME_NODE],
  ["@opentelemetry/instrumentation-socket.io", SdkStatsInstrumentation.SOCKET_IO],
  ["@opentelemetry/instrumentation-tedious", SdkStatsInstrumentation.TEDIOUS],
  ["@opentelemetry/instrumentation-undici", SdkStatsInstrumentation.UNDICI],
  ["@opentelemetry/instrumentation-cassandra-driver", SdkStatsInstrumentation.CASSANDRA],
  ["@opentelemetry/instrumentation-connect", SdkStatsInstrumentation.CONNECT],
  ["@opentelemetry/instrumentation-dns", SdkStatsInstrumentation.DNS],
  ["@opentelemetry/instrumentation-express", SdkStatsInstrumentation.EXPRESS],
  ["@opentelemetry/instrumentation-fastify", SdkStatsInstrumentation.FASTIFY],
  ["@opentelemetry/instrumentation-generic-pool", SdkStatsInstrumentation.GENERIC_POOL],
  ["@opentelemetry/instrumentation-graphql", SdkStatsInstrumentation.GRAPHQL],
  ["@opentelemetry/instrumentation-hapi", SdkStatsInstrumentation.HAPI],
  ["@opentelemetry/instrumentation-ioredis", SdkStatsInstrumentation.IOREDIS],
  ["@opentelemetry/instrumentation-knex", SdkStatsInstrumentation.KNEX],
  ["@opentelemetry/instrumentation-koa", SdkStatsInstrumentation.KOA],
  ["@opentelemetry/instrumentation-memcached", SdkStatsInstrumentation.MEMCACHED],
  ["@opentelemetry/instrumentation-mysql2", SdkStatsInstrumentation.MYSQL2],
  ["@opentelemetry/instrumentation-nestjs-core", SdkStatsInstrumentation.NESTJS_CORE],
  ["@opentelemetry/instrumentation-net", SdkStatsInstrumentation.NET],
  ["@opentelemetry/instrumentation-pino", SdkStatsInstrumentation.PINO],
  ["@opentelemetry/instrumentation-restify", SdkStatsInstrumentation.RESTIFY],
  ["@opentelemetry/instrumentation-router", SdkStatsInstrumentation.ROUTER],
]);

export interface SdkStatsEnvironmentConfig {
  instrumentation: SdkStatsInstrumentation;
  feature: SdkStatsFeature;
}
