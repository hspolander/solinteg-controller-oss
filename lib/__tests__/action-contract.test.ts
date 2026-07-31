import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The optimizer's `Action` union (TypeScript) and dispatch_loop.py's apply_target() (Python)
 * are two halves of one contract that nothing else spans. The TS side decides what to do; the
 * Python side is the only thing that can actually do it.
 *
 * The failure mode this guards is silent and one-directional. apply_target() forces a setpoint
 * for charge/discharge and returns to AUTO for everything else — so an action added on the TS
 * side but unknown to Python does not throw, log, or skip: it quietly becomes auto. And auto
 * CHARGES from solar surplus. For a "hold" action (freeze SoC, export the surplus) that is
 * precisely the opposite of the plan, on live hardware, with plan-vs-actual telemetry showing
 * only that SoC diverged and never why.
 *
 * That exact gap arrived as a contribution that
 * added a hold action to the union and touched no Python; it was caught by reading the executor,
 * not by any test. A contributor cannot reasonably be expected to know the Python half exists,
 * so this makes the boundary mechanical instead of relying on review.
 *
 * Same technique as constants-cross-language.test.ts: parse the Python source, since the two
 * runtimes cannot import from each other.
 */
const here = dirname(fileURLToPath(import.meta.url));
const optimizerSrc = readFileSync(join(here, '..', 'optimizer.ts'), 'utf-8');
const dispatchSrc = readFileSync(
  join(here, '..', '..', 'scripts', 'services', 'dispatch_loop.py'),
  'utf-8',
);

/** Members of `export type Action = 'a' | 'b' | ...` in lib/optimizer.ts. */
function tsActionUnion(): string[] {
  const decl = optimizerSrc.match(/export type Action\s*=\s*([^;]+);/);
  if (!decl) throw new Error('could not find `export type Action = ...` in lib/optimizer.ts');
  const members = decl[1].match(/'([^']+)'/g);
  if (!members) throw new Error(`no string members parsed from: ${decl[1]}`);
  return members.map((m) => m.slice(1, -1)).sort();
}

/** A declared tuple like `FORCED_ACTIONS = ("charge", "discharge")` in dispatch_loop.py. */
function pyTuple(name: string): string[] {
  const decl = dispatchSrc.match(new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, 'm'));
  if (!decl) throw new Error(`could not find \`${name} = (...)\` in dispatch_loop.py`);
  const members = decl[1].match(/"([^"]+)"/g) ?? [];
  return members.map((m) => m.slice(1, -1)).sort();
}

describe('Action contract: lib/optimizer.ts <-> scripts/services/dispatch_loop.py', () => {
  it('every Action the optimizer can emit is accounted for by the executor', () => {
    const union = tsActionUnion();
    const handled = [...pyTuple('FORCED_ACTIONS'), ...pyTuple('AUTO_ACTIONS')].sort();

    // The assertion message carries the fix, because whoever trips this is most likely adding
    // an action in TS without knowing dispatch_loop.py exists.
    const unhandled = union.filter((a) => !handled.includes(a));
    expect(
      unhandled,
      `Action(s) ${JSON.stringify(unhandled)} exist in lib/optimizer.ts's Action union but are ` +
        'unknown to dispatch_loop.py. Left as-is they would silently take the auto path, which ' +
        'CHARGES from solar surplus. Either give the action a branch in apply_target() (and a ' +
        'real inverter behaviour — check MODBUS.md that the hardware can express it), or add it ' +
        'to AUTO_ACTIONS to declare that mapping to auto is intended.',
    ).toEqual([]);
  });

  it('the executor does not claim actions the optimizer cannot emit', () => {
    const union = tsActionUnion();
    const handled = [...pyTuple('FORCED_ACTIONS'), ...pyTuple('AUTO_ACTIONS')].sort();

    // The reverse direction: a stale entry here is dead code, and worse, it makes the contract
    // look satisfied when it is not.
    const orphaned = handled.filter((a) => !union.includes(a));
    expect(
      orphaned,
      `dispatch_loop.py declares ${JSON.stringify(orphaned)}, which lib/optimizer.ts's Action ` +
        'union no longer contains. Remove the stale entry.',
    ).toEqual([]);
  });

  it('every FORCED_ACTION actually has a branch in apply_target()', () => {
    const body = dispatchSrc.match(/def apply_target\([^)]*\)[^:]*:([\s\S]*?)\ndef /);
    if (!body) throw new Error('could not locate apply_target() in dispatch_loop.py');

    // Declaring an action as "forced" while apply_target has no branch for it would fall through
    // to auto anyway — the declaration would be a lie that the tests above cannot see.
    for (const action of pyTuple('FORCED_ACTIONS')) {
      expect(
        body[1].includes(`== "${action}"`),
        `FORCED_ACTIONS lists '${action}' but apply_target() has no \`== "${action}"\` branch, ` +
          'so it would fall through to auto.',
      ).toBe(true);
    }
  });

  it('parses a known-good baseline (guards the regexes themselves)', () => {
    // If a refactor changes the shape of either declaration, the parsers above would start
    // returning [] and every assertion would vacuously pass. Pin the current values so the
    // test fails loudly instead of going quiet.
    expect(tsActionUnion()).toEqual(['charge', 'discharge', 'idle']);
    expect(pyTuple('FORCED_ACTIONS')).toEqual(['charge', 'discharge']);
    expect(pyTuple('AUTO_ACTIONS')).toEqual(['idle']);
  });
});
