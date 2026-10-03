import fs from 'node:fs';
import path from 'node:path';

/**
 * Every path a tool reads or writes goes through here. Map files may only be touched inside the
 * configured roots; asset sources (Dungeondraft install, asset folders) are separately allowed
 * for reading only.
 */
export class Sandbox {
  readonly roots: string[];
  readonly readOnlyRoots: string[];

  constructor(roots: string[], readOnlyRoots: string[] = []) {
    if (!roots.length) throw new Error('At least one map root folder must be configured (DD_MCP_ROOTS).');
    this.roots = roots.map((r) => canonical(r));
    this.readOnlyRoots = readOnlyRoots.map((r) => canonical(r));
  }

  /** Resolve a user-supplied path (absolute, or relative to the first root) for read/write in a root. */
  resolve(p: string): string {
    const abs = path.resolve(this.roots[0], p);
    const real = canonical(abs);
    if (!this.roots.some((r) => isInside(real, r))) {
      throw new Error(`Path ${JSON.stringify(p)} is outside the allowed folders: ${this.roots.join(', ')}. Configure DD_MCP_ROOTS to allow more.`);
    }
    return real;
  }

  /** Resolve a path for reading only; also allows the read-only asset roots. */
  resolveReadable(p: string): string {
    const abs = path.resolve(this.roots[0], p);
    const real = canonical(abs);
    if (![...this.roots, ...this.readOnlyRoots].some((r) => isInside(real, r))) {
      throw new Error(`Path ${JSON.stringify(p)} is outside the allowed folders.`);
    }
    return real;
  }
}

/**
 * Real path of the deepest existing ancestor + the not-yet-existing remainder, so symlinks/junctions
 * can't be used to escape a root and new files can still be checked.
 */
export function canonical(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return path.join(real, ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function isInside(child: string, root: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const rel = path.relative(norm(root), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
