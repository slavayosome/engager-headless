// Downloads Engager's own Chromium during Mac setup (US-OND-04): real
// byte-count progress, HTTP Range resume from a partial kept on disk, the
// manifest's sha256 checked before anything is unpacked, and an atomic
// rename into ~/.engager/browser/chromium-<build>/ only when complete.
// Nothing here ever reads or writes the shared Playwright cache, spawns
// uvx/playwright, or opens a web page -- it fetches one pinned zip.
//
// Failure is a reason CODE, never a raw error string: the setup window's
// words come from BROWSER_FAILURE_WORDS, and `keptBytes` says what a Retry
// resumes from (the partial plus its state file live on disk, so an app
// restart between the stop and the retry resumes too). A damaged or
// disk-full stop discards the partial -- resuming bad bytes would only
// fail the digest again.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  browserExecutablePath,
  browserInstallDir,
  browserManifestForArch,
  hasChromeSegment,
  megabytes,
} from "./browserManifest.mjs";

/** The owner-facing words for each reason code -- proposed copy pinned
 *  here so the CLI event, the status and the Swift failure screen can
 *  never drift into three wordings of one stop. */
export const BROWSER_FAILURE_WORDS = Object.freeze({
  "connection-dropped": "the connection dropped",
  offline: "you are offline",
  "disk-full": "there is not enough space",
  damaged: "the download was damaged and was discarded",
  "server-refused": "the server refused the download",
});

export class BrowserInstallError extends Error {
  constructor(reason, { keptBytes = 0, totalBytes = 0 } = {}) {
    super(BROWSER_FAILURE_WORDS[reason] ?? reason);
    this.name = "BrowserInstallError";
    this.reason = reason;
    this.keptBytes = keptBytes;
    this.totalBytes = totalBytes;
  }
}

function downloadDir(homeDir) {
  return path.join(homeDir, "browser", ".download");
}

function partialPath(homeDir, entry) {
  return path.join(downloadDir(homeDir), `chromium-${entry.build}.zip.part`);
}

function statePath(homeDir, entry) {
  return path.join(downloadDir(homeDir), `chromium-${entry.build}.json`);
}

/** The resumable partial's state: which pin the kept bytes belong to. A
 *  partial whose state names another URL or digest is not resumed -- it
 *  belongs to a pin that no longer exists. */
function readPartialState(homeDir, entry, fileExists = existsSync) {
  const file = partialPath(homeDir, entry);
  if (!fileExists(file)) return { keptBytes: 0, resumable: false };
  let keptBytes = 0;
  try {
    keptBytes = statSync(file).size;
  } catch {
    return { keptBytes: 0, resumable: false };
  }
  let state = null;
  try {
    state = JSON.parse(readFileSync(statePath(homeDir, entry), "utf8"));
  } catch {
    state = null;
  }
  const resumable =
    state?.url === entry.url && state?.sha256 === entry.sha256 && keptBytes > 0 && keptBytes < entry.sizeBytes;
  return { keptBytes: resumable ? keptBytes : 0, resumable, onDisk: keptBytes };
}

/**
 * What setup can say about the browser row without running anything:
 * done (the pinned executable is in place), partial (kept bytes a Retry
 * resumes from), or pending. `totalMB` is the manifest's size -- the one
 * number the window shows, never typed into copy.
 */
export function browserStatus({ homeDir, arch = process.arch, fileExists = existsSync, manifestEntry } = {}) {
  const entry = manifestEntry ?? browserManifestForArch(arch);
  if (!homeDir || !entry) {
    return { state: "pending", done: false, downloadedBytes: 0, totalBytes: 0, downloadedMB: 0, totalMB: 0 };
  }
  const done = fileExists(browserExecutablePath(homeDir, entry));
  const { keptBytes } = done ? { keptBytes: entry.sizeBytes } : readPartialState(homeDir, entry, fileExists);
  return {
    state: done ? "done" : keptBytes > 0 ? "partial" : "pending",
    done,
    build: entry.build,
    version: entry.version,
    downloadedBytes: keptBytes,
    totalBytes: entry.sizeBytes,
    downloadedMB: megabytes(keptBytes),
    totalMB: megabytes(entry.sizeBytes),
  };
}

/** Minutes left from the last ten seconds of speed, rounded up; null for
 *  the first few seconds, when any estimate is a guess. */
function etaMinutes(samples, downloadedBytes, totalBytes, nowMs) {
  const windowStart = nowMs - 10_000;
  const recent = samples.filter((sample) => sample.at >= windowStart);
  const first = recent[0];
  if (!first || nowMs - samples[0].at < 3_000) return null;
  const elapsed = (nowMs - first.at) / 1000;
  const gained = downloadedBytes - first.bytes;
  if (elapsed <= 0 || gained <= 0) return null;
  const perSecond = gained / elapsed;
  return Math.max(1, Math.ceil((totalBytes - downloadedBytes) / perSecond / 60));
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** The production unpacker: ditto preserves the app bundle's resource
 *  forks and permissions the way a plain unzip does not. Injectable so
 *  tests never need a real zip -- a fake writes the same layout. */
function dittoUnpack(zipFile, destDir) {
  const result = spawnSync("ditto", ["-x", "-k", zipFile, destDir], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`ditto could not unpack the download: ${(result.stderr || "").trim()}`);
  }
}

function removePartial(homeDir, entry) {
  rmSync(partialPath(homeDir, entry), { force: true });
  rmSync(statePath(homeDir, entry), { force: true });
}

/**
 * Fetch, verify and install the pinned browser. Events (progress at
 * least once a second while bytes move, then exactly one terminal done
 * or failed event) carry counts and codes only -- command, URL host,
 * byte counts, reason code: the "Show details" log, with no token, no
 * account and no path outside ~/.engager.
 */
export async function installBrowser({
  homeDir,
  arch = process.arch,
  fetchImpl = fetch,
  unpackImpl = dittoUnpack,
  freeBytesImpl = (dir) => {
    const stats = statfsSync(dir);
    return stats.bavail * stats.bsize;
  },
  onEvent = () => {},
  now = () => Date.now(),
  // Test seam: a fixture server serves a tiny zip under its own pin, so
  // no test ever reaches the real CDN or moves 133 MB.
  manifestEntry,
} = {}) {
  const entry = manifestEntry ?? browserManifestForArch(arch);
  if (!homeDir || !entry) throw new BrowserInstallError("server-refused", { totalBytes: entry?.sizeBytes ?? 0 });
  const totalBytes = entry.sizeBytes;
  const host = new URL(entry.url).host;
  const fail = (reason, keptBytes) => {
    onEvent({
      type: "failed",
      command: "mac-setup run browser",
      urlHost: host,
      reason,
      words: BROWSER_FAILURE_WORDS[reason],
      downloadedBytes: keptBytes,
      totalBytes,
      downloadedMB: megabytes(keptBytes),
      totalMB: megabytes(totalBytes),
      keptBytes,
    });
    return new BrowserInstallError(reason, { keptBytes, totalBytes });
  };

  const executable = browserExecutablePath(homeDir, entry);
  if (hasChromeSegment(executable)) throw fail("damaged", 0);
  if (existsSync(executable)) {
    onEvent({ type: "done", downloadedBytes: totalBytes, totalBytes, alreadyInstalled: true });
    return { executablePath: executable, alreadyInstalled: true };
  }

  mkdirSync(downloadDir(homeDir), { recursive: true });
  const partial = partialPath(homeDir, entry);
  let { keptBytes, onDisk } = readPartialState(homeDir, entry);
  if (onDisk > 0 && keptBytes === 0) removePartial(homeDir, entry);

  // Space for the zip still to come plus the unpacked app beside it.
  try {
    if (freeBytesImpl(downloadDir(homeDir)) < (totalBytes - keptBytes) * 2) {
      removePartial(homeDir, entry);
      throw fail("disk-full", 0);
    }
  } catch (error) {
    if (error instanceof BrowserInstallError) throw error;
    // A statfs that cannot answer is not a full disk; the write below is
    // the real test and classifies its own ENOSPC.
  }

  writeFileSync(
    statePath(homeDir, entry),
    JSON.stringify({ url: entry.url, sha256: entry.sha256, totalBytes }),
  );

  const samples = [{ at: now(), bytes: keptBytes }];
  let lastEmit = 0;
  const progress = (downloadedBytes, force = false) => {
    const at = now();
    samples.push({ at, bytes: downloadedBytes });
    if (!force && at - lastEmit < 250) return;
    lastEmit = at;
    onEvent({
      type: "progress",
      downloadedBytes,
      totalBytes,
      downloadedMB: megabytes(downloadedBytes),
      totalMB: megabytes(totalBytes),
      etaMinutes: etaMinutes(samples, downloadedBytes, totalBytes, at),
    });
  };
  progress(keptBytes, true);

  let response;
  try {
    response = await fetchImpl(entry.url, {
      headers: keptBytes > 0 ? { Range: `bytes=${keptBytes}-` } : {},
      redirect: "follow",
    });
  } catch {
    throw fail(keptBytes > 0 ? "connection-dropped" : "offline", keptBytes);
  }
  if (response.status === 416 && keptBytes > 0) {
    // The partial already holds every byte; fall through to the digest.
    response = null;
  } else if (!response.ok && response.status !== 206) {
    throw fail("server-refused", keptBytes);
  }

  if (response) {
    // A 200 to a Range request means the server ignored it: start over
    // rather than append a second copy of the head onto the partial.
    const append = response.status === 206 && keptBytes > 0;
    let downloaded = append ? keptBytes : 0;
    const out = createWriteStream(partial, { flags: append ? "a" : "w" });
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        await new Promise((resolve, reject) => {
          out.write(buffer, (error) => (error ? reject(error) : resolve()));
        });
        downloaded += buffer.length;
        keptBytes = downloaded;
        progress(downloaded);
      }
      await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
    } catch (error) {
      out.destroy();
      if (error?.code === "ENOSPC") {
        removePartial(homeDir, entry);
        throw fail("disk-full", 0);
      }
      throw fail("connection-dropped", keptBytes);
    }
    progress(downloaded, true);
    if (downloaded !== totalBytes) throw fail("connection-dropped", downloaded);
  }

  // The digest is checked before anything is unpacked; bad bytes are
  // discarded, never resumed.
  const digest = await sha256File(partial);
  if (digest !== entry.sha256) {
    removePartial(homeDir, entry);
    throw fail("damaged", 0);
  }

  const unpackDir = path.join(homeDir, "browser", `.unpack-${entry.build}`);
  rmSync(unpackDir, { recursive: true, force: true });
  mkdirSync(unpackDir, { recursive: true });
  try {
    unpackImpl(partial, unpackDir);
  } catch (error) {
    rmSync(unpackDir, { recursive: true, force: true });
    if (error?.code === "ENOSPC") {
      removePartial(homeDir, entry);
      throw fail("disk-full", 0);
    }
    removePartial(homeDir, entry);
    throw fail("damaged", 0);
  }
  // The zip wraps the app in a `chrome-mac/` directory; only the app
  // moves into place, so no installed segment ever says "chrome".
  const unpackedApp = [path.join(unpackDir, "chrome-mac", "Chromium.app"), path.join(unpackDir, "Chromium.app")].find(
    (candidate) => existsSync(candidate),
  );
  const installDir = browserInstallDir(homeDir, entry);
  if (!unpackedApp || hasChromeSegment(installDir)) {
    rmSync(unpackDir, { recursive: true, force: true });
    removePartial(homeDir, entry);
    throw fail("damaged", 0);
  }
  mkdirSync(installDir, { recursive: true });
  renameSync(unpackedApp, path.join(installDir, "Chromium.app"));
  rmSync(unpackDir, { recursive: true, force: true });
  removePartial(homeDir, entry);
  rmSync(downloadDir(homeDir), { recursive: true, force: true });

  if (!existsSync(executable)) throw fail("damaged", 0);
  onEvent({ type: "done", downloadedBytes: totalBytes, totalBytes, alreadyInstalled: false });
  return { executablePath: executable, alreadyInstalled: false };
}
