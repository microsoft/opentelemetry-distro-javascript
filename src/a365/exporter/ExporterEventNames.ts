// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Event names used by Agent365Exporter for logging and monitoring.
 */
export enum ExporterEventNames {
  /** A full export operation (one call to `export()`). */
  EXPORT = "agent365-export",
  /** The export of a single (tenantId, agentId) span group. */
  EXPORT_GROUP = "export-group",
  /** A span was skipped during partitioning because it lacked identity attributes. */
  EXPORT_PARTITION_SPAN_MISSING_IDENTITY = "export-partition-span-missing-identity",
}
