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

/** Resource identifier details for an execute tool call. */
export interface ToolCallIdentifier {
  /** Identifier type. */
  type?: string;
  /** Identifier value. */
  value?: string;
  /** Provider-specific properties not defined by the schema. */
  [key: string]: unknown;
}

/** Container metadata for a resource reference. */
export interface ToolCallContainer {
  /** Container identifier. */
  id?: string;
  /** Container URI. */
  uri?: string;
  /** Container type. */
  type?: string;
  /** Provider-specific properties not defined by the schema. */
  [key: string]: unknown;
}

/** Resource metadata for an execute tool call. */
export interface ToolCallResource {
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
  /** Provider-specific properties not defined by the schema. */
  [key: string]: unknown;
}

/** Outcome details for an execute tool call result. */
export interface ToolCallResultOutcome {
  /** Whether the tool call succeeded or failed. */
  status?: ToolCallOutcomeStatus;
  /** Tool-specific result code. */
  code?: string;
  /** Provider-specific result code. */
  provider_code?: string;
  /** Human-readable outcome message. */
  message?: string;
  /** Provider-specific properties not defined by the schema. */
  [key: string]: unknown;
}

/** Sensitivity metadata for a tool call result. */
export interface ToolCallResultSensitivity {
  /** Sensitivity label identifier. */
  label_id?: string;
  /** Provider-specific properties not defined by the schema. */
  [key: string]: unknown;
}

/** Policy metadata for a tool call result. */
export interface ToolCallResultPolicy {
  /** Policy decision for the tool call. */
  decision?: ToolPolicyDecision;
  /** Policy identifier. */
  id?: string;
  /** Policy name. */
  name?: string;
  /** Provider-specific properties not defined by the schema. */
  [key: string]: unknown;
}

/** Security metadata for a tool call result. */
export interface ToolCallResultSecurity {
  /** Whether XPIA was detected. */
  xpia_detected?: boolean;
  /** Provider-specific properties not defined by the schema. */
  [key: string]: unknown;
}

/** Pagination metadata for a tool call result. */
export interface ToolCallResultPagination {
  /** Whether more results are available. */
  has_more?: boolean;
  /** Cursor for the next page of results. */
  next_cursor?: string;
  /** Total result count when known. */
  total_count?: number;
  /** Provider-specific properties not defined by the schema. */
  [key: string]: unknown;
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
export class ExecuteToolCallArguments {
  /** Provider-specific properties not defined by the schema. */
  [key: string]: unknown;

  /** Schema version for this payload. */
  schema_version: string;
  /** Resources referenced by the tool call. */
  resources?: ToolCallResource[];
  /** Requested action for the tool call. */
  action?: ToolCallAction;
  /** Tool parameters for the call. */
  parameters?: Record<string, unknown>;

  constructor(init: Partial<ExecuteToolCallArguments> = {}) {
    Object.assign(this, init);
    this.schema_version = init.schema_version ?? "1.0";
  }
}

/** Structured result for an execute tool call. */
export class ExecuteToolCallResult {
  /** Provider-specific properties not defined by the schema. */
  [key: string]: unknown;

  /** Schema version for this payload. */
  schema_version: string;
  /** Overall tool call outcome. */
  outcome?: ToolCallResultOutcome;
  /** Resources returned by the tool call. */
  resources?: ToolCallResultResource[];
  /** Tool result data. */
  data?: Record<string, unknown>;
  /** Pagination metadata for the result set. */
  pagination?: ToolCallResultPagination;

  constructor(init: Partial<ExecuteToolCallResult> = {}) {
    Object.assign(this, init);
    this.schema_version = init.schema_version ?? "1.0";
  }
}
