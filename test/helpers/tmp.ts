/**
 * Removes a test's temp directory. On Windows a fake Boost child that was
 * killed can hold its directory open for seconds after exit, so `rmdir`
 * fails with EBUSY/EPERM even after retries. A leftover temp directory on a
 * CI runner is harmless; failing a passed suite over it is not.
 */
import { rmSync } from "node:fs";

export function removeTempDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform !== "win32" || (code !== "EBUSY" && code !== "EPERM")) throw error;
	}
}
