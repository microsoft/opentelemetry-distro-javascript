// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * ESM loader entry point for Microsoft OpenTelemetry distro.
 *
 * For ESM applications, this loader should be preloaded with the --import flag
 * so OpenTelemetry import hooks are registered before application modules load.
 *
 * Usage: node --import @microsoft/opentelemetry/loader <your-app-entry-point>
 */

// Reuse the shared loader registration implementation so this entrypoint stays
// in sync with the Azure Monitor loader behavior.
import "../azureMonitor/loader.js";
