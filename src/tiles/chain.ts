// Joins pieces of path end to end through the nodes they share; the shed decks and the path strokes both do.

// A piece of one edge; `head` and `tail` are the nodes it may be joined through, -1 for none.
export interface Ended {
  head: number;
  tail: number;
}

export interface Step {
  path: number;
  reversed: boolean;
}

export interface Chain {
  steps: Step[];
  closed: boolean;
}

const FORK = -2; // more than two ends meet at the node, so no single line runs through it

// Paths come in no walk order, so chains are walked out both ways; two ends at a node are a join.
export function chainPaths(paths: readonly Ended[]): Chain[] {
  // An end is `path * 2`, plus one for the tail.
  const first = new Map<number, number>();
  const second = new Map<number, number>();
  for (let path = 0; path < paths.length; path++) {
    const { head, tail } = paths[path];
    for (const [node, end] of [
      [head, path * 2],
      [tail, path * 2 + 1],
    ]) {
      if (node >= 0 && !first.has(node)) {
        first.set(node, end);
      } else if (node >= 0) {
        second.set(node, second.has(node) ? FORK : end);
      }
    }
  }

  // Null unless exactly two ends meet at `node`; a path whose two ends are the node fills its own pair.
  const neighbor = (path: number, node: number): number | null => {
    const other = second.get(node);
    if (other === undefined || other === FORK) {
      return null;
    }
    const one = first.get(node) as number;
    if (one >> 1 === other >> 1) {
      return null;
    }
    return one >> 1 === path ? other >> 1 : one >> 1;
  };

  const taken = new Uint8Array(paths.length);
  // Reaching a taken path can only mean the chain came back round on itself.
  const follow = (path: number, node: number): Chain => {
    const steps: Step[] = [];
    let current = path;
    let exit = node;
    for (;;) {
      const next = exit < 0 ? null : neighbor(current, exit);
      if (next === null) {
        return { steps, closed: false };
      } else if (taken[next] === 1) {
        return { steps, closed: true };
      }
      taken[next] = 1;
      const forward = paths[next].head === exit;
      steps.push({ path: next, reversed: !forward });
      exit = forward ? paths[next].tail : paths[next].head;
      current = next;
    }
  };

  const chains: Chain[] = [];
  for (let path = 0; path < paths.length; path++) {
    if (taken[path] === 1) {
      continue;
    }
    taken[path] = 1;
    const before = follow(path, paths[path].head);
    const after = follow(path, paths[path].tail);
    chains.push({
      steps: [
        ...before.steps.reverse().map(({ path: step, reversed }) => ({
          path: step,
          reversed: !reversed,
        })),
        { path, reversed: false },
        ...after.steps,
      ],
      closed: before.closed || after.closed,
    });
  }
  return chains;
}
