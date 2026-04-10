// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// TODO: Align truncation strategy across exporters. Currently there are two
// separate truncation mechanisms vendored from A365:
//   1. truncateValue() here — 8,192 char limit on individual span attribute values,
//      used by GenAI instrumentations (LangChain, OpenAI) before setting attributes.
//   2. truncateSpan() in _a365/exporter/utils.ts — 250KB limit on entire serialized
//      spans, used by Agent365Exporter before posting to the A365 service.
// These serve different purposes (attribute-level vs span-level) and target
// different exporter backends. Need to determine:
//   - What truncation Azure Monitor exporter expects/handles natively
//   - What truncation OTLP exporter expects/handles natively
//   - Whether attribute-level truncation should live in a shared location or
//     remain exporter-specific under _a365/
// For now, keeping this here since GenAI instrumentations need it regardless
// of which exporter is active.

/**
 * Maximum length for span attribute values.
 * Values exceeding this limit will be truncated with a suffix.
 */
export const MAX_ATTRIBUTE_LENGTH = 8_192;

const TRUNCATION_SUFFIX = "...[truncated]";

/**
 * Truncate a string value to {@link MAX_ATTRIBUTE_LENGTH} characters.
 * If the value exceeds the limit, it is trimmed and a truncation suffix is appended.
 * @param value The string to truncate
 * @returns The original string if within limits, otherwise the truncated string
 */
export function truncateValue(value: string): string {
  if (value.length > MAX_ATTRIBUTE_LENGTH) {
    return value.substring(0, MAX_ATTRIBUTE_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
  }
  return value;
}
