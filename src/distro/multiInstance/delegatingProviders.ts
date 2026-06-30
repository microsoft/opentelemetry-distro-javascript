// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  Tracer,
  TracerProvider,
  Span,
  SpanOptions,
  Context,
  Meter,
  MeterProvider,
  MeterOptions,
  MetricOptions,
  BatchObservableCallback,
  Observable,
  Counter,
  UpDownCounter,
  Gauge,
  Histogram,
  ObservableGauge,
  ObservableCounter,
  ObservableUpDownCounter,
} from "@opentelemetry/api";
import { createNoopMeter, ProxyTracerProvider } from "@opentelemetry/api";
import type { Logger, LoggerProvider, LoggerOptions, LogRecord } from "@opentelemetry/api-logs";
import { NOOP_LOGGER } from "@opentelemetry/api-logs";

import { resolveInstanceProviders } from "./instanceRegistry.js";

// Shared fallbacks used when no instance is registered/resolved yet. They are
// no-ops so that early or out-of-band global API access never throws.
const NOOP_TRACER_PROVIDER = new ProxyTracerProvider();
const NOOP_METER = createNoopMeter();

/**
 * A Tracer that resolves the current instance's tracer on every call. Resolution
 * MUST be per-call (never cached) because the ambient instance changes with the
 * active context.
 */
class DelegatingTracer implements Tracer {
  constructor(
    private readonly name: string,
    private readonly version?: string,
    private readonly options?: { schemaUrl?: string },
  ) {}

  private delegate(): Tracer {
    const providers = resolveInstanceProviders();
    const provider: TracerProvider = providers?.tracerProvider ?? NOOP_TRACER_PROVIDER;
    return provider.getTracer(this.name, this.version, this.options);
  }

  startSpan(name: string, options?: SpanOptions, context?: Context): Span {
    return this.delegate().startSpan(name, options, context);
  }

  // The api defines several overloads for startActiveSpan; forward all args.
  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    context: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan(name: string, ...args: unknown[]): unknown {
    return (this.delegate().startActiveSpan as (...a: unknown[]) => unknown)(name, ...args);
  }
}

/**
 * Global parent TracerProvider registered once. It owns no pipeline itself; it
 * delegates to the resolved child instance's TracerProvider.
 */
export class ParentTracerProvider implements TracerProvider {
  getTracer(name: string, version?: string, options?: { schemaUrl?: string }): Tracer {
    return new DelegatingTracer(name, version, options);
  }
}

/** A Meter that resolves the current instance's meter on every instrument call. */
class DelegatingMeter implements Meter {
  constructor(
    private readonly name: string,
    private readonly version?: string,
    private readonly options?: MeterOptions,
  ) {}

  private delegate(): Meter {
    const providers = resolveInstanceProviders();
    const provider: MeterProvider | undefined = providers?.meterProvider;
    return provider ? provider.getMeter(this.name, this.version, this.options) : NOOP_METER;
  }

  createGauge(name: string, options?: MetricOptions): Gauge {
    return this.delegate().createGauge(name, options);
  }
  createHistogram(name: string, options?: MetricOptions): Histogram {
    return this.delegate().createHistogram(name, options);
  }
  createCounter(name: string, options?: MetricOptions): Counter {
    return this.delegate().createCounter(name, options);
  }
  createUpDownCounter(name: string, options?: MetricOptions): UpDownCounter {
    return this.delegate().createUpDownCounter(name, options);
  }
  createObservableGauge(name: string, options?: MetricOptions): ObservableGauge {
    return this.delegate().createObservableGauge(name, options);
  }
  createObservableCounter(name: string, options?: MetricOptions): ObservableCounter {
    return this.delegate().createObservableCounter(name, options);
  }
  createObservableUpDownCounter(name: string, options?: MetricOptions): ObservableUpDownCounter {
    return this.delegate().createObservableUpDownCounter(name, options);
  }
  addBatchObservableCallback(callback: BatchObservableCallback, observables: Observable[]): void {
    this.delegate().addBatchObservableCallback(callback, observables);
  }
  removeBatchObservableCallback(
    callback: BatchObservableCallback,
    observables: Observable[],
  ): void {
    this.delegate().removeBatchObservableCallback(callback, observables);
  }
}

/** Global parent MeterProvider registered once; delegates to the resolved child. */
export class ParentMeterProvider implements MeterProvider {
  getMeter(name: string, version?: string, options?: MeterOptions): Meter {
    return new DelegatingMeter(name, version, options);
  }
}

/** A Logger that resolves the current instance's logger on every emit. */
class DelegatingLogger implements Logger {
  constructor(
    private readonly name: string,
    private readonly version?: string,
    private readonly options?: LoggerOptions,
  ) {}

  private delegate(): Logger {
    const providers = resolveInstanceProviders();
    return providers
      ? providers.loggerProvider.getLogger(this.name, this.version, this.options)
      : NOOP_LOGGER;
  }

  emit(logRecord: LogRecord): void {
    this.delegate().emit(logRecord);
  }

  enabled(options?: Parameters<Logger["enabled"]>[0]): boolean {
    return this.delegate().enabled(options);
  }
}

/** Global parent LoggerProvider registered once; delegates to the resolved child. */
export class ParentLoggerProvider implements LoggerProvider {
  getLogger(name: string, version?: string, options?: LoggerOptions): Logger {
    return new DelegatingLogger(name, version, options);
  }
}
