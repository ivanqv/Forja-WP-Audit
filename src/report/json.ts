import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Inventory } from '../core/types.js';

/** Writes inventory.json into `outputDir` (created if missing) and returns its absolute path. */
export async function writeJsonReport(inventory: Inventory, outputDir: string): Promise<string> {
  const dir = resolve(outputDir);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'inventory.json');
  await writeFile(file, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  return file;
}
