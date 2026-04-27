// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Simple ESM sample that exercises the Microsoft OpenTelemetry distro loader.
 * This file is run by the ESM loader integration test to verify that the
 * loader subpath can be imported under ESM without throwing.
 */

// Import the loader subpath to trigger registration
import "@microsoft/opentelemetry/loader";

console.log("ESM loader integration test passed");
