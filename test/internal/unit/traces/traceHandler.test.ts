// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TraceHandler } from "../../../../src/azureMonitor/traces/index.js";
import { MetricHandler } from "../../../../src/azureMonitor/metrics/index.js";
import { InternalConfig } from "../../../../src/shared/index.js";
import { ApplicationInsightsSampler } from "../../../../src/azureMonitor/traces/sampler.js";
import { createSampler, createInstrumentations } from "../../../../src/distro/instrumentations.js";
import { ignoreOutgoingRequestHook } from "../../../../src/azureMonitor/utils/common.js";
import {
  HttpInstrumentation,
  type HttpInstrumentationConfig,
} from "@opentelemetry/instrumentation-http";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AlwaysOnSampler } from "@opentelemetry/sdk-trace-base";
import type { Span } from "@opentelemetry/api";
import { metrics, trace, SpanKind } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { MockInstance } from "vitest";
import {
  expect,
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  it,
  afterAll,
  vi,
} from "vitest";
import type Http from "node:http";
import { ExportResultCode } from "@opentelemetry/core";
import type { AzureMonitorTraceExporter } from "@azure/monitor-opentelemetry-exporter";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import { RateLimitedSampler } from "@azure/monitor-opentelemetry-exporter";

describe("Library/TraceHandler", () => {
  const connectionString = "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333";
  let http: typeof Http | null = null;

  let _config: InternalConfig;
  let handler: TraceHandler;
  let metricHandler: MetricHandler;
  let mockHttpServer: ReturnType<typeof Http.createServer> | undefined;
  const mockHttpServerPort = 8085;
  let tracerProvider: NodeTracerProvider;
  let exportSpy: MockInstance<AzureMonitorTraceExporter["export"]>;
  let activeInstrumentations: Instrumentation[] = [];

  beforeEach(() => {
    _config = new InternalConfig();
    _config.azureMonitorExporterOptions = {
      connectionString,
    };
  });

  beforeAll(async () => {
    await new Promise((resolve) => {
      if (!http) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        http = require("http");
      }
      mockHttpServer = http?.createServer((req, res) => {
        console.log(
          `[${new Date().toISOString()}] Mock server received request: ${req.method} ${req.url}`,
        );
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.write(JSON.stringify({ success: true }));
        res.end();
      });
      mockHttpServer?.listen(mockHttpServerPort, () => {
        console.log(`Mock server is listening on port ${mockHttpServerPort}`);
        resolve(null);
      });
    });
  });

  afterAll(async () => {
    if (mockHttpServer) {
      await new Promise((resolve) => {
        mockHttpServer?.closeAllConnections();
        mockHttpServer?.close(() => {
          console.log("Mock server closed");
          resolve(null);
        });
      });
    }
    trace.disable();
  });

  afterEach(async () => {
    if (tracerProvider) {
      await tracerProvider.shutdown();
    }
    trace.disable();
    activeInstrumentations.forEach((instrumentation) => instrumentation.disable());
    activeInstrumentations = [];
    if (metricHandler) {
      await metricHandler.shutdown();
    }
    if (handler) {
      await handler.shutdown();
    }
    metrics.disable();
    vi.restoreAllMocks();
  });

  describe("sampler selection", () => {
    beforeEach(() => {
      _config.instrumentationOptions = {
        http: { enabled: false },
        azureSdk: { enabled: false },
        mongoDb: { enabled: false },
        mySql: { enabled: false },
        postgreSql: { enabled: false },
        redis: { enabled: false },
        redis4: { enabled: false },
      };
    });

    it("prefers sampler provided by env/config", () => {
      const customSampler = new AlwaysOnSampler();
      _config.sampler = customSampler;
      _config.tracesPerSecond = 10;
      _config.samplingRatio = 0.25;

      expect(createSampler(_config)).toBe(customSampler);
    });

    it("falls back to rate-limited sampler when tracesPerSecond is set", () => {
      _config.tracesPerSecond = 7;
      _config.samplingRatio = 0.5;

      expect(createSampler(_config)).toBeInstanceOf(RateLimitedSampler);
    });

    it("uses ApplicationInsightsSampler when tracesPerSecond is 0", () => {
      _config.tracesPerSecond = 0;
      _config.samplingRatio = 0.3;

      const sampler = createSampler(_config);
      expect(sampler).toBeInstanceOf(ApplicationInsightsSampler);
      expect(sampler.toString()).toBe("ApplicationInsightsSampler{0.3}");
    });

    it("uses ApplicationInsightsSampler with ratio 1 when tracesPerSecond is 0 and samplingRatio is default", () => {
      _config.tracesPerSecond = 0;
      // samplingRatio defaults to 1 from InternalConfig constructor

      const sampler = createSampler(_config);
      expect(sampler).toBeInstanceOf(ApplicationInsightsSampler);
      expect(sampler.toString()).toBe("ApplicationInsightsSampler{1}");
    });

    it("uses RateLimitedSampler by default with tracesPerSecond=5", () => {
      // Default config has tracesPerSecond=5
      expect(createSampler(_config)).toBeInstanceOf(RateLimitedSampler);
    });

    it("uses ApplicationInsightsSampler when tracesPerSecond is explicitly undefined", () => {
      _config.tracesPerSecond = undefined;
      _config.samplingRatio = 0.2;

      const sampler = createSampler(_config);
      expect(sampler).toBeInstanceOf(ApplicationInsightsSampler);
      expect(sampler.toString()).toBe("ApplicationInsightsSampler{0.2}");
    });
  });

  function createHandler(httpConfig: HttpInstrumentationConfig) {
    _config.instrumentationOptions.http = httpConfig;
    metricHandler = new MetricHandler(_config);
    handler = new TraceHandler(_config, metricHandler);
    createInstrumentations(_config, { filterAzureMonitorRequests: true }).forEach(
      (instrumentation) => {
        instrumentation.enable();
        activeInstrumentations.push(instrumentation);
      },
    );

    // Because the instrumentation is registered globally, its config is not updated
    // when the handler is created. We need to mock the getConfig method to return
    // the updated config.
    vi.spyOn(HttpInstrumentation.prototype, "getConfig").mockImplementation(() => {
      return httpConfig;
    });

    exportSpy = vi
      .spyOn(handler["_azureExporter"], "export")
      .mockImplementation((spans: any, resultCallback: any) => {
        console.log(
          "in fake, export called, here is the stack trace (there's no error)",
          new Error().stack,
        );
        return new Promise((resolve) => {
          resultCallback({
            code: ExportResultCode.SUCCESS,
          });
          resolve(spans);
        });
      });

    // Load Http modules, HTTP instrumentation hook will be created in OpenTelemetry
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("http");
  }

  async function makeHttpRequest() {
    const options = {
      hostname: "localhost",
      port: mockHttpServerPort,
      path: "/test",
      method: "GET",
    };
    return new Promise<void>((resolve, reject) => {
      const req = http!.request(options, (res: any) => {
        res.on("data", function () {});
        res.on("end", () => {
          resolve();
        });
      });
      req.on("error", (error: Error) => {
        reject(error);
      });
      req.end();
    });
  }

  const customSpanProcessor: SpanProcessor = {
    forceFlush: () => {
      return Promise.resolve();
    },
    onStart: (span: Span) => {
      span.setAttribute("startAttribute", "SomeValue");
    },
    onEnd: (span: ReadableSpan) => {
      span.attributes["endAttribute"] = "SomeValue2";
    },
    shutdown: () => {
      return Promise.resolve();
    },
  };

  describe("#autoCollection of HTTP/HTTPS requests", () => {
    beforeEach(() => {
      _config.instrumentationOptions = {
        http: { enabled: true },
        azureSdk: { enabled: false },
        mongoDb: { enabled: false },
        mySql: { enabled: false },
        postgreSql: { enabled: false },
        redis: { enabled: false },
        redis4: { enabled: false },
      };
    });

    it("http outgoing/incoming requests & custom span processor", async () => {
      createHandler({ enabled: true });
      tracerProvider = new NodeTracerProvider({
        spanProcessors: [
          handler.getAzureMonitorSpanProcessor(),
          customSpanProcessor,
          handler.getBatchSpanProcessor(),
        ],
      });
      trace.setGlobalTracerProvider(tracerProvider);
      activeInstrumentations.forEach((instrumentation) => {
        instrumentation.setTracerProvider(tracerProvider);
      });
      await makeHttpRequest();
      await tracerProvider.forceFlush();
      expect(exportSpy).toHaveBeenCalled();
      // Filter spans to only those from our test request (with custom attributes from our customSpanProcessor)
      // `@opentelemetry/instrumentation-http` >= 0.221.0 emits stable HTTP semantic
      // conventions only: server spans carry `url.path`, client spans carry `url.full`.
      const allSpans = exportSpy.mock.calls.flatMap((call) => call[0]);
      const spans = allSpans.filter(
        (span: ReadableSpan) =>
          span.attributes["startAttribute"] === "SomeValue" &&
          (span.attributes["url.path"] === "/test" ||
            span.attributes["url.full"] === `http://localhost:${mockHttpServerPort}/test`),
      );
      expect(spans.length).toBe(2);
      assert.deepStrictEqual(spans.length, 2);
      const incoming = spans.find(
        (span: ReadableSpan) => span.kind === SpanKind.SERVER,
      ) as ReadableSpan;
      const outgoing = spans.find(
        (span: ReadableSpan) => span.kind === SpanKind.CLIENT,
      ) as ReadableSpan;
      // Incoming request
      assert.isDefined(incoming);
      assert.deepStrictEqual(incoming.name, "GET");
      assert.deepStrictEqual(
        incoming.instrumentationScope.name,
        "@opentelemetry/instrumentation-http",
      );
      assert.deepStrictEqual(incoming.status.code, 0, "Span Success"); // Success
      assert.isDefined(incoming.startTime);
      assert.isDefined(incoming.endTime);
      assert.deepStrictEqual(incoming.attributes["http.request.method"], "GET");
      assert.deepStrictEqual(incoming.attributes["http.response.status_code"], 200);
      assert.deepStrictEqual(incoming.attributes["url.path"], "/test");
      assert.deepStrictEqual(incoming.attributes["url.scheme"], "http");
      assert.deepStrictEqual(incoming.attributes["server.address"], "localhost");
      assert.deepStrictEqual(incoming.attributes["server.port"], mockHttpServerPort);
      // Outgoing request
      assert.isDefined(outgoing);
      assert.deepStrictEqual(outgoing.name, "GET");
      assert.deepStrictEqual(
        outgoing.instrumentationScope.name,
        "@opentelemetry/instrumentation-http",
      );
      assert.deepStrictEqual(outgoing.status.code, 0, "Span Success"); // Success
      assert.isDefined(outgoing.startTime);
      assert.isDefined(outgoing.endTime);
      assert.deepStrictEqual(outgoing.attributes["http.request.method"], "GET");
      assert.deepStrictEqual(outgoing.attributes["http.response.status_code"], 200);
      assert.deepStrictEqual(
        outgoing.attributes["url.full"],
        `http://localhost:${mockHttpServerPort}/test`,
      );
      assert.deepStrictEqual(outgoing.attributes["server.address"], "localhost");
      assert.deepStrictEqual(outgoing.attributes["server.port"], mockHttpServerPort);
      assert.notDeepEqual(incoming.spanContext().spanId, outgoing.spanContext().spanId);
      // Incoming request
      assert.deepStrictEqual(incoming.attributes["startAttribute"], "SomeValue");
      assert.deepStrictEqual(incoming.attributes["endAttribute"], "SomeValue2");
      // Outgoing request
      assert.deepStrictEqual(outgoing.attributes["startAttribute"], "SomeValue");
      assert.deepStrictEqual(outgoing.attributes["endAttribute"], "SomeValue2");

      // Check if the spans are processed by the metric extractors
      // Incoming request
      assert.deepStrictEqual(
        incoming.attributes["_MS.ProcessedByMetricExtractors"],
        "(Name:'Requests', Ver:'1.1')",
      );
      // Outgoing request
      assert.deepStrictEqual(
        outgoing.attributes["_MS.ProcessedByMetricExtractors"],
        "(Name:'Dependencies', Ver:'1.1')",
      );
    });

    it("http should not track if instrumentations are disabled", () => {
      // Disable all instrumentations
      _config.instrumentationOptions = {
        http: { enabled: false },
        azureSdk: { enabled: false },
        mongoDb: { enabled: false },
        mySql: { enabled: false },
        postgreSql: { enabled: false },
        redis: { enabled: false },
        redis4: { enabled: false },
      };
      metricHandler = new MetricHandler(_config);
      handler = new TraceHandler(_config, metricHandler);
      const instrumentations = createInstrumentations(_config);
      expect(instrumentations).toHaveLength(0);
      expect(instrumentations[0]).not.toBeInstanceOf(HttpInstrumentation);
    });

    it("the trace handler does not create instrumentations", () => {
      metricHandler = new MetricHandler(_config);
      handler = new TraceHandler(_config, metricHandler);
      const held = Object.values(handler as unknown as Record<string, unknown>)
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .filter(
          (value) => typeof value === "object" && value !== null && "instrumentationName" in value,
        );
      expect(held).toEqual([]);
    });

    it("applies the Azure Monitor outgoing request filter exactly once", () => {
      const countingRequest = () => {
        let reads = 0;
        const request = {} as Http.RequestOptions;
        Object.defineProperty(request, "headers", {
          get() {
            reads++;
            return { "user-agent": "curl/8.0" };
          },
        });
        return { request, reads: () => reads };
      };

      const buildHook = (
        withHandler: boolean,
        userHook: HttpInstrumentationConfig["ignoreOutgoingRequestHook"],
      ) => {
        const config = new InternalConfig();
        config.azureMonitorExporterOptions.connectionString =
          "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333";
        config.instrumentationOptions.http = {
          enabled: true,
          ignoreOutgoingRequestHook: userHook,
        } as HttpInstrumentationConfig;
        createInstrumentations(config, { filterAzureMonitorRequests: true });
        if (withHandler) {
          metricHandler = new MetricHandler(config);
          handler = new TraceHandler(config, metricHandler);
        }
        return (config.instrumentationOptions.http as HttpInstrumentationConfig)
          .ignoreOutgoingRequestHook!;
      };

      const baselineHook = buildHook(false, () => false);
      const baseline = countingRequest();
      baselineHook(baseline.request);

      const userHook = vi.fn().mockReturnValue(false);
      const hook = buildHook(true, userHook);

      expect(
        hook({ headers: { "user-agent": "azsdk-js-monitor-opentelemetry-exporter/1.0" } }),
      ).toBe(true);
      expect(userHook).not.toHaveBeenCalled();

      expect(
        hook({
          hostname: "169.254.169.254",
          method: "GET",
          port: "",
          path: "/metadata/instance/compute?api-version=2017-12-01&format=json",
        }),
      ).toBe(true);
      expect(userHook).not.toHaveBeenCalled();

      const actual = countingRequest();
      expect(hook(actual.request)).toBe(false);
      expect(userHook).toHaveBeenCalledTimes(1);
      expect(actual.reads()).toBe(baseline.reads());
    });
  });
});

describe("SDK stats metadata request filtering", () => {
  const metadataRequest: Http.RequestOptions = {
    hostname: "169.254.169.254",
    method: "GET",
    port: "",
    path: "/metadata/instance/compute?api-version=2017-12-01&format=json",
  };

  it("filters SDK stats metadata with either hostname or host and reordered query parameters", () => {
    expect(ignoreOutgoingRequestHook(metadataRequest)).toBe(true);
    expect(ignoreOutgoingRequestHook({ ...metadataRequest, port: undefined })).toBe(true);
    expect(
      ignoreOutgoingRequestHook({
        ...metadataRequest,
        hostname: undefined,
        host: "169.254.169.254",
        port: 80,
        path: "/metadata/instance/compute?format=json&api-version=2017-12-01",
      }),
    ).toBe(true);
  });

  it.each<Http.RequestOptions>([
    { hostname: "example.com" },
    { hostname: "169.254.169.254.example.com" },
    { method: "POST" },
    { protocol: "https:" },
    { port: 8080 },
    { path: "/metadata/identity/oauth2/token?api-version=2017-12-01&format=json" },
    { path: "/metadata/instance/compute?api-version=2021-12-13&format=json" },
    { path: "/metadata/instance/compute?api-version=2017-12-01&format=text" },
    { path: undefined },
  ])("does not filter other application requests: %j", (overrides) => {
    expect(ignoreOutgoingRequestHook({ ...metadataRequest, ...overrides })).toBe(false);
  });
});
