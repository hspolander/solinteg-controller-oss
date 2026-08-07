/**
 * deploy/schema.sql is declared the single source of truth for telemetry.db's shape, but it is
 * never actually applied: six tables are created by five different processes, each running
 * its own inline `CREATE TABLE IF NOT EXISTS` at startup (three in lib/telemetry/core.ts, the
 * rest across scripts/services/*.py). The only thing keeping those copies honest has been a
 * "keep this in sync" comment on each one.
 *
 * That is the same unenforced-duplication shape constants-cross-language.test.ts already guards
 * for the TS/Python constants, and it fails the same way: silently, at runtime, on the NUC. A
 * writer that gains a column its schema.sql entry doesn't have produces a table the *other*
 * readers don't know about; the reverse produces a documented column that doesn't exist, and
 * `SELECT`ing it throws "no such column" in whichever process reads it first — plausibly the
 * dispatch loop.
 *
 * Audited manually on 2026-08-07: zero drift at the time this test was written. It exists to
 * keep that true, not to fix anything.
 *
 * WHAT THIS DOES AND DOESN'T CATCH: column NAMES per table, in both directions, including
 * additive `ALTER TABLE ... ADD COLUMN` migrations (control_actions.detail_json and
 * readings.soh_pct/battery_temp_c reach their final shape that way, so a CREATE-only comparison
 * would report false drift). It does NOT compare column TYPES or constraints — SQLite's dynamic
 * typing makes a REAL/INTEGER mismatch mostly harmless, and the declarations are formatted
 * differently enough across the two languages that comparing them would be noise. It also
 * doesn't check indexes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every file that creates a telemetry.db table, and which tables it owns. */
const WRITERS: { file: string; tables: string[] }[] = [
  { file: 'lib/telemetry/core.ts', tables: ['price_snapshots', 'optimizer_runs', 'oracle_daily'] },
  { file: 'scripts/services/modbus_poller.py', tables: ['readings'] },
  { file: 'scripts/services/weather_poller.py', tables: ['weather'] },
  { file: 'scripts/services/dispatch_loop.py', tables: ['control_actions'] },
];

const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8');

/**
 * Column names per `CREATE TABLE` in a blob of SQL (embedded in TS/Python source or standalone).
 * Deliberately line-oriented rather than a real SQL parse: every definition in this repo puts one
 * column per line, and a parser would be more machinery than the invariant is worth.
 */
function createdColumns(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)\s*\(([\s\S]*?)\n\s*\)/gi;
  for (const m of text.matchAll(re)) {
    const cols: string[] = [];
    for (const rawLine of m[2].split('\n')) {
      const line = rawLine.replace(/--.*$/, '').replace(/,\s*$/, '').trim();
      if (!line) continue;
      if (/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(line)) continue; // table constraints
      const col = line.match(/^([A-Za-z_]\w*)\s+\S/);
      if (col) cols.push(col[1]);
    }
    if (cols.length) out.set(m[1], cols);
  }
  return out;
}

/** Additive migrations, which are as much a part of the real shape as the CREATE is. */
function addedColumns(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /ALTER\s+TABLE\s+([A-Za-z_]\w*)\s+ADD\s+COLUMN\s+([A-Za-z_]\w*)/gi;
  for (const m of text.matchAll(re)) {
    if (!out.has(m[1])) out.set(m[1], []);
    out.get(m[1])!.push(m[2]);
  }
  return out;
}

const canonical = createdColumns(read('deploy/schema.sql'));

describe('deploy/schema.sql covers every telemetry.db table', () => {
  it('declares all six tables', () => {
    expect([...canonical.keys()].sort()).toEqual([
      'control_actions', 'optimizer_runs', 'oracle_daily',
      'price_snapshots', 'readings', 'weather',
    ]);
  });

  it('has no table that no writer creates', () => {
    const created = new Set(WRITERS.flatMap((w) => w.tables));
    expect([...canonical.keys()].filter((t) => !created.has(t))).toEqual([]);
  });
});

describe.each(WRITERS)('$file matches deploy/schema.sql', ({ file, tables }) => {
  const text = read(file);
  const created = createdColumns(text);
  const added = addedColumns(text);

  it.each(tables)('%s has the same columns in both places', (table) => {
    const inline = created.get(table);
    expect(inline, `${file} does not CREATE ${table}`).toBeDefined();

    // Deduped: a column can legitimately appear in BOTH the CREATE and an ALTER — the ALTER
    // exists only for DBs created before the column did, and is a caught no-op on a fresh one
    // (control_actions.detail_json is exactly this).
    const actual = [...new Set([...inline!, ...(added.get(table) ?? [])])].sort();
    const expected = [...new Set(canonical.get(table)!)].sort();
    // Compared as sorted sets: SQLite column ORDER differs harmlessly (an ALTER-added column
    // lands last on an old DB and mid-list in schema.sql), and every read in this codebase is
    // by name, never by position.
    expect(actual).toEqual(expected);
  });
});
