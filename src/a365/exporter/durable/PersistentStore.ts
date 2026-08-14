// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ILogger } from "../../logging.js";
import { ResolvedDurableDeliveryOptions } from "./DurableDeliveryOptions.js";
import { parseDurableRecord, type DurableRecordV1 } from "./DurableRecord.js";

const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const PENDING_SUFFIX = ".pending";
const QUARANTINE_SUFFIX = ".quarantine";
const TEMPORARY_SUFFIX = ".tmp";
const WINDOWS_PROBE_DIRECTORY = ["Microsoft", "A365", "otel-durable"] as const;
const POSIX_DEFAULT_LEAF_PREFIX = "a365-otel-durable";
const APPLICATION_PARTITION_PREFIX = "app-";
const PROCESS_START_CWD = process.cwd();

export interface ClaimedRecord {
  record: DurableRecordV1;
  leasePath: string;
}

interface ManagedFile {
  path: string;
  size: number;
  createdAt: number;
  evictable: boolean;
  removableWhenExpired: boolean;
}

export class PersistentStore {
  private static readonly persistenceQueues = new Map<string, Promise<void>>();
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

  public persist(record: DurableRecordV1): Promise<string> {
    return this.withPersistenceLock(() => this.persistInternal(record));
  }

  private async persistInternal(record: DurableRecordV1): Promise<string> {
    const serialized = JSON.stringify(record);
    const recordBytes = Buffer.byteLength(serialized, "utf8");
    if (recordBytes > this.options.maxStorageBytes) {
      throw new RangeError("Durable record exceeds maxStorageBytes");
    }

    await this.pruneForCapacity(recordBytes);

    const temporaryPath = this.temporaryPath(record);
    const pendingPath = this.pendingPath(record);
    const handle = await fs.open(temporaryPath, "wx", OWNER_FILE_MODE);
    try {
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      await this.pruneForCapacity(0);
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
    try {
      await fs.unlink(claim.leasePath);
      await syncDirectory(this.root);
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
    }
  }

  public async release(claim: ClaimedRecord): Promise<void> {
    try {
      await fs.rename(claim.leasePath, this.pendingPath(claim.record, `release-${randomUUID()}`));
      await syncDirectory(this.root);
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
    }
  }

  private async pruneForCapacity(incomingBytes: number): Promise<void> {
    const minimumCreatedAt = Date.now() - this.options.maxRecordAgeMilliseconds;
    let files = await this.readManagedFiles();
    let usedBytes = sumBytes(files);

    for (const file of files.sort((left, right) => left.createdAt - right.createdAt)) {
      if (!file.removableWhenExpired || file.createdAt >= minimumCreatedAt) {
        continue;
      }

      if (await unlinkIfExists(file.path)) {
        this.logger.warn("[PersistentStore] Evicted expired durable record", {
          path: file.path,
          bytes: file.size,
        });
      }
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
      if (!file.evictable) {
        continue;
      }

      if (await unlinkIfExists(file.path)) {
        this.logger.warn("[PersistentStore] Evicted durable record for capacity", {
          path: file.path,
          bytes: file.size,
        });
      }
      usedBytes -= file.size;
    }

    if (usedBytes + incomingBytes <= this.options.maxStorageBytes) {
      return;
    }

    const survivingFiles = await this.readManagedFiles();
    if (sumBytes(survivingFiles) + incomingBytes <= this.options.maxStorageBytes) {
      return;
    }

    throw new RangeError("Durable storage capacity is occupied by active durable files");
  }

  private async recoverStaleLeases(): Promise<void> {
    const now = Date.now();
    const leasePaths = await this.listManagedFilePaths(isActiveLeaseFileName);

    for (const leasePath of leasePaths) {
      const claimedAt = parseLeaseClaimedAt(leasePath);
      if (claimedAt === undefined) {
        const migratedLeasePath = this.migratedLeasePath(leasePath, now);
        try {
          await fs.rename(leasePath, migratedLeasePath);
          await syncDirectory(this.root);
        } catch (error) {
          if (isEnoent(error)) {
            continue;
          }
          throw error;
        }
        continue;
      }

      if (now - claimedAt <= this.options.leaseDurationMilliseconds) {
        continue;
      }

      try {
        const recoveredPath = await this.recoveredPendingPath(leasePath);
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
    const baseName = recordBasename(record);
    return join(
      this.root,
      suffix ? `${baseName}.${suffix}${PENDING_SUFFIX}` : `${baseName}${PENDING_SUFFIX}`,
    );
  }

  private async recoveredPendingPath(leasePath: string): Promise<string> {
    const text = await fs.readFile(leasePath, "utf8");
    const suffix = `recovered-${randomUUID()}`;
    try {
      return this.pendingPath(parseDurableRecord(text), suffix);
    } catch {
      return join(this.root, `${stableRecordBasename(leasePath)}.${suffix}${PENDING_SUFFIX}`);
    }
  }

  private leasePath(pendingPath: string): string {
    return pendingPath.replace(
      /\.pending$/,
      `.lease-at-${Date.now()}-${process.pid}-${randomUUID()}`,
    );
  }

  private migratedLeasePath(leasePath: string, claimedAt: number): string {
    return join(
      this.root,
      `${leasePrefix(leasePath)}.lease-at-${claimedAt}-${process.pid}-${randomUUID()}`,
    );
  }

  private temporaryPath(record: DurableRecordV1): string {
    return join(
      this.root,
      `${Date.now()}-${record.id}.${process.pid}-${randomUUID()}${TEMPORARY_SUFFIX}`,
    );
  }

  private async readManagedFiles(): Promise<ManagedFile[]> {
    const names = await this.listManagedFilePaths(isManagedFileName);
    const files: ManagedFile[] = [];

    for (const fullPath of names) {
      try {
        const stats = await fs.stat(fullPath);
        const name = basename(fullPath);
        const activeLease = isActiveLeaseFileName(name);
        files.push({
          path: fullPath,
          size: stats.size,
          createdAt: parseCreatedAt(fullPath) ?? Math.floor(stats.mtimeMs),
          evictable: isEvictableFileName(name),
          removableWhenExpired: !activeLease,
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

  private async withPersistenceLock<T>(callback: () => Promise<T>): Promise<T> {
    const previous = PersistentStore.persistenceQueues.get(this.root) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    PersistentStore.persistenceQueues.set(this.root, current);

    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (PersistentStore.persistenceQueues.get(this.root) === current) {
        PersistentStore.persistenceQueues.delete(this.root);
      }
    }
  }
}

async function resolveStorageRoot(
  options: ResolvedDurableDeliveryOptions,
  logger: ILogger,
): Promise<string> {
  if (options.storageDirectory !== undefined) {
    return initializeExplicitRoot(options.storageDirectory);
  }

  let lastError: unknown;
  for (const candidate of storageRootCandidates()) {
    const root = defaultStorageBaseRoot(candidate);
    try {
      return await initializeDefaultRoot(root);
    } catch (error) {
      lastError = error;
      logger.warn(
        "[PersistentStore] Durable storage candidate unavailable",
        partitionedStorageRoot(root),
        error,
      );
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Unable to initialize durable storage root");
}

async function initializeRoot(root: string, recursive = true): Promise<string> {
  try {
    await fs.mkdir(root, { recursive, mode: OWNER_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  return verifyRoot(root);
}

async function initializeExplicitRoot(root: string): Promise<string> {
  const baseRoot = await initializeRoot(root);
  return initializeRoot(partitionedStorageRoot(baseRoot), false);
}

async function initializeDefaultRoot(root: string): Promise<string> {
  const baseRoot = await initializeRoot(root, process.platform === "win32");
  return initializeRoot(partitionedStorageRoot(baseRoot), false);
}

async function verifyRoot(root: string): Promise<string> {
  let stats = await fs.lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Durable storage root must be a real directory: ${root}`);
  }

  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) {
      throw new Error(`Durable storage root must be owned by the current user: ${root}`);
    }

    await fs.chmod(root, OWNER_DIRECTORY_MODE);
    stats = await fs.lstat(root);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      (uid !== undefined && stats.uid !== uid)
    ) {
      throw new Error(
        `Durable storage root must be a real directory owned by the current user: ${root}`,
      );
    }
  }

  await probeRoot(root);
  return root;
}

function defaultStorageBaseRoot(candidate: string): string {
  if (process.platform === "win32") {
    return join(candidate, ...WINDOWS_PROBE_DIRECTORY);
  }

  return join(candidate, `${POSIX_DEFAULT_LEAF_PREFIX}-${process.getuid?.() ?? "unknown"}`);
}

export function applicationPartition(): string {
  const identity = [
    process.getuid?.() ?? "unknown",
    process.execPath,
    stableApplicationIdentityBase(),
  ].join("\0");
  const partition = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `${APPLICATION_PARTITION_PREFIX}${partition}`;
}

function stableApplicationIdentityBase(): string {
  const entryPoint = process.argv[1];
  if (typeof entryPoint === "string" && entryPoint.length > 0) {
    return isAbsolute(entryPoint) ? entryPoint : resolve(PROCESS_START_CWD, entryPoint);
  }

  return PROCESS_START_CWD;
}

function partitionedStorageRoot(root: string): string {
  return join(root, applicationPartition());
}

function storageRootCandidates(): string[] {
  const candidates =
    process.platform === "win32"
      ? [process.env.LOCALAPPDATA, process.env.TEMP, os.tmpdir()]
      : [process.env.TMPDIR, "/var/tmp", "/tmp"];

  return [...new Set(candidates.filter(isNonEmptyString))];
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
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
  await fs.rename(path, join(dirname(path), `${leasePrefix(path)}${QUARANTINE_SUFFIX}`));
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
  const match = /^(\d+)-/.exec(basename(path));
  if (!match) {
    return undefined;
  }

  const createdAt = Number.parseInt(match[1], 10);
  return Number.isFinite(createdAt) ? createdAt : undefined;
}

function leasePrefix(path: string): string {
  return basename(path).split(".lease-")[0];
}

function recordBasename(record: DurableRecordV1): string {
  return `${record.createdAt}-${record.id}`;
}

function stableRecordBasename(path: string): string {
  return leasePrefix(path).split(".")[0];
}

function parseLeaseClaimedAt(path: string): number | undefined {
  const match = /\.lease-at-(\d+)-\d+-[^.]+$/.exec(basename(path));
  if (!match) {
    return undefined;
  }

  const claimedAt = Number.parseInt(match[1], 10);
  return Number.isFinite(claimedAt) ? claimedAt : undefined;
}

function isActiveLeaseFileName(name: string): boolean {
  return /\.lease-[^.]+$/.test(name);
}

function isEvictableFileName(name: string): boolean {
  return name.endsWith(PENDING_SUFFIX) || name.endsWith(QUARANTINE_SUFFIX);
}

function isManagedFileName(name: string): boolean {
  return (
    isEvictableFileName(name) || name.endsWith(TEMPORARY_SUFFIX) || isActiveLeaseFileName(name)
  );
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function unlinkIfExists(path: string): Promise<boolean> {
  try {
    await fs.unlink(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
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
