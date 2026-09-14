// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { expectTypeOf } from "vitest";
import { BaggageBuilder } from "@microsoft/opentelemetry";

interface InterfaceTypedCustomAttributes {
  alpha: number;
  beta: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- match the source-compatible public API surface
type PublicCustomAttributesArg = Record<string, any> | Iterable<[string, any]> | null | undefined;

type CustomAttributesArg = Parameters<BaggageBuilder["customAttributes"]>[0];

expectTypeOf<CustomAttributesArg>().toEqualTypeOf<PublicCustomAttributesArg>();

const builder = new BaggageBuilder();
const pairs: InterfaceTypedCustomAttributes = {
  alpha: 1,
  beta: "two",
};

expectTypeOf(builder.customAttributes(pairs)).toEqualTypeOf<BaggageBuilder>();
