// Cache a value built from a file and rebuild it when the file's mtime changes.
import { statSync } from "node:fs";

/**
 * Returns a getter for build(). The first build runs now and throws if the file is invalid.
 * A later rebuild that throws keeps the last good value and calls report once for that mtime.
 */
export function onFileChange<T>(file: string, build: () => T, report: (error: Error) => void): () => T {
  const mtime = (): number => {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return -1;
    }
  };
  let seen = mtime();
  let value = build();
  return () => {
    const m = mtime();
    if (m === seen) return value;
    seen = m;
    try {
      value = build();
    } catch (error) {
      report(error instanceof Error ? error : new Error(String(error)));
    }
    return value;
  };
}
