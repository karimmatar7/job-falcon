import { promises as fsp } from "node:fs";
import path from "node:path";

/** True when an unknown error carries the given Node error code. */
export function isErrnoError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

/** Read a UTF-8 file, returning `undefined` when it does not exist. */
export async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (isErrnoError(error, "ENOENT")) return undefined;
    throw error;
  }
}

/**
 * Write a UTF-8 file atomically: content goes to a unique temporary file in the
 * same directory, then a single `rename` makes it visible. A crash therefore
 * leaves either the old complete file or the new complete file, never a
 * half-written one.
 */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  try {
    await fsp.writeFile(tempPath, contents, "utf8");
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Move a file aside so a corrupt state file never blocks startup. Returns the
 * backup path, or `undefined` when there was no file to move.
 */
export async function quarantineFile(
  filePath: string,
  now: number = Date.now(),
): Promise<string | undefined> {
  const backupPath = `${filePath}.corrupt-${now}`;
  try {
    await fsp.rename(filePath, backupPath);
    return backupPath;
  } catch (error) {
    if (isErrnoError(error, "ENOENT")) return undefined;
    throw error;
  }
}
