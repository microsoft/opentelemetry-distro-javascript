// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { basename, dirname, join } from "node:path";
import type { ILogger } from "../../logging.js";
import { ResolvedDurableDeliveryOptions } from "./DurableDeliveryOptions.js";
import { parseDurableRecord, type DurableRecordV1 } from "./DurableRecord.js";

const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const PENDING_SUFFIX = ".pending";
const QUARANTINE_SUFFIX = ".quarantine";
const PROBE_DIRECTORY = ["Microsoft", "A365", "otel-durable"] as const;

export interface ClaimedRecord {
  record: DurableRecordV1;
  leasePath: string;
}

interface ManagedFile {
  path: string;
  size: number;
  createdAt: number;
}

export class PersistentStore {
  private claimQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly root: string,
    private readonly options: ResolvedDurableDeliveryOptions,
    private readonly logger: ILogger,
  ) {}

  public static async create(
    options: ResolvedDurableDeliveryOptions,
    logger: ILogger,
  ): Promise<PersistentStore> {
    const root = await resolveStorageRoot(options, logger);
    return new PersistentStore(root, options, logger);
  }

  public async persist(record: DurableRecordV1): Promise<string> {
    const serialized = JSON.stringify(record);
    const recordBytes = Buffer.byteLength(serialized, "utf8");
    if (recordBytes > this.options.maxStorageBytes) {
      throw new RangeError("Durable record exceeds maxStorageBytes");
    }

    await this.pruneForCapacity(recordBytes);

    const temporaryPath = join(this.root, `.${record.id}.${process.pid}.tmp`);
    const pendingPath = this.pendingPath(record);
    const handle = await fs.open(temporaryPath, "wx", OWNER_FILE_MODE);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await fs.rename(temporaryPath, pendingPath);
      await syncDirectory(this.root);
      return pendingPath;
    } catch (error) {
      await ignoreEnoent(() => fs.unlink(temporaryPath));
      throw error;
    }
  }

  public async claimBatch(limit: number): Promise<ClaimedRecord[]> {
    return this.withClaimLock(async () => {
      if (limit <= 0) {
        return [];
      }

      await this.recoverStaleLeases();

      const claims: ClaimedRecord[] = [];
      const pendingFiles = await this.listManagedFilePaths((name) => name.endsWith(PENDING_SUFFIX));
      pendingFiles.sort();

      for (const pendingPath of pendingFiles) {
        if (claims.length >= limit) {
          break;
        }

        const leasePath = this.leasePath(pendingPath);
        try {
          await fs.rename(pendingPath, leasePath);
          await syncDirectory(this.root);
        } catch (error) {
          if (isEnoent(error)) {
            continue;
          }
          throw error;
        }

        let text: string;
        try {
          text = await fs.readFile(leasePath, "utf8");
        } catch (error) {
          if (isEnoent(error)) {
            continue;
          }
          throw error;
        }

        try {
          claims.push({
            record: parseDurableRecord(text),
            leasePath,
          });
        } catch (error) {
          await quarantineFile(leasePath);
          this.logger.warn("[PersistentStore] Quarantined malformed durable record", error);
        }
      }

      return claims;
    });
  }

  public async complete(claim: ClaimedRecord): Promise<void> {
    await fs.unlink(claim.leasePath);
    await syncDirectory(this.root);
  }

  public async release(claim: ClaimedRecord): Promise<void> {
    await fs.rename(claim.leasePath, this.pendingPath(claim.record, `release-${randomUUID()}`));
    await syncDirectory(this.root);
  }

  private async pruneForCapacity(incomingBytes: number): Promise<void> {
    let files = await this.readManagedFiles();
    let usedBytes = sumBytes(files);
    const minimumCreatedAt = Date.now() - this.options.maxRecordAgeMilliseconds;

    for (const file of files.sort((left, right) => left.createdAt - right.createdAt)) {
      if (file.createdAt >= minimumCreatedAt) {
        continue;
      }

      await ignoreEnoent(() => fs.unlink(file.path));
      usedBytes -= file.size;
    }

    if (usedBytes + incomingBytes <= this.options.maxStorageBytes) {
      return;
    }

    files = await this.readManagedFiles();
    usedBytes = sumBytes(files);
    for (const file of files.sort((left, right) => left.createdAt - right.createdAt)) {
      if (usedBytes + incomingBytes <= this.options.maxStorageBytes) {
        break;
      }

      await ignoreEnoent(() => fs.unlink(file.path));
      usedBytes -= file.size;
    }
  }

  private async recoverStaleLeases(): Promise<void> {
    const now = Date.now();
    const leasePaths = await this.listManagedFilePaths((name) => name.includes(".lease-"));

    for (const leasePath of leasePaths) {
      let stats: Stats;
      try {
        stats = await fs.stat(leasePath);
      } catch (error) {
        if (isEnoent(error)) {
          continue;
        }
        throw error;
      }

      if (now - stats.mtimeMs <= this.options.leaseDurationMilliseconds) {
        continue;
      }

      const recoveredPath = join(
        this.root,
        `${leasePrefix(leasePath)}.recovered-${randomUUID()}${PENDING_SUFFIX}`,
      );
      try {
        await fs.rename(leasePath, recoveredPath);
        await syncDirectory(this.root);
      } catch (error) {
        if (isEnoent(error)) {
          continue;
        }
        throw error;
      }
    }
  }

  private pendingPath(record: DurableRecordV1, suffix?: string): string {
    const baseName = `${record.createdAt}-${record.id}`;
    return join(this.root, suffix ? `${baseName}.${suffix}${PENDING_SUFFIX}` : `${baseName}${PENDING_SUFFIX}`);
  }

  private leasePath(pendingPath: string): string {
    return pendingPath.replace(/\.pending$/, `.lease-${process.pid}-${randomUUID()}`);
  }

  private async readManagedFiles(): Promise<ManagedFile[]> {
    const names = await this.listManagedFilePaths(isManagedFileName);
    const files: ManagedFile[] = [];

    for (const fullPath of names) {
      try {
        const stats = await fs.stat(fullPath);
        files.push({
          path: fullPath,
          size: stats.size,
          createdAt: parseCreatedAt(fullPath) ?? Math.floor(stats.mtimeMs),
        });
      } catch (error) {
        if (isEnoent(error)) {
          continue;
        }
        throw error;
      }
    }

    return files;
  }

  private async listManagedFilePaths(predicate: (name: string) => boolean): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && predicate(entry.name))
        .map((entry) => join(this.root, entry.name));
    } catch (error) {
      if (isEnoent(error)) {
        return [];
      }
      throw error;
    }
  }

  private async withClaimLock<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.claimQueue;
    let release = () => {};
    this.claimQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

async function resolveStorageRoot(
  options: ResolvedDurableDeliveryOptions,
  logger: ILogger,
): Promise<string> {
  if (options.storageDirectory !== undefined) {
    return initializeRoot(options.storageDirectory);
  }

  const candidates =
    process.platform === "win32"
      ? [process.env.LOCALAPPDATA, process.env.TEMP, os.tmpdir()]
      : [process.env.TMPDIR, "/var/tmp", os.tmpdir()];

  let lastError: unknown;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const root = join(candidate, ...PROBE_DIRECTORY);
    try {
      return await initializeRoot(root);
    } catch (error) {
      lastError = error;
      logger.warn("[PersistentStore] Durable storage candidate unavailable", root, error);
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Unable to initialize durable storage root");
}

async function initializeRoot(root: string): Promise<string> {
  try {
    await fs.mkdir(root, { recursive: true, mode: OWNER_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  const stats = await fs.lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Durable storage root must be a real directory: ${root}`);
  }

  if (process.platform !== "win32") {
    await fs.chmod(root, OWNER_DIRECTORY_MODE);
  }

  await probeRoot(root);
  return root;
}

async function probeRoot(root: string): Promise<void> {
  const probePath = join(root, `.probe-${process.pid}-${randomUUID()}`);
  const handle = await fs.open(probePath, "wx", OWNER_FILE_MODE);
  try {
    await handle.writeFile("probe", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fs.unlink(probePath);
  await syncDirectory(root);
}

async function quarantineFile(path: string): Promise<void> {
  await fs.rename(path, `${path}${QUARANTINE_SUFFIX}`);
  await syncDirectory(dirname(path));
}

async function syncDirectory(root: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  const handle = await fs.open(root, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseCreatedAt(path: string): number | undefined {
  const match = /(?:^|[\\/])(\d+)-/.exec(path);
  if (!match) {
    return undefined;
  }

  const createdAt = Number.parseInt(match[1], 10);
  return Number.isFinite(createdAt) ? createdAt : undefined;
}

function leasePrefix(path: string): string {
  return basename(path).split(".lease-")[0];
}

function isManagedFileName(name: string): boolean {
  return name.endsWith(PENDING_SUFFIX) || name.includes(".lease-") || name.endsWith(QUARANTINE_SUFFIX);
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function ignoreEnoent(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
}

function sumBytes(files: ManagedFile[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}
