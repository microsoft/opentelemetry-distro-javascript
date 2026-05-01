// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Express app that sends traces, metrics, and logs to Microsoft Fabric
 * Real-Time Intelligence (or Azure Data Explorer) via an OpenTelemetry Collector.
 *
 * Set OTEL_EXPORTER_OTLP_ENDPOINT to point at your collector (default http://localhost:4318).
 */

import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";
import express from "express";

useMicrosoftOpenTelemetry();

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => {
  res.send("Hello from distro → Fabric!");
});

app.get("/weather", (_req, res) => {
  const forecasts = [
    { date: new Date().toISOString(), temperatureC: 22, summary: "Warm" },
    { date: new Date().toISOString(), temperatureC: 15, summary: "Cool" },
    { date: new Date().toISOString(), temperatureC: 30, summary: "Hot" },
  ];
  res.json(forecasts);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
