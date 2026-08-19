// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";

type CommandResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout?: string;
  stdoutTruncated?: boolean;
};

type CommandCall = {
  executable: string;
  args: string[];
  options: {
    captureStdout?: boolean;
    maxStdoutBytes?: number;
  };
};

async function loadModule() {
  return import("../../../../src/a365/exporter/durable/WindowsFileAccessControl.js");
}

function makeCommandExecutor(
  implementation: (
    executable: string,
    args: readonly string[],
    options: {
      captureStdout?: boolean;
      maxStdoutBytes?: number;
    },
  ) => Promise<CommandResult>,
) {
  return {
    run: vi.fn(implementation),
  };
}

describe("WindowsFileAccessControl", () => {
  it("resolves trusted executables only under a drive-qualified system root", async () => {
    const { getWindowsSystemExecutable } = await loadModule();

    expect(getWindowsSystemExecutable("C:\\Windows", "System32", "icacls.exe")).toBe(
      win32.join("C:\\Windows", "System32", "icacls.exe"),
    );
  });

  it.each([undefined, "", "Windows", "C:Windows", "\\Windows", "\\\\server\\share\\Windows"])(
    "rejects invalid SystemRoot values (%p)",
    async (systemRoot) => {
      const { getWindowsSystemExecutable } = await loadModule();

      expect(() => getWindowsSystemExecutable(systemRoot, "System32", "icacls.exe")).toThrow(
        /trusted Windows system executable path/i,
      );
    },
  );

  it("resolves the current identity and reapplies restrictive icacls rules", async () => {
    const { WindowsFileAccessControl } = await loadModule();
    const calls: CommandCall[] = [];
    const executor = makeCommandExecutor(async (executable, args, options) => {
      calls.push({ executable, args: [...args], options: { ...options } });

      if (executable.endsWith("whoami.exe")) {
        return {
          status: 0,
          signal: null,
          stdout: "CONTOSO\\Agent User\r\n",
        };
      }

      return {
        status: 0,
        signal: null,
      };
    });
    const accessControl = new WindowsFileAccessControl({
      commandExecutor: executor,
      systemRoot: "C:\\Windows",
    });
    const directory = "C:\\durable\\storage";

    await accessControl.hardenDirectory(directory);
    await accessControl.hardenDirectory(directory);

    expect(calls).toEqual([
      {
        executable: win32.join("C:\\Windows", "System32", "whoami.exe"),
        args: [],
        options: {
          captureStdout: true,
          maxStdoutBytes: 512,
        },
      },
      {
        executable: win32.join("C:\\Windows", "System32", "icacls.exe"),
        args: [directory, "/reset", "/L"],
        options: {},
      },
      {
        executable: win32.join("C:\\Windows", "System32", "icacls.exe"),
        args: [
          directory,
          "/inheritance:r",
          "/grant:r",
          "*S-1-5-32-544:(OI)(CI)F",
          "/grant:r",
          "CONTOSO\\Agent User:(OI)(CI)F",
          "/L",
        ],
        options: {},
      },
      {
        executable: win32.join("C:\\Windows", "System32", "icacls.exe"),
        args: [win32.join(directory, "*"), "/reset", "/T", "/C", "/L"],
        options: {},
      },
      {
        executable: win32.join("C:\\Windows", "System32", "icacls.exe"),
        args: [directory, "/reset", "/L"],
        options: {},
      },
      {
        executable: win32.join("C:\\Windows", "System32", "icacls.exe"),
        args: [
          directory,
          "/inheritance:r",
          "/grant:r",
          "*S-1-5-32-544:(OI)(CI)F",
          "/grant:r",
          "CONTOSO\\Agent User:(OI)(CI)F",
          "/L",
        ],
        options: {},
      },
      {
        executable: win32.join("C:\\Windows", "System32", "icacls.exe"),
        args: [win32.join(directory, "*"), "/reset", "/T", "/C", "/L"],
        options: {},
      },
    ]);
  });

  it("reports trusted command launch failures without leaking raw output", async () => {
    const { WindowsFileAccessControl } = await loadModule();
    const launchError = Object.assign(new Error("spawn C:\\Windows\\System32\\whoami.exe ENOENT"), {
      code: "ENOENT",
    });
    const executor = makeCommandExecutor(async () => {
      throw launchError;
    });
    const accessControl = new WindowsFileAccessControl({
      commandExecutor: executor,
      systemRoot: "C:\\Windows",
    });

    await expect(accessControl.hardenDirectory("C:\\durable\\storage")).rejects.toThrow(
      /whoami\.exe failed to launch \(ENOENT\)/i,
    );

    await accessControl
      .hardenDirectory("C:\\durable\\storage")
      .then(() => {
        throw new Error("expected launch failure");
      })
      .catch((error: unknown) => {
        const message = (error as Error).message;
        expect(message).not.toContain("C:\\Windows\\System32\\whoami.exe");
        expect(message).not.toContain("spawn ");
      });
  });

  it("rejects nonzero icacls status and retries after a failed attempt", async () => {
    const { WindowsFileAccessControl } = await loadModule();
    const executor = makeCommandExecutor(async (executable) => {
      if (executable.endsWith("whoami.exe")) {
        return {
          status: 0,
          signal: null,
          stdout: "CONTOSO\\Agent User\r\n",
        };
      }

      return {
        status: 5,
        signal: null,
      };
    });
    const accessControl = new WindowsFileAccessControl({
      commandExecutor: executor,
      systemRoot: "C:\\Windows",
    });

    await expect(accessControl.hardenDirectory("C:\\durable\\storage")).rejects.toThrow(
      /icacls\.exe failed \(exit status 5\)/i,
    );
    const firstAttemptCalls = executor.run.mock.calls.length;

    await expect(accessControl.hardenDirectory("C:\\durable\\storage")).rejects.toThrow(
      /icacls\.exe failed \(exit status 5\)/i,
    );
    expect(executor.run.mock.calls.length).toBeGreaterThan(firstAttemptCalls);
  });
});
