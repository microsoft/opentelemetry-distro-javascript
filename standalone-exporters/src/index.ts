/**
 * @a365/otel-exporter
 *
 * A365 (Agent 365) OpenTelemetry SpanExporter for Node.js.
 * Exports spans to the Agent 365 Observability Service endpoint.
 *
 * Usage: Add A365SpanExporter to your existing TracerProvider as an
 * additional exporter. Tag spans with tenant_id and agent_id attributes
 * (or use the BaggageBuilder / setA365SpanAttributes helpers).
 */

export {
  A365SpanExporter,
  A365ExporterOptions,
} from './exporter';

export {
  BaggageBuilder,
  setA365SpanAttributes,
  A365_ATTR_TENANT_ID,
  A365_ATTR_AGENT_ID,
  A365_ATTR_CONVERSATION_ID,
} from './baggage';

export {
  TokenResolver,
  createAzureIdentityResolver,
  createMsalResolver,
  MsalResolverConfig,
} from './auth';
