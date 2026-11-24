// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It covers sections 1 to 10 of SPEC.md: the command line, output and exit codes, safe paths, format detection,
// three-tier matching (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches
// (section 8), JSON edits (section 9) and the all-or-nothing write (section 10).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 5: matching, and the file model (section 3) ----

let strictMode = false;

interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function tierEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrences(fileLines: string[], O: string[], from: number, tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEqual(fileLines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findOcc(fileLines: string[], O: string[], from: number): { tier: number; occ: number[] } | null {
  const tiers = strictMode ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(fileLines, O, from, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// A line of N: either a context line (written as the file's own line at O index ctx)
// or a fresh line (written as its text, possibly re-indented at tier 2).
type NLine = { ctx: number } | { text: string };

function buildN(fileLines: string[], at: number, O: string[], N: NLine[], tier: number): string[] {
  if (O.length === 0) {
    return N.map((n) => ('ctx' in n ? fileLines[at + n.ctx]! : n.text));
  }
  const F = leadWs(fileLines[at] ?? '');
  const P = leadWs(O[0]!);
  return N.map((n) => {
    if ('ctx' in n) return fileLines[at + n.ctx]!;
    const txt = n.text;
    if (tier !== 2) return txt;
    if (txt === '' || txt.trim() === '') return txt;
    if (!txt.startsWith(P)) return txt;
    return F + txt.slice(P.length);
  });
}

// ---- Section 6: unified diffs ----

interface Hunk {
  A: number;
  O: string[];
  N: NLine[];
  noEolCtxPlus: boolean;
  noEolPlus: boolean;
}

function applyHunks(before: string, hunks: Hunk[], errPath: string): string {
  const parts = splitFile(before);
  const lines = [...parts.lines];
  let finalBr = parts.final;
  let d = 0;
  for (const h of hunks) {
    if (h.O.length > 0) {
      const found = findOcc(lines, h.O, 0);
      if (found === null) throw new Fail('no-match', errPath);
      const target = h.A - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const touchesEnd = best + h.O.length === lines.length;
      const built = buildN(lines, best, h.O, h.N, found.tier);
      lines.splice(best, h.O.length, ...built);
      if (touchesEnd) finalBr = !h.noEolCtxPlus;
      d += h.N.length - h.O.length;
    } else {
      const insertPos = Math.max(0, Math.min(h.A + d, lines.length));
      const touchesEnd = insertPos === lines.length;
      const built = buildN(lines, insertPos, h.O, h.N, 0);
      lines.splice(insertPos, 0, ...built);
      if (touchesEnd) finalBr = !h.noEolCtxPlus;
      d += h.N.length;
    }
  }
  return joinFile(lines, parts.br, finalBr);
}

function unifiedEdits(lines: string[]): Edit[] {
  interface Mutable {
    pairOld?: string | null;
    pairNew?: string | null;
    renOld?: string;
    renNew?: string;
    diffOld?: string;
    diffNew?: string;
    isCreate: boolean;
    isDelete: boolean;
    hasPair: boolean;
    hasHunk: boolean;
    hunks: Hunk[];
  }
  const secs: Mutable[] = [];
  let cur: Mutable | null = null;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const pairPath = (line: string): string => line.slice(4).split('\t')[0]!.trim();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = diffRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { isCreate: false, isDelete: false, hasPair: false, hasHunk: false, hunks: [], diffOld: m[1], diffNew: m[2] };
      secs.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = Number(m[1]);
      let j = i + 1;
      const body: string[] = [];
      while (j < lines.length) {
        const lj = lines[j]!;
        if (lj.startsWith('diff --git ')) break;
        if (lj.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (lj === '' || lj[0] === ' ' || lj[0] === '-' || lj[0] === '+' || lj[0] === '\\') {
          body.push(lj);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const O: string[] = [];
      const N: NLine[] = [];
      const kinds: string[] = [];
      for (const b of body) {
        if (b.startsWith('\\')) {
          kinds.push('back');
          continue;
        }
        if (b === '') {
          const idx = O.length;
          O.push('');
          N.push({ ctx: idx });
          kinds.push('ctx');
        } else if (b[0] === ' ') {
          const txt = b.slice(1);
          const idx = O.length;
          O.push(txt);
          N.push({ ctx: idx });
          kinds.push('ctx');
        } else if (b[0] === '-') {
          O.push(b.slice(1));
          kinds.push('minus');
        } else {
          N.push({ text: b.slice(1) });
          kinds.push('plus');
        }
      }
      let lastCP = -1;
      for (let k = 0; k < kinds.length; k++) if (kinds[k] === 'ctx' || kinds[k] === 'plus') lastCP = k;
      const noEolCtxPlus = lastCP >= 0 && kinds[lastCP + 1] === 'back';
      let lastPlus = -1;
      for (let k = 0; k < kinds.length; k++) if (kinds[k] === 'plus') lastPlus = k;
      const noEolPlus = lastPlus >= 0 && kinds[lastPlus + 1] === 'back';
      cur.hunks.push({ A, O, N, noEolCtxPlus, noEolPlus });
      cur.hasHunk = true;
      i = j;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const oldRaw = pairPath(line);
        const newRaw = pairPath(next);
        const oldP = oldRaw === '/dev/null' ? null : stripAB(oldRaw);
        const newP = newRaw === '/dev/null' ? null : stripAB(newRaw);
        if (cur === null) {
          cur = { isCreate: false, isDelete: false, hasPair: true, hasHunk: false, hunks: [], pairOld: oldP, pairNew: newP };
          secs.push(cur);
        } else if (!cur.hasHunk && !cur.hasPair) {
          cur.pairOld = oldP;
          cur.pairNew = newP;
          cur.hasPair = true;
        } else {
          cur = { isCreate: false, isDelete: false, hasPair: true, hasHunk: false, hunks: [], pairOld: oldP, pairNew: newP };
          secs.push(cur);
        }
        i += 2;
        continue;
      }
      if (cur !== null && !cur.hasHunk) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && !cur.hasHunk) {
      if (line.startsWith('rename from ')) cur.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  const edits: Edit[] = [];
  for (const s of secs) {
    const oldFinal = s.pairOld !== undefined ? s.pairOld : s.renOld !== undefined ? s.renOld : s.diffOld;
    const newFinal = s.pairNew !== undefined ? s.pairNew : s.renNew !== undefined ? s.renNew : s.diffNew;
    const isCreate = s.isCreate || oldFinal === null;
    const isDelete = s.isDelete || newFinal === null;
    const hunks = s.hunks;
    edits.push((tree) => {
      if (isCreate) {
        const newPath = newFinal as string | null | undefined;
        if (newPath === null || newPath === undefined) throw new Fail('unsafe', '');
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const plus: string[] = [];
        for (const h of hunks) for (const n of h.N) if ('text' in n) plus.push(n.text);
        let noEol = false;
        for (let hi = hunks.length - 1; hi >= 0; hi--) {
          const h = hunks[hi]!;
          if (h.N.some((n) => 'text' in n)) {
            noEol = h.noEolPlus;
            break;
          }
        }
        const text = plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n');
        tree.now.set(newPath, text);
        return;
      }
      if (isDelete) {
        const oldPath = oldFinal as string | null | undefined;
        if (oldPath === null || oldPath === undefined) throw new Fail('unsafe', '');
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      const isMove =
        oldFinal !== undefined && newFinal !== undefined && oldFinal !== null && newFinal !== null && oldFinal !== newFinal;
      if (isMove) {
        const oldPath = oldFinal as string;
        const newPath = newFinal as string;
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const result = applyHunks(tree.get(oldPath)!, hunks, oldPath);
        tree.now.set(newPath, result);
        tree.now.set(oldPath, null);
        tree.moves.push([oldPath, newPath]);
        return;
      }
      const p = (oldFinal ?? newFinal) as string | null | undefined;
      if (p === null || p === undefined) throw new Fail('unsafe', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      const result = applyHunks(tree.get(p)!, hunks, p);
      tree.now.set(p, result);
    });
  }
  return edits;
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdits(lines: string[]): Edit[] {
  interface Block {
    path: string;
    old: string[];
    nw: string[];
  }
  const blocks: Block[] = [];
  let i = 0;
  let prevEnd = -1;
  for (;;) {
    let s = -1;
    for (let k = i; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        r = k;
        break;
      }
    }
    if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    blocks.push({ path, old: lines.slice(s + 1, eq), nw: lines.slice(eq + 1, r) });
    prevEnd = r;
    i = r + 1;
  }
  return blocks.map((b) => {
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.old.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        const text = b.nw.length === 0 ? '' : b.nw.join('\n') + '\n';
        tree.now.set(b.path, text);
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const parts = splitFile(before);
      const found = findOcc(parts.lines, b.old, 0);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
      const at = found.occ[0]!;
      const Nlines: NLine[] = b.nw.map((t) => ({ text: t }));
      const built = buildN(parts.lines, at, b.old, Nlines, found.tier);
      const out = [...parts.lines];
      out.splice(at, b.old.length, ...built);
      tree.now.set(b.path, joinFile(out, parts.br, parts.final));
    };
  });
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let lastIdx = -1;
  for (let k = 0; k < lines.length; k++) if (!blank(lines[k]!)) lastIdx = k;
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const addPref = '*** Add File: ';
  const delPref = '*** Delete File: ';
  const updPref = '*** Update File: ';
  const movePref = '*** Move to: ';
  interface VSection {
    kind: 'add' | 'delete' | 'update';
    path: string;
    lineNo: number;
    fileLines: string[];
    moveTo?: string;
    chunks: VChunk[];
  }
  const secs: VSection[] = [];
  let i = first + 1;
  while (i < lastIdx) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith(addPref)) {
      kind = 'add';
      path = line.slice(addPref.length).trim();
    } else if (line.startsWith(delPref)) {
      kind = 'delete';
      path = line.slice(delPref.length).trim();
    } else if (line.startsWith(updPref)) {
      kind = 'update';
      path = line.slice(updPref.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i++;
    const raw: { text: string; lineNo: number }[] = [];
    while (i < lastIdx) {
      const l2 = lines[i]!;
      if (l2.startsWith(addPref) || l2.startsWith(delPref) || l2.startsWith(updPref)) break;
      raw.push({ text: l2, lineNo: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.lineNo}`);
      }
      secs.push({ kind, path, lineNo: startLine, fileLines, chunks: [] });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.lineNo}`);
      secs.push({ kind, path, lineNo: startLine, fileLines: [], chunks: [] });
    } else {
      let moveTo: string | undefined = undefined;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith(movePref)) {
        moveTo = raw[0]!.text.slice(movePref.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      const isBody = (t: string): boolean => t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+';
      let firstChunk = true;
      while (idx < raw.length) {
        const chunk: VChunk = { anchor: null, eof: false, O: [], N: [] };
        const start = raw[idx]!;
        if (start.text.startsWith('@@')) {
          const a = start.text.slice(2).trim();
          chunk.anchor = a === '' ? null : a;
          idx++;
        } else if (firstChunk && isBody(start.text)) {
          // chunk starts at a body line, no anchor
        } else {
          throw new Exit2(`error: parse ${start.lineNo}`);
        }
        while (idx < raw.length) {
          const curLine = raw[idx]!;
          const t = curLine.text;
          if (t === '*** End of File') {
            chunk.eof = true;
            idx++;
            break;
          }
          if (t.startsWith('@@')) break;
          if (isBody(t)) {
            if (t === '') {
              const oi = chunk.O.length;
              chunk.O.push('');
              chunk.N.push({ ctx: oi });
            } else if (t[0] === ' ') {
              const txt = t.slice(1);
              const oi = chunk.O.length;
              chunk.O.push(txt);
              chunk.N.push({ ctx: oi });
            } else if (t[0] === '-') {
              chunk.O.push(t.slice(1));
            } else {
              chunk.N.push({ text: t.slice(1) });
            }
            idx++;
            continue;
          }
          throw new Exit2(`error: parse ${curLine.lineNo}`);
        }
        chunks.push(chunk);
        firstChunk = false;
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${startLine}`);
      secs.push({ kind, path, lineNo: startLine, fileLines: [], moveTo, chunks });
    }
  }
  const edits: Edit[] = [];
  for (const s of secs) {
    if (s.kind === 'add') {
      const path = s.path;
      const fileLines = s.fileLines;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
        tree.now.set(path, text);
      });
    } else if (s.kind === 'delete') {
      const path = s.path;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      const path = s.path;
      const moveTo = s.moveTo;
      const chunks = s.chunks;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        if (tree.get(path) === null) throw new Fail('missing', path);
        if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const before = tree.get(path)!;
        const parts = splitFile(before);
        const linesOut = [...parts.lines];
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const found = findOcc(linesOut, [ch.anchor], cursor);
            if (found === null) throw new Fail('no-match', path);
            cursor = found.occ[0]! + 1;
          }
          if (ch.O.length === 0) {
            const insertPos = ch.eof ? linesOut.length : Math.min(cursor, linesOut.length);
            const built = buildN(linesOut, insertPos, ch.O, ch.N, 0);
            linesOut.splice(insertPos, 0, ...built);
            cursor = insertPos + built.length;
          } else if (ch.eof) {
            let chosen: number | null = null;
            let tierUsed = 0;
            const tiers = strictMode ? [0] : [0, 1, 2];
            for (const t of tiers) {
              const occ = occurrences(linesOut, ch.O, cursor, t).filter((p) => p + ch.O.length === linesOut.length);
              if (occ.length > 0) {
                chosen = occ[0]!;
                tierUsed = t;
                break;
              }
            }
            if (chosen === null) throw new Fail('no-match', path);
            const built = buildN(linesOut, chosen, ch.O, ch.N, tierUsed);
            linesOut.splice(chosen, ch.O.length, ...built);
            cursor = chosen + built.length;
          } else {
            const found = findOcc(linesOut, ch.O, cursor);
            if (found === null) throw new Fail('no-match', path);
            const at = found.occ[0]!;
            const built = buildN(linesOut, at, ch.O, ch.N, found.tier);
            linesOut.splice(at, ch.O.length, ...built);
            cursor = at + built.length;
          }
        }
        const result = joinFile(linesOut, parts.br, parts.final);
        if (moveTo !== undefined) {
          tree.now.set(moveTo, result);
          tree.now.set(path, null);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, result);
        }
      });
    }
  }
  return edits;
}

// ---- Section 1, 2, 10: run ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  strictMode = strict;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else if (kind === 'v4a') edits = v4aEdits(lines);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows, collapsing qualifying moves into R lines sorted by the new path.
  const rPairs: [string, string][] = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rPairs.push([oldP, newP]);
      rOld.add(oldP);
      rNew.add(newP);
    }
  }
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()]) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of rPairs) rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
