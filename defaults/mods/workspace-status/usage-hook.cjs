const fs = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");
const { homedir } = require("node:os");
const path = require("node:path");

function snapshotPath(provider, terminal, appHome) {
  const root = appHome || process.env.HERDR_APP_HOME ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "herdr-app");
  const key = terminal == null ? "quota" : createHash("sha256").update(terminal).digest("hex");
  return path.join(root, "usage", provider, key + ".json");
}

async function readSnapshot(provider, terminal, appHome) {
  try {
    return JSON.parse(await fs.readFile(snapshotPath(provider, terminal, appHome), "utf8"));
  } catch {
    return null;
  }
}

async function writeSnapshot(provider, terminal, data, appHome) {
  const file = snapshotPath(provider, terminal, appHome);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID();
  try {
    await fs.writeFile(tmp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function readHookInput(passthrough = false) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    if (passthrough) process.stdout.write(chunk);
    bytes += chunk.length;
    if (bytes <= 2 ** 20) chunks.push(chunk);
  }
  return bytes <= 2 ** 20 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
}

async function fingerprint(file, offset) {
  const start = Math.max(0, offset - 256);
  const bytes = Buffer.alloc(offset - start);
  const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
  return createHash("sha256").update(bytes.subarray(0, bytesRead)).digest("hex");
}

// Only commit complete JSONL records. Reread a partial record on the next append.
async function foldLines(file, start, end, state, fold) {
  const stream = file.createReadStream({ autoClose: false, start, end: end - 1 });
  let offset = start;
  let fragments = [];
  for await (const chunk of stream) {
    let from = 0;
    for (let next; (next = chunk.indexOf(10, from)) !== -1; from = next + 1) {
      const last = chunk.subarray(from, next);
      const line = fragments.length ? Buffer.concat([...fragments, last]) : last;
      fragments = [];
      offset += line.length + 1;
      let row;
      try { row = JSON.parse(line.toString("utf8")); } catch { continue; }
      fold(state, row);
    }
    if (from < chunk.length) fragments.push(chunk.subarray(from));
  }
  return offset;
}

// One checkpoint per terminal and selected session. Only reducer state and
// file identity are saved, never lines, partial records, prompts or tool bodies.
async function summarizeLog(provider, source, key, appHome, reducer) {
  const cacheKey = "append-v2/" + key;
  const cached = await readSnapshot(provider, cacheKey, appHome);
  const filename = typeof source === "function" ? await source(cached?.filename) : source;
  if (!filename) return null;
  const file = await fs.open(filename);
  try {
    const stat = await file.stat();
    const observedAt = Date.now();
    if (!stat.isFile()) return null;
    const identity = JSON.stringify([filename, stat.dev, stat.ino, stat.birthtimeMs]);
    const stamp = JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs]);
    let next = cached?.identity === identity ? cached : null;
    if (next?.stamp !== stamp) {
      const appended = next && stat.size > next.size &&
        next.tail === await fingerprint(file, next.offset);
      if (!appended) next = { identity, filename, generation: randomUUID(), offset: 0, state: reducer.initial() };
      const end = await fingerprint(file, stat.size);
      if (stat.size > next.offset) next.offset = await foldLines(file, next.offset, stat.size, next.state, reducer.fold);
      if (end !== await fingerprint(file, stat.size)) return null;
      next.tail = await fingerprint(file, next.offset);
      Object.assign(next, { size: stat.size, stamp });
      await writeSnapshot(provider, cacheKey, next, appHome);
    }
    const session = reducer.result(next.state);
    return session ? { session, generation: next.generation, observedAt } : null;
  } finally {
    await file.close();
  }
}

module.exports = { readSnapshot, writeSnapshot, readHookInput, summarizeLog };
