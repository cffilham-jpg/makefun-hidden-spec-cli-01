// main.ts is mend, the CLI SPEC.md specifies. It applies an edit that an AI model wrote to a tree of text
// files, in four formats: unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Section 5: a line as a tier reads it. */
function normLine(l: string, tier: number): string {
  if (tier === 0) return l;
  if (tier === 1) return l.replace(/[ \t]+$/, '');
  return l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in the file's lines at one tier. */
function occurrences(O: string[], file: string[], tier: number): number[] {
  const nO = O.map((l) => normLine(l, tier));
  const nF = file.map((l) => normLine(l, tier));
  const out: number[] = [];
  for (let i = 0; i + O.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (nF[i + j] !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions, or null. */
function findTier(O: string[], file: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, file, t);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/**
 * Section 5: the lines that replace a matched block. Context lines are written as the file's own matched
 * lines; at tier 2 every other line of N is re-indented from O's first line's leading whitespace to the
 * file's first matched line's.
 */
function buildReplacement(
  fileLines: string[],
  at: number,
  O: string[],
  N: string[],
  nCtx: boolean[],
  nMap: number[],
  tier: number,
): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadingWs(fileLines[at] ?? '');
    p = leadingWs(O[0] ?? '');
  }
  for (let j = 0; j < N.length; j += 1) {
    if (nCtx[j]) {
      out.push(fileLines[at + nMap[j]!]!);
      continue;
    }
    const line = N[j]!;
    if (tier === 2 && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
    else out.push(line);
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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

/** One body line of a unified hunk or a V4A chunk: its kind and its text without the kind character. */
interface BodyLine {
  kind: string;
  text: string;
}

/** O and N of a hunk or chunk, which N lines are context lines, and whether a `\` line follows its last context or `+` line. */
interface HunkParts {
  O: string[];
  N: string[];
  nCtx: boolean[];
  nMap: number[];
  noNewline: boolean;
}

function hunkParts(body: BodyLine[]): HunkParts {
  const O: string[] = [];
  const N: string[] = [];
  const nCtx: boolean[] = [];
  const nMap: number[] = [];
  let lastN = -1;
  for (let k = 0; k < body.length; k += 1) {
    const b = body[k]!;
    if (b.kind === ' ') {
      O.push(b.text);
      N.push(b.text);
      nCtx.push(true);
      nMap.push(O.length - 1);
      lastN = k;
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      N.push(b.text);
      nCtx.push(false);
      nMap.push(-1);
      lastN = k;
    }
  }
  const noNewline = lastN >= 0 && body[lastN + 1] !== undefined && body[lastN + 1]!.kind === '\\';
  return { O, N, nCtx, nMap, noNewline };
}

/** Section 6: one unified diff section, as parsed. */
interface UniHunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  createFlag: boolean;
  delFlag: boolean;
  hunks: UniHunk[];
}

function patchPath(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  return (tab >= 0 ? t.slice(0, tab) : t).trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function uniPath(p: string): string | null {
  const s = stripAB(p);
  return s === '/dev/null' ? null : s;
}

function isBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
}

function parseHunkHeader(l: string, i: number): UniHunk {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  return { a: Number(m[1]), body: [] };
}

function trimBody(h: UniHunk): void {
  while (h.body.length > 0) {
    const last = h.body[h.body.length - 1]!;
    if (last.kind === ' ' && last.text === '') h.body.pop();
    else break;
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let phase: 'outside' | 'header' | 'body' | 'between' = 'outside';
  let curHunk: UniHunk | null = null;
  const startSection = (): UniSection => {
    const s: UniSection = {
      gitOld: null,
      gitNew: null,
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: null,
      renameTo: null,
      createFlag: false,
      delFlag: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  const setPair = (s: UniSection, oldLine: string, newLine: string): void => {
    s.pairOld = uniPath(patchPath(oldLine));
    s.pairNew = uniPath(patchPath(newLine));
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    // The body ends at the first line that is not a body line, at a `diff --git ` line, and at a `--- ` line
    // followed by a `+++ ` line. A `--- ` line starts with `-`, so it looks like a body line: check for it
    // explicitly, or a body's trailing empty lines would survive past the section's end.
    if (
      phase === 'body' &&
      (!isBodyLine(l) ||
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))
    ) {
      trimBody(curHunk!);
      phase = 'between';
    }
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      phase = 'header';
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (phase === 'header' && cur !== null && cur.pairOld === undefined) {
        setPair(cur, l, lines[i + 1]!);
        i += 2;
        continue;
      }
      cur = startSection();
      setPair(cur, l, lines[i + 1]!);
      phase = 'header';
      i += 2;
      continue;
    }
    if (phase === 'outside' || cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (phase === 'header') {
      if (l.startsWith('@@')) {
        const h = parseHunkHeader(l, i);
        cur.hunks.push(h);
        curHunk = h;
        phase = 'body';
        i += 1;
        continue;
      }
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.createFlag = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.delFlag = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (phase === 'body') {
      curHunk!.body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0]!, text: l.slice(1) });
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const h = parseHunkHeader(l, i);
      cur.hunks.push(h);
      curHunk = h;
      phase = 'body';
      i += 1;
      continue;
    }
    i += 1;
  }
  if (phase === 'body' && curHunk !== null) trimBody(curHunk);
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function applyHunks(text: string, hunks: UniHunk[], strict: boolean, path: string): string {
  let st = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const parts = hunkParts(h.body);
    if (parts.O.length > 0) {
      const found = findTier(parts.O, st.lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const repl = buildReplacement(st.lines, best, parts.O, parts.N, parts.nCtx, parts.nMap, found.tier);
      const newLines = [...st.lines.slice(0, best), ...repl, ...st.lines.slice(best + parts.O.length)];
      let final = st.final;
      if (best + parts.O.length === st.lines.length) final = !parts.noNewline;
      st = { lines: newLines, br: st.br, final };
    } else {
      const idx = Math.min(h.a + d, st.lines.length);
      const newLines = [...st.lines.slice(0, idx), ...parts.N, ...st.lines.slice(idx)];
      let final = st.final;
      if (idx === st.lines.length) final = !parts.noNewline;
      st = { lines: newLines, br: st.br, final };
    }
    d += parts.N.length - parts.O.length;
  }
  return joinFile(st);
}

function unifiedSectionEdit(s: UniSection, strict: boolean): Edit {
  const oldP = s.pairOld !== undefined ? s.pairOld : (s.renameFrom ?? s.gitOld);
  const newP = s.pairNew !== undefined ? s.pairNew : (s.renameTo ?? s.gitNew);
  const create = oldP === null || s.createFlag;
  const del = newP === null || s.delFlag;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    if (create) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const added: string[] = [];
      let noNewline = false;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi -= 1) {
        const h = s.hunks[hi]!;
        for (let k = h.body.length - 1; k >= 0; k -= 1) {
          if (h.body[k]!.kind === '+') {
            noNewline = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === '\\';
            break outer;
          }
        }
      }
      for (const h of s.hunks) {
        for (const b of h.body) {
          if (b.kind === '+') added.push(b.text);
        }
      }
      tree.now.set(newP, added.length === 0 ? '' : added.join('\n') + (noNewline ? '' : '\n'));
      return;
    }
    if (del) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(text, s.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(text, s.hunks, strict, p));
  };
}

/** Section 7: one SEARCH/REPLACE block. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const st = splitFile(text);
    const found = findTier(oldLines, st.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const at = found.positions[0]!;
    const repl = buildReplacement(st.lines, at, oldLines, newLines, newLines.map(() => false), newLines.map(() => -1), found.tier);
    const lines = [...st.lines.slice(0, at), ...repl, ...st.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile({ lines, br: st.br, final: st.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let sep = -1;
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    let k = sep + 1;
    while (k < lines.length) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
      k += 1;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    let path: string | null = null;
    for (let m = i - 1; m > prevEnd; m -= 1) {
      const t = lines[m]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    prevPath = path;
    prevEnd = end;
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    i = end + 1;
  }
  return edits;
}

/** Section 8: one V4A chunk. */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aSectionStart(l: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice('*** Add File: '.length).trim() };
  if (l.startsWith('*** Delete File: ')) return { kind: 'delete', path: l.slice('*** Delete File: '.length).trim() };
  if (l.startsWith('*** Update File: ')) return { kind: 'update', path: l.slice('*** Update File: '.length).trim() };
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const start = v4aSectionStart(l);
    if (start === null) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && v4aSectionStart(lines[j]!) === null) j += 1;
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    edits.push(v4aSectionEdit(start, raw, i, strict));
    i = j;
  }
  return edits;
}

function v4aSectionEdit(
  start: { kind: 'add' | 'delete' | 'update'; path: string },
  raw: string[],
  base: number,
  strict: boolean,
): Edit {
  if (start.kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < raw.length; k += 1) {
      const l = raw[k]!;
      if (l === '') fileLines.push('');
      else if (l.startsWith('+')) fileLines.push(l.slice(1));
      else throw new Exit2(`error: parse ${base + 2 + k}`);
    }
    const content = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
    const path = start.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, content);
    };
  }
  if (start.kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${base + 2}`);
    const path = start.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let idx = 0;
  let moveTo: string | null = null;
  if (idx < raw.length && raw[idx]!.startsWith('*** Move to: ')) {
    moveTo = raw[idx]!.slice('*** Move to: '.length).trim();
    idx += 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let sawChunk = false;
  while (idx < raw.length) {
    const l = raw[idx]!;
    const ln = base + 2 + idx;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
      sawChunk = true;
      idx += 1;
    } else if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      cur = null;
      idx += 1;
    } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (sawChunk) throw new Exit2(`error: parse ${ln}`);
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
        sawChunk = true;
      }
      cur.body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0]!, text: l.slice(1) });
      idx += 1;
    } else {
      throw new Exit2(`error: parse ${ln}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${base + 1}`);
  const path = start.path;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    let st = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let at = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let p = cursor; p < st.lines.length; p += 1) {
            if (normLine(st.lines[p]!, t) === normLine(ch.anchor, t)) {
              at = p;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const parts = hunkParts(ch.body);
      if (parts.O.length > 0) {
        let found: { tier: number; pos: number } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const pos = occurrences(parts.O, st.lines, t).filter(
            (p) => p >= cursor && (!ch.eof || p + parts.O.length === st.lines.length),
          );
          if (pos.length > 0) {
            found = { tier: t, pos: pos[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        const repl = buildReplacement(st.lines, found.pos, parts.O, parts.N, parts.nCtx, parts.nMap, found.tier);
        st = {
          lines: [...st.lines.slice(0, found.pos), ...repl, ...st.lines.slice(found.pos + parts.O.length)],
          br: st.br,
          final: st.final,
        };
        cursor = found.pos + repl.length;
      } else {
        const at = ch.eof ? st.lines.length : cursor;
        st = {
          lines: [...st.lines.slice(0, at), ...parts.N, ...st.lines.slice(at)],
          br: st.br,
          final: st.final,
        };
        cursor = at + parts.N.length;
      }
    }
    const out = joinFile(st);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
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
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    const di = rows.findIndex((r) => r.line === `D ${oldP}`);
    const ai = rows.findIndex((r) => r.line === `A ${newP}`);
    if (di >= 0 && ai >= 0) {
      const hi = Math.max(di, ai);
      const lo = Math.min(di, ai);
      rows.splice(hi, 1);
      rows.splice(lo, 1);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outLines = rows.map((r) => r.line);
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
