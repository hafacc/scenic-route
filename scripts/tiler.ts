import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CRATE = join(ROOT, "crates", "tiler");

// Inputs to the tile build; the lock and toolchain are here because either can move output bytes.
export async function tilerSources(): Promise<string[]> {
  const sources: string[] = [];
  const pending = [join(CRATE, "src")];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else {
        sources.push(path);
      }
    }
  }
  return [
    join(ROOT, "Cargo.toml"),
    join(ROOT, "Cargo.lock"),
    join(ROOT, "rust-toolchain.toml"),
    join(CRATE, "Cargo.toml"),
    ...sources,
  ];
}
