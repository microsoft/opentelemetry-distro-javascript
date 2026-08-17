// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawn } from "node:child_process";
import { win32 } from "node:path";

const WINDOWS_DRIVE_QUALIFIED_ABSOLUTE_PATH = /^[a-z]:[\\/]/i;
const BUILTIN_ADMINISTRATORS_SID = "*S-1-5-32-544";
const MAX_WHOAMI_OUTPUT_BYTES = 512;

export interface DirectoryAccessControl {
  hardenDirectory(directory: string): Promise<void>;
}

export interface WindowsCommandOptions {
  captureStdout?: boolean;
  maxStdoutBytes?: number;
}

export interface WindowsCommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout?: string;
  stdoutTruncated?: boolean;
}

export interface WindowsCommandExecutor {
  run(
    executable: string,
    args: readonly string[],
    options: WindowsCommandOptions,
  ): Promise<WindowsCommandResult>;
}

export interface WindowsFileAccessControlOptions {
  commandExecutor?: WindowsCommandExecutor;
  systemRoot?: string;
}

export function getWindowsSystemExecutable(
  systemRoot: string | undefined,
  ...segments: string[]
): string {
  if (!systemRoot || !WINDOWS_DRIVE_QUALIFIED_ABSOLUTE_PATH.test(systemRoot)) {
    throw new Error("A trusted Windows system executable path could not be established.");
  }

  return win32.join(systemRoot, ...segments);
}

export class WindowsFileAccessControl implements DirectoryAccessControl {
  private readonly inFlightDirectories = new Map<string, Promise<void>>();
  private readonly commandExecutor: WindowsCommandExecutor;
  private identityPromise: Promise<string> | undefined;

  public constructor(options: WindowsFileAccessControlOptions = {}) {
    this.commandExecutor = options.commandExecutor ?? new SpawnWindowsCommandExecutor();
    this.systemRoot = options.systemRoot;
  }

  private readonly systemRoot: string | undefined;

  public async hardenDirectory(directory: string): Promise<void> {
    const inFlight = this.inFlightDirectories.get(directory);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const applyPromise = this.applyAcl(directory).finally(() => {
      this.inFlightDirectories.delete(directory);
    });

    this.inFlightDirectories.set(directory, applyPromise);
    return applyPromise;
  }

  private async applyAcl(directory: string): Promise<void> {
    const identity = await this.getCurrentIdentity();
    const icacls = this.getTrustedExecutable("System32", "icacls.exe");

    await this.runTrustedCommand(icacls, [directory, "/reset", "/L"], {});
    await this.runTrustedCommand(
      icacls,
      [
        directory,
        "/inheritance:r",
        "/grant:r",
        `${BUILTIN_ADMINISTRATORS_SID}:(OI)(CI)F`,
        "/grant:r",
        `${identity}:(OI)(CI)F`,
        "/L",
      ],
      {},
    );
    await this.runTrustedCommand(
      icacls,
      [win32.join(directory, "*"), "/reset", "/T", "/C", "/L"],
      {},
    );
  }

  private getTrustedExecutable(...segments: string[]): string {
    return getWindowsSystemExecutable(
      this.systemRoot ?? process.env.SystemRoot ?? process.env.SYSTEMROOT,
      ...segments,
    );
  }

  private async getCurrentIdentity(): Promise<string> {
    this.identityPromise ??= this.resolveCurrentIdentity().catch((error) => {
      this.identityPromise = undefined;
      throw error;
    });

    return this.identityPromise;
  }

  private async resolveCurrentIdentity(): Promise<string> {
    const whoami = this.getTrustedExecutable("System32", "whoami.exe");
    const result = await this.runTrustedCommand(whoami, [], {
      captureStdout: true,
      maxStdoutBytes: MAX_WHOAMI_OUTPUT_BYTES,
    });
    const identity = result.stdout?.trim() ?? "";

    if (identity.length === 0 || identity.includes("\r") || identity.includes("\n")) {
      throw new Error(
        `Trusted Windows command ${trustedCommandName(whoami)} produced invalid output.`,
      );
    }

    return identity;
  }

  private async runTrustedCommand(
    executable: string,
    args: readonly string[],
    options: WindowsCommandOptions,
  ): Promise<WindowsCommandResult> {
    let result: WindowsCommandResult;
    try {
      result = await this.commandExecutor.run(executable, args, options);
    } catch (error) {
      throw new Error(
        `Trusted Windows command ${trustedCommandName(executable)} failed to launch (${safeErrorDetail(error)}).`,
        { cause: error },
      );
    }

    if (result.stdoutTruncated) {
      throw new Error(
        `Trusted Windows command ${trustedCommandName(executable)} produced unexpected output.`,
      );
    }

    if (result.status !== 0) {
      throw new Error(
        `Trusted Windows command ${trustedCommandName(executable)} failed (${safeStatusDetail(result)}).`,
      );
    }

    return result;
  }
}

class SpawnWindowsCommandExecutor implements WindowsCommandExecutor {
  public run(
    executable: string,
    args: readonly string[],
    options: WindowsCommandOptions,
  ): Promise<WindowsCommandResult> {
    const captureStdout = options.captureStdout === true;
    const maxStdoutBytes = options.maxStdoutBytes ?? MAX_WHOAMI_OUTPUT_BYTES;

    return new Promise((resolve, reject) => {
      let settled = false;
      let child: ReturnType<typeof spawn>;

      try {
        child = spawn(executable, [...args], {
          windowsHide: true,
          stdio: captureStdout ? ["ignore", "pipe", "ignore"] : ["ignore", "ignore", "ignore"],
        });
      } catch (error) {
        reject(error);
        return;
      }

      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stdoutTruncated = false;

      if (captureStdout) {
        child.stdout?.on("data", (chunk: Buffer | string) => {
          if (stdoutTruncated) {
            return;
          }

          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remainingBytes = maxStdoutBytes - stdoutBytes;
          if (remainingBytes <= 0) {
            stdoutTruncated = true;
            return;
          }

          if (buffer.length > remainingBytes) {
            stdoutChunks.push(buffer.subarray(0, remainingBytes));
            stdoutBytes += remainingBytes;
            stdoutTruncated = true;
            return;
          }

          stdoutChunks.push(buffer);
          stdoutBytes += buffer.length;
        });
      }

      child.once("error", (error) => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      });

      child.once("close", (status, signal) => {
        if (settled) {
          return;
        }

        settled = true;
        resolve({
          status,
          signal: signal ?? null,
          stdout: captureStdout ? Buffer.concat(stdoutChunks).toString("utf8") : undefined,
          stdoutTruncated,
        });
      });
    });
  }
}

function trustedCommandName(executable: string): string {
  return win32.basename(executable);
}

function safeErrorDetail(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code.length > 0 ? code : "unknown";
}

function safeStatusDetail(result: WindowsCommandResult): string {
  if (result.status !== null) {
    return `exit status ${result.status}`;
  }

  return `signal ${result.signal ?? "unknown"}`;
}
