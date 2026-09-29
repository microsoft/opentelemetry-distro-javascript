// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Action requested by an execute tool call. */
export enum ToolCallAction {
  /** Create a resource. */
  CREATE = "create",
  /** Read a resource. */
  READ = "read",
  /** Update a resource. */
  UPDATE = "update",
  /** Delete a resource. */
  DELETE = "delete",
}

/** Outcome status reported for an execute tool call result. */
export enum ToolCallOutcomeStatus {
  /** The tool call completed successfully. */
  SUCCESS = "success",
  /** The tool call failed. */
  FAILURE = "failure",
}

/** Policy decision recorded for an execute tool call result. */
export enum ToolPolicyDecision {
  /** The policy allows the tool call. */
  ALLOW = "allow",
  /** The policy denies the tool call. */
  DENY = "deny",
}

/** Provider-specific properties not defined by an execute tool schema model. */
export interface ToolCallExtensionData {
  /** Properties serialized under the `metadata` wire field. */
  extension_data?: Record<string, unknown>;
}

/** Resource identifier details for an execute tool call. */
export interface ToolCallIdentifier extends ToolCallExtensionData {
  /** Identifier type. */
  type?: string;
  /** Identifier value. */
  value?: string;
}

/** Container metadata for a resource reference. */
export interface ToolCallContainer extends ToolCallExtensionData {
  /** Container identifier. */
  id?: string;
  /** Container URI. */
  uri?: string;
  /** Container type. */
  type?: string;
}

/** Resource metadata for an execute tool call. */
export interface ToolCallResource extends ToolCallExtensionData {
  /** Resource identifier. */
  id?: string;
  /** Resource URI. */
  uri?: string;
  /** Resource name. */
  name?: string;
  /** Resource type. */
  type?: string;
  /** Resource provider. */
  provider?: string;
  /** Provider-specific identifiers for the resource. */
  identifiers?: ToolCallIdentifier[];
  /** Container that owns the resource. */
  container?: ToolCallContainer;
}

/** Outcome details for an execute tool call result. */
export interface ToolCallResultOutcome extends ToolCallExtensionData {
  /** Whether the tool call succeeded or failed. */
  status?: ToolCallOutcomeStatus;
  /** Tool-specific result code. */
  code?: string;
  /** Provider-specific result code. */
  provider_code?: string;
  /** Human-readable outcome message. */
  message?: string;
}

/** Sensitivity metadata for a tool call result. */
export interface ToolCallResultSensitivity extends ToolCallExtensionData {
  /** Sensitivity label identifier. */
  label_id?: string;
}

/** Policy metadata for a tool call result. */
export interface ToolCallResultPolicy extends ToolCallExtensionData {
  /** Policy decision for the tool call. */
  decision?: ToolPolicyDecision;
  /** Policy identifier. */
  id?: string;
  /** Policy name. */
  name?: string;
}

/** Security metadata for a tool call result. */
export interface ToolCallResultSecurity extends ToolCallExtensionData {
  /** Whether XPIA was detected. */
  xpia_detected?: boolean;
}

/** Pagination metadata for a tool call result. */
export interface ToolCallResultPagination extends ToolCallExtensionData {
  /** Whether more results are available. */
  has_more?: boolean;
  /** Cursor for the next page of results. */
  next_cursor?: string;
  /** Total result count when known. */
  total_count?: number;
}

/** Resource payload returned by an execute tool call. */
export interface ToolCallResultResource extends ToolCallResource {
  /** Outcome for this resource. */
  outcome?: ToolCallResultOutcome;
  /** Sensitivity metadata for this resource. */
  sensitivity?: ToolCallResultSensitivity;
  /** Policy metadata for this resource. */
  policy?: ToolCallResultPolicy;
  /** Security metadata for this resource. */
  security?: ToolCallResultSecurity;
  /** Resource-specific result data. */
  data?: Record<string, unknown>;
}

/** Structured arguments for an execute tool call. */
export class ExecuteToolCallArguments implements ToolCallExtensionData {
  /** Schema version for this payload. */
  declare schema_version: string;
  /** Resources referenced by the tool call. */
  declare resources?: ToolCallResource[];
  /** Requested action for the tool call. */
  declare action?: ToolCallAction;
  /** Tool parameters for the call. */
  declare parameters?: Record<string, unknown>;
  /** Provider-specific properties serialized under `metadata`. */
  declare extension_data?: Record<string, unknown>;

  constructor(init: Partial<ExecuteToolCallArguments> = {}) {
    this.schema_version = init.schema_version ?? "1.0";
    if (init.resources !== undefined) this.resources = init.resources;
    if (init.action !== undefined) this.action = init.action;
    if (init.parameters !== undefined) this.parameters = init.parameters;
    if (init.extension_data !== undefined) this.extension_data = init.extension_data;
  }
}

/** Structured result for an execute tool call. */
export class ExecuteToolCallResult implements ToolCallExtensionData {
  /** Schema version for this payload. */
  declare schema_version: string;
  /** Overall tool call outcome. */
  declare outcome?: ToolCallResultOutcome;
  /** Resources returned by the tool call. */
  declare resources?: ToolCallResultResource[];
  /** Tool result data. */
  declare data?: Record<string, unknown>;
  /** Pagination metadata for the result set. */
  declare pagination?: ToolCallResultPagination;
  /** Provider-specific properties serialized under `metadata`. */
  declare extension_data?: Record<string, unknown>;

  constructor(init: Partial<ExecuteToolCallResult> = {}) {
    this.schema_version = init.schema_version ?? "1.0";
    if (init.outcome !== undefined) this.outcome = init.outcome;
    if (init.resources !== undefined) this.resources = init.resources;
    if (init.data !== undefined) this.data = init.data;
    if (init.pagination !== undefined) this.pagination = init.pagination;
    if (init.extension_data !== undefined) this.extension_data = init.extension_data;
  }
}
