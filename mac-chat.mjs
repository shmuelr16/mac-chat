#!/usr/bin/env node
// mac-chat: a fullscreen terminal chat over OpenRouter's free models.
// Runs on the alternate screen and redraws every frame, so nothing lands in the scrollback.
// The API key lives in the macOS Keychain; set-key.sh asks for it in a native dialog.
// The model can run shell commands and read/write files; risky actions wait for the user's approval.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(homedir(), '.config', 'mac-chat', 'config.json');
const API = 'https://openrouter.ai/api/v1';
const AUTO_MODEL = 'openrouter/free';
const DEFAULT_MODEL = 'google/gemma-4-31b-it:free';
// Tried in order when the chosen free model is busy or down.
const FALLBACK_MODELS = [DEFAULT_MODEL, 'nvidia/nemotron-3-super-120b-a12b:free', AUTO_MODEL];
const MAX_STEPS = 30; // model calls per user message

const out = process.stdout;
const stdin = process.stdin;

// ── key & config ──────────────────────────────────────────────

const KEYCHAIN = ['-s', 'mac-chat', '-a', 'openrouter'];

function readKey() {
  try {
    return execFileSync('security', ['find-generic-password', ...KEYCHAIN, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function askForKey(quiet = false) {
  spawnSync(path.join(DIR, 'set-key.sh'), { stdio: quiet ? 'ignore' : 'inherit' });
  return readKey();
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig() {
  try {
    mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(state.config, null, 2));
  } catch {}
}

// ── colors ────────────────────────────────────────────────────

const TRUECOLOR =
  /truecolor|24bit/i.test(process.env.COLORTERM || '') || /iTerm|WezTerm|ghostty|vscode/i.test(process.env.TERM_PROGRAM || '');
const to256 = (r, g, b) => 16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51);
const fg = ([r, g, b]) => (TRUECOLOR ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${to256(r, g, b)}m`);
const bg = ([r, g, b]) => (TRUECOLOR ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${to256(r, g, b)}m`);
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';

const PINK = [244, 80, 170];
const VIOLET = [139, 92, 246];
const CYAN = [34, 190, 230];
const GREEN = [52, 211, 153];
const RED = [248, 90, 100];
const AMBER = [245, 170, 40];
const WHITE = [255, 255, 255];
const CODE_BG = [28, 28, 44];
const CODE_FG = [205, 214, 244];
const PICK_BG = [109, 40, 217];
const GRADIENT = [PINK, VIOLET, CYAN];
const LOOP = [PINK, VIOLET, CYAN, VIOLET, PINK];

function mix(stops, t) {
  t = Math.min(1, Math.max(0, t));
  const n = stops.length - 1;
  const i = Math.min(n - 1, Math.floor(t * n));
  const f = t * n - i;
  return stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
}

// Colors each grapheme along the gradient; a numeric `phase` slides a looping gradient for shimmer.
function gradient(text, phase = null, extra = '') {
  const gs = graphemes(text);
  const n = Math.max(1, gs.length - 1);
  const colored = gs.map((g, i) => {
    if (g === ' ') return g;
    const color = phase === null ? mix(GRADIENT, i / n) : mix(LOOP, ((i / n) * 0.5 + phase) % 1);
    return fg(color) + extra + g;
  });
  return colored.join('') + RESET;
}

// ── text measurement & bidi ───────────────────────────────────

const segmenter = new Intl.Segmenter();
const graphemes = (s) => Array.from(segmenter.segment(s), (x) => x.segment);
const WIDE_SYMBOLS =
  /[⌚⌛⏩-⏬⏰⏳◽◾☔☕♈-♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓-❕❗➕-➗➰➿⬛⬜⭐⭕]/;

function charWidth(cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x591 && cp <= 0x5c7 && ![0x5be, 0x5c0, 0x5c3, 0x5c6].includes(cp))) return 0;
  if ((cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f1e6 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) ||
    WIDE_SYMBOLS.test(String.fromCodePoint(cp))
  )
    return 2;
  return 1;
}

const graphemeWidth = (g) => (g.includes('️') ? 2 : charWidth(g.codePointAt(0)));
const textWidth = (s) => graphemes(s).reduce((w, g) => w + graphemeWidth(g), 0);

const STRONG = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-ࣿיִ-﷿ﹰ-ﻼ]/;
const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
// Direction by word majority (ties go to the first strong word), so Hebrew with English terms stays RTL.
function isRtl(text) {
  let rtl = 0;
  let ltr = 0;
  let first = null;
  for (const word of text.split(/\s+/)) {
    const c = word.match(STRONG)?.[0];
    if (!c) continue;
    const r = RTL_CHAR.test(c);
    first ??= r;
    if (r) rtl++;
    else ltr++;
  }
  return rtl === ltr ? !!first : rtl > ltr;
}

// Terminal.app lays every row out left-to-right; an RLI…PDI isolate makes a span read right-to-left.
const he = (text) => (isRtl(text) ? `⁧${text}⁩` : text);

// ── lines: { s: styled string, w: visible width } ─────────────

const EMPTY = { s: '', w: 0 };

const toLine = (tokens) => ({
  s: tokens.map(({ t, s }) => (s ? s + t + RESET : t)).join(''),
  w: tokens.reduce((w, { t }) => w + textWidth(t), 0),
});

const rtlRow = (line, width) => ({
  s: ' '.repeat(Math.max(0, width - line.w)) + `⁧${line.s}⁩`,
  w: Math.max(width, line.w),
});

function inline(text, base = '') {
  const tokens = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) tokens.push({ t: text.slice(last, m.index), s: base });
    const x = m[0];
    if (x[0] === '`') tokens.push({ t: x.slice(1, -1), s: fg(PINK) });
    else if (x[0] === '[') {
      const [, label, url] = x.match(/^\[([^\]]+)\]\((.+)\)$/);
      tokens.push({ t: label, s: base + '\x1b[4m' + fg(CYAN) });
      if (url !== label) tokens.push({ t: ` (${url})`, s: DIM });
    } else if (x.startsWith('**') || x.startsWith('__')) tokens.push({ t: x.slice(2, -2), s: base + BOLD });
    else tokens.push({ t: x.slice(1, -1), s: base + ITALIC });
    last = m.index + x.length;
  }
  if (last < text.length) tokens.push({ t: text.slice(last), s: base });
  return tokens;
}

// Greedy word wrap over styled tokens; words longer than a row are split by grapheme.
function wrapTokens(tokens, width) {
  const rows = [];
  let row = [];
  let used = 0;
  const add = (t, s) => {
    const last = row[row.length - 1];
    if (last && last.s === s) last.t += t;
    else row.push({ t, s });
  };
  const breakRow = () => {
    const last = row[row.length - 1];
    if (last) last.t = last.t.replace(/\s+$/, '');
    rows.push(row);
    row = [];
    used = 0;
  };
  for (const { t, s } of tokens) {
    for (const word of t.split(/(\s+)/)) {
      if (!word) continue;
      const w = textWidth(word);
      if (/^\s+$/.test(word)) {
        if (used > 0 && used + w <= width) {
          add(word, s);
          used += w;
        }
        continue;
      }
      if (used > 0 && used + w > width) breakRow();
      if (w <= width) {
        add(word, s);
        used += w;
        continue;
      }
      for (const g of graphemes(word)) {
        const gw = graphemeWidth(g);
        if (used + gw > width) breakRow();
        add(g, s);
        used += gw;
      }
    }
  }
  if (row.length || !rows.length) breakRow();
  return rows;
}

function hardWrap(text, width) {
  const parts = [];
  let cur = '';
  let used = 0;
  for (const g of graphemes(text)) {
    const w = graphemeWidth(g);
    if (used + w > width) {
      parts.push(cur);
      cur = '';
      used = 0;
    }
    cur += g;
    used += w;
  }
  parts.push(cur);
  return parts;
}

// Wraps one paragraph. `mark` is a bullet, number or quote bar; RTL paragraphs are right-aligned and read RTL.
function paragraph(tokens, width, { indent = 0, mark = '', markStyle = fg(PINK) + BOLD, markEveryRow = false } = {}) {
  const rtl = isRtl(tokens.map((t) => t.t).join(''));
  const headW = indent + (mark ? textWidth(mark) + 1 : 0);
  return wrapTokens(tokens, Math.max(8, width - headW)).map((row, i) => {
    const head =
      mark && (i === 0 || markEveryRow)
        ? [{ t: ' '.repeat(indent), s: '' }, { t: mark, s: markStyle }, { t: ' ', s: '' }]
        : [{ t: ' '.repeat(headW), s: '' }];
    const line = toLine([...head, ...row]);
    return rtl ? rtlRow(line, width) : line;
  });
}

const codeLine = (text, width, style = '') => ({
  s: bg(CODE_BG) + fg(CODE_FG) + style + ' ' + text + ' '.repeat(Math.max(0, width - 1 - textWidth(text))) + RESET,
  w: width,
});

function block(raw, width) {
  let m;
  if ((m = raw.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/)))
    return paragraph(inline(m[2], BOLD + fg(m[1].length <= 2 ? PINK : VIOLET)), width);
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) return [{ s: DIM + '─'.repeat(width) + RESET, w: width }];
  if ((m = raw.match(/^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/)))
    return paragraph(inline(m[3]), width, { indent: Math.min(m[1].length, 8), mark: /\d/.test(m[2]) ? m[2] : '•' });
  if ((m = raw.match(/^\s*>\s?(.*)$/)))
    return paragraph(inline(m[1], ITALIC), width, { mark: '│', markStyle: fg(VIOLET), markEveryRow: true });
  if (/^\s*\|.*\|\s*$/.test(raw)) {
    if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) return [];
    const cells = raw.trim().slice(1, -1).split('|').map((c) => c.trim());
    return paragraph(inline(cells.join('  ·  ')), width);
  }
  return paragraph(inline(raw.trim()), width);
}

function renderMarkdown(text, width) {
  const lines = [];
  let inCode = false;
  for (const raw of text.replace(/\r/g, '').replace(/\t/g, '  ').split('\n')) {
    const fence = raw.match(/^\s*```\s*([\w+#.-]*)/);
    if (fence) {
      inCode = !inCode;
      lines.push(codeLine(inCode ? fence[1] : '', width, DIM));
      continue;
    }
    if (inCode) {
      for (const part of hardWrap(raw, width - 2)) lines.push(codeLine(part, width));
      continue;
    }
    if (!raw.trim()) {
      if (lines.length && lines[lines.length - 1] !== EMPTY) lines.push(EMPTY);
      continue;
    }
    lines.push(...block(raw, width));
  }
  while (lines[lines.length - 1] === EMPTY) lines.pop();
  return lines;
}

const renderPlain = (text, width) =>
  text.split('\n').flatMap((l) => (l.trim() ? paragraph([{ t: l.replace(/\t/g, '  '), s: '' }], width) : [EMPTY]));

// ── state ─────────────────────────────────────────────────────

const state = {
  config: { model: DEFAULT_MODEL },
  // user/note: { content }; assistant: { content, model, toolCalls, error?, stopped? }; tool: { callId, name, args, status, result }
  messages: [],
  cwd: process.cwd(),
  busy: false, // a user message is being worked on (model calls + tools)
  cancel: false,
  running: null, // { kill } for the shell command in progress
  approval: null, // { tool, resolve } while waiting for y/n/a
  autoApprove: false,
  input: '',
  cursor: 0,
  pasting: false,
  lastCR: false,
  scroll: 0,
  maxScroll: 0,
  lastLineCount: 0,
  stream: null, // { msg, ctrl, start }
  picker: null, // { items, index, loading, error }
  models: null,
  toast: null,
  frame: 0,
  renderQueued: false,
};
let apiKey = '';

const COMMANDS = [
  ['/new', 'שיחה חדשה'],
  ['/model', 'בחירת מודל'],
  ['/copy', 'העתקת התשובה האחרונה'],
  ['/auto', 'אישור אוטומטי לפעולות'],
  ['/key', 'החלפת מפתח'],
  ['/help', 'עזרה'],
  ['/exit', 'יציאה'],
];

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const spinner = () => SPINNER[state.frame % SPINNER.length];
const shortModel = (id) => (id === AUTO_MODEL ? 'auto' : id.split('/').pop().replace(/:free$/, ''));

function toast(text, color = GREEN) {
  state.toast = { text, color, until: Date.now() + 2600 };
}

// ── drawing ───────────────────────────────────────────────────

const FONT = {
  M: ['███╗   ███╗', '████╗ ████║', '██╔████╔██║', '██║╚██╔╝██║', '██║ ╚═╝ ██║', '╚═╝     ╚═╝'],
  A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  C: [' ██████╗', '██╔════╝', '██║     ', '██║     ', '╚██████╗', ' ╚═════╝'],
  H: ['██╗  ██╗', '██║  ██║', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
  '-': ['        ', '        ', ' █████╗ ', ' ╚════╝ ', '        ', '        '],
};
const LOGO = FONT.M.map((_, r) => [...'MAC-CHAT'].map((ch) => FONT[ch][r]).join(''));
const LOGO_W = [...LOGO[0]].length;

function shimmer(row, phase) {
  const chars = [...row];
  const colored = chars.map((c, i) => {
    if (c === ' ') return c;
    const color = fg(mix(LOOP, ((i / chars.length) * 0.5 + phase) % 1));
    return c === '█' ? color + c : DIM + color + c + '\x1b[22m';
  });
  return colored.join('') + RESET;
}

function labelTokens(m, live) {
  if (m.role === 'user') return [{ t: 'אתה', s: BOLD + fg(PINK) }];
  if (m.role === 'note') return [{ t: he(m.title || 'מידע'), s: BOLD + fg(CYAN) }];
  const tokens = [
    { t: '✦ ', s: fg(CYAN) },
    { t: shortModel(m.model || state.config.model), s: BOLD + fg(CYAN) },
  ];
  if (live) tokens.push({ t: ` ${spinner()} ${Math.floor((Date.now() - state.stream.start) / 1000)}s`, s: fg(VIOLET) });
  if (m.stopped) tokens.push({ t: ' · ' + he('נעצר'), s: DIM });
  return tokens;
}

// A message is a colored stripe + label + body; Hebrew messages mirror, with the stripe on the right.
function messageLines(m, width) {
  if (m.role === 'tool') return toolLines(m, width);
  const live = state.stream?.msg === m;
  // A reply that only called tools is shown through its tool cards.
  if (m.role === 'assistant' && !live && !m.content && !m.error && !m.stopped) return [];
  const bodyW = width - 2;
  let body;
  if (!live && m.cache?.width === width) body = m.cache.lines;
  else {
    if (live && !m.content) {
      const calling = m.toolCalls?.find(Boolean)?.name;
      const text = calling ? `מכין פעולה: ${calling}` : m.thinking ? 'חושב…' : 'מתחבר…';
      body = [toLine([{ t: he(text), s: DIM + ITALIC }])];
    }
    else if (m.role === 'user') body = renderPlain(m.content, bodyW);
    else body = renderMarkdown(m.content + (live ? '▍' : ''), bodyW);
    if (m.error) body = [...body, ...paragraph([{ t: '✗ ' + m.error, s: fg(RED) }], bodyW)];
    if (!live) m.cache = { width, lines: body };
  }

  const prose = (m.content || m.error || '').replace(/```[\s\S]*?(```|$)/g, '');
  const rtl = STRONG.test(prose) ? isRtl(prose) : !!m.rtlHint;
  const color = m.role === 'user' ? PINK : m.role === 'assistant' ? VIOLET : CYAN;
  const label = toLine(labelTokens(m, live));

  if (!rtl) {
    const bar = fg(color) + '▌' + RESET + ' ';
    return [label, ...body].map((l) => ({ s: bar + l.s, w: l.w + 2 }));
  }
  const bar = ' ' + fg(color) + '▐' + RESET;
  return [
    { s: ' '.repeat(Math.max(0, bodyW - label.w)) + label.s + bar, w: width },
    ...body.map((l) => ({ s: l.s + ' '.repeat(Math.max(0, bodyW - l.w)) + bar, w: width })),
  ];
}

const fit = (s, w) => (textWidth(s) <= w ? s : hardWrap(s, w - 1)[0] + '…');

function previewLines(lines, width, style = '', max = 8) {
  const shown = lines.slice(0, max).map((l) => codeLine(fit(l.replace(/\t/g, '  '), width - 2), width, style));
  if (lines.length > max) shown.push(codeLine(he(`… עוד ${lines.length - max} שורות`), width, DIM));
  return shown;
}

function outputTail(output, width, max = 6) {
  const lines = output.replace(/\n+$/, '').split('\n');
  if (lines.length <= max) return previewLines(lines, width, DIM, max);
  return [codeLine(he(`… ${lines.length - max} שורות קודמות`), width, DIM), ...previewLines(lines.slice(-max), width, DIM, max)];
}

// A tool card: what the model wants to do, its status, and a short preview (command, diff, output).
function toolLines(m, width) {
  const a = m.args || {};
  const bodyW = width - 2;
  const failed = m.status === 'error' || (m.status === 'done' && m.exitCode != null && m.exitCode !== 0);
  const color = m.status === 'pending' ? AMBER : failed ? RED : m.status === 'denied' ? [120, 120, 140] : CYAN;
  const verb = { run_command: '$', read_file: 'read', write_file: 'write', edit_file: 'edit', list_dir: 'ls' }[m.name] ?? m.name;
  const target = m.name === 'run_command' ? String(a.command ?? '') : displayPath(resolvePath(a.path));
  const firstLine = target.split('\n')[0] + (target.includes('\n') ? ' …' : '');
  const status =
    {
      pending: [{ t: '  ' + he('ממתין לאישור'), s: fg(AMBER) }],
      running: [{ t: `  ${spinner()} ${Math.floor((Date.now() - m.start) / 1000)}s`, s: fg(VIOLET) }],
      done: failed
        ? [{ t: `  ✗ exit ${m.exitCode}`, s: fg(RED) }]
        : [{ t: '  ✓', s: fg(GREEN) }, ...(m.summary ? [{ t: ' ' + he(m.summary), s: DIM }] : [])],
      error: [{ t: '  ✗', s: fg(RED) }],
      denied: [{ t: '  ' + he('בוטל'), s: DIM }],
    }[m.status] ?? [];
  const head = wrapTokens([{ t: verb + ' ', s: BOLD + fg(color) }, { t: firstLine, s: BOLD }, ...status], bodyW).map(toLine);

  let body = [];
  if (m.status === 'error') body = paragraph([{ t: m.error, s: fg(RED) }], bodyW);
  else if (m.name === 'run_command') {
    if (m.status === 'pending' && target.includes('\n')) body = previewLines(target.split('\n'), bodyW, '', 12);
    else if (m.output && (m.status === 'done' || m.status === 'denied')) body = outputTail(m.output, bodyW);
  } else if (m.name === 'write_file' && m.status === 'pending') {
    body = previewLines(String(a.content ?? '').split('\n'), bodyW, '', 10);
  } else if (m.name === 'edit_file' && m.status === 'pending') {
    const minus = String(a.old_text ?? '').split('\n').map((l) => '- ' + l);
    const plus = String(a.new_text ?? '').split('\n').map((l) => '+ ' + l);
    body = [...previewLines(minus, bodyW, fg(RED), 8), ...previewLines(plus, bodyW, fg(GREEN), 8)];
  }

  const bar = fg(color) + '▌' + RESET + ' ';
  return [...head, ...body].map((l) => ({ s: bar + l.s, w: l.w + 2 }));
}

function chatRows(colW, areaH, left, W) {
  const lines = [EMPTY];
  for (const m of state.messages) {
    const group = messageLines(m, colW);
    if (!group.length) continue;
    if (lines.length > 1) lines.push(EMPTY);
    lines.push(...group);
  }
  // While scrolled up, new lines arriving at the bottom must not move the view.
  if (state.scroll > 0) state.scroll += Math.max(0, lines.length - state.lastLineCount);
  state.lastLineCount = lines.length;
  state.maxScroll = Math.max(0, lines.length - areaH);
  state.scroll = Math.min(state.scroll, state.maxScroll);
  const start = state.maxScroll - state.scroll;
  const margin = ' '.repeat(left);
  const rows = lines.slice(start, start + areaH).map((l) => margin + l.s);
  while (rows.length < areaH) rows.push('');

  const barCol = left + colW + 2;
  if (state.maxScroll > 0 && barCol <= W) {
    const thumb = Math.max(1, Math.round((areaH * areaH) / lines.length));
    const thumbTop = Math.round((areaH - thumb) * (start / state.maxScroll));
    for (let i = 0; i < areaH; i++) {
      const on = i >= thumbTop && i < thumbTop + thumb;
      rows[i] += RESET + `\x1b[${barCol}G` + (on ? fg(VIOLET) + '┃' : DIM + '│') + RESET;
    }
  }
  return rows;
}

function splashRows(W, areaH) {
  const phase = (state.frame * 0.015) % 1;
  const lines = [];
  if (W >= LOGO_W + 4 && areaH >= LOGO.length + 6) lines.push(...LOGO.map((row) => ({ s: shimmer(row, phase), w: LOGO_W })));
  else lines.push({ s: gradient('◆ mac-chat', phase, BOLD), w: 10 });
  lines.push(
    EMPTY,
    toLine([{ t: he('צ׳אט בינה מלאכותית חינמי, ישר מהטרמינל'), s: DIM }]),
    toLine([{ t: he('מריץ פקודות, יוצר ועורך קבצים ומתכנת, באישור שלך'), s: DIM }]),
    EMPTY,
  );
  lines.push(
    toLine([
      { t: 'Enter', s: fg(PINK) },
      { t: ' ' + he('שליחה') + '     ', s: DIM },
      { t: '/model', s: fg(PINK) },
      { t: ' ' + he('החלפת מודל') + '     ', s: DIM },
      { t: '/help', s: fg(PINK) },
      { t: ' ' + he('עזרה'), s: DIM },
    ]),
  );
  const top = Math.max(0, Math.floor((areaH - lines.length) / 2));
  const rows = Array(areaH).fill('');
  lines.forEach((l, i) => {
    if (top + i < areaH) rows[top + i] = ' '.repeat(Math.max(0, Math.floor((W - l.w) / 2))) + l.s;
  });
  return rows;
}

function pickerRows(colW, areaH, left) {
  const p = state.picker;
  const lines = [EMPTY, toLine([{ t: '◆ ', s: fg(PINK) }, { t: he('בחר מודל חינמי'), s: BOLD }]), EMPTY];
  if (p.loading) lines.push(toLine([{ t: spinner() + ' ', s: fg(VIOLET) }, { t: he('טוען מודלים…'), s: DIM }]));
  else if (p.error) lines.push(toLine([{ t: '✗ ', s: fg(RED) }, { t: he(p.error), s: fg(RED) }]));
  else {
    const listH = Math.max(1, areaH - 6);
    const top = Math.max(0, Math.min(p.index - Math.floor(listH / 2), p.items.length - listH));
    const nameW = Math.min(40, Math.max(...p.items.map((it) => it.label.length)));
    for (let i = top; i < Math.min(p.items.length, top + listH); i++) {
      const it = p.items[i];
      const sel = i === p.index;
      const base = sel ? bg(PICK_BG) + fg(WHITE) : '';
      const name = it.label.length > nameW ? it.label.slice(0, nameW - 1) + '…' : it.label.padEnd(nameW);
      const line = toLine([
        { t: sel ? ' ❯ ' : '   ', s: base + BOLD },
        { t: it.id === state.config.model ? '● ' : '  ', s: base + fg(GREEN) },
        { t: name, s: base + (sel ? BOLD : '') },
        { t: '   ', s: base },
        { t: it.info, s: base + (sel ? '' : DIM) },
      ]);
      lines.push(sel ? { s: line.s + base + ' '.repeat(Math.max(0, colW - line.w)) + RESET, w: colW } : line);
    }
  }
  lines.push(
    EMPTY,
    toLine([
      { t: '↑↓', s: fg(PINK) },
      { t: ' ' + he('בחירה') + '    ', s: DIM },
      { t: 'Enter', s: fg(PINK) },
      { t: ' ' + he('אישור') + '    ', s: DIM },
      { t: 'Esc', s: fg(PINK) },
      { t: ' ' + he('ביטול'), s: DIM },
    ]),
  );
  const rows = lines.slice(0, areaH).map((l) => ' '.repeat(left) + l.s);
  while (rows.length < areaH) rows.push('');
  return rows;
}

function headerRow(W) {
  const title = ' ' + gradient('◆ mac-chat', null, BOLD);
  const badge = toLine([
    ...(state.autoApprove ? [{ t: ' AUTO ', s: bg(AMBER) + fg([20, 20, 20]) + BOLD }, { t: '  ', s: '' }] : []),
    { t: '● ', s: fg(GREEN) },
    { t: shortModel(state.config.model), s: BOLD + fg(CYAN) },
    { t: ' · free ', s: DIM },
  ]);
  const room = W - 11 - badge.w - 6;
  let cwd = tildify(state.cwd);
  if (textWidth(cwd) > room) cwd = room > 4 ? '…' + cwd.slice(-(room - 1)) : '';
  const gap = W - 11 - 2 - textWidth(cwd) - badge.w;
  return title + '  ' + DIM + cwd + RESET + (gap > 1 ? ' '.repeat(gap) + badge.s : '');
}

const ruleRow = (W) => gradient('─'.repeat(W), state.busy ? (state.frame * 0.03) % 1 : null);

function statusRow(colW, left) {
  let tokens = [];
  const typingCommand = /^\/\S*$/.test(state.input);
  const matches = typingCommand ? COMMANDS.filter(([c]) => c.startsWith(state.input)) : [];
  if (state.approval) {
    tokens = [
      { t: '● ', s: fg(AMBER) },
      { t: he('לאשר את הפעולה?') + '    ', s: BOLD + fg(AMBER) },
      { t: 'y', s: BOLD + fg(PINK) },
      { t: ' ' + he('כן') + '   ', s: DIM },
      { t: 'n', s: BOLD + fg(PINK) },
      { t: ' ' + he('לא') + '   ', s: DIM },
      { t: 'a', s: BOLD + fg(PINK) },
      { t: ' ' + he('כן לכל השיחה') + '   ', s: DIM },
      { t: 'Esc', s: BOLD + fg(PINK) },
      { t: ' ' + he('עצירה'), s: DIM },
    ];
  } else if (matches.length) {
    matches.forEach(([c, d], i) => tokens.push({ t: c, s: fg(PINK) + (i ? '' : BOLD) }, { t: ' ' + he(d) + '   ', s: DIM }));
    tokens.push({ t: 'Tab', s: fg(CYAN) });
  } else if (state.toast) tokens = [{ t: he(state.toast.text), s: fg(state.toast.color) }];
  else if (state.busy) tokens = [{ t: 'Esc', s: fg(PINK) }, { t: ' ' + he('לעצירה'), s: DIM }];
  const l = toLine(tokens);
  const r = state.scroll > 0 ? toLine([{ t: he(`↓ עוד ${state.scroll} שורות`), s: fg(CYAN) }]) : EMPTY;
  const gap = colW - 2 - l.w - r.w;
  return ' '.repeat(left + 1) + l.s + (r.w && gap > 1 ? ' '.repeat(gap) + r.s : '');
}

function layoutInput(width) {
  const rows = [''];
  const widths = [0];
  let cursor = null;
  for (const { segment: g, index } of segmenter.segment(state.input)) {
    if (index === state.cursor) cursor = [rows.length - 1, widths[rows.length - 1]];
    if (g === '\n' || g === '\r\n') {
      rows.push('');
      widths.push(0);
      continue;
    }
    const w = graphemeWidth(g);
    if (widths[rows.length - 1] + w > width) {
      rows.push('');
      widths.push(0);
      if (index === state.cursor) cursor = [rows.length - 1, 0];
    }
    rows[rows.length - 1] += g;
    widths[rows.length - 1] += w;
  }
  if (!cursor) {
    const last = rows.length - 1;
    cursor = widths[last] >= width ? [rows.push('') - 1, 0] : [last, widths[last]];
    if (widths.length < rows.length) widths.push(0);
  }
  return { rows, widths, cursor };
}

function paint(rows, cursor) {
  let s = '\x1b[?2026h\x1b[?25l';
  rows.forEach((r, i) => {
    s += `\x1b[${i + 1};1H\x1b[2K${r}${RESET}`;
  });
  if (cursor) s += `\x1b[${cursor[0]};${cursor[1]}H\x1b[?25h`;
  out.write(s + '\x1b[?2026l');
}

function render() {
  state.renderQueued = false;
  const W = out.columns || 80;
  const H = out.rows || 24;
  if (W < 40 || H < 12) {
    const rows = Array(H).fill('');
    const msg = he('הגדל את החלון');
    rows[Math.floor(H / 2)] = ' '.repeat(Math.max(0, Math.floor((W - 13) / 2))) + fg(PINK) + msg;
    return paint(rows, null);
  }

  const colW = Math.min(W - 4, 104);
  const left = Math.floor((W - colW) / 2);
  const innerW = colW - 6;
  const input = layoutInput(innerW);
  const maxInputRows = Math.max(1, Math.min(8, Math.floor(H / 4)));
  const inputTop = Math.max(0, input.cursor[0] - maxInputRows + 1);
  const inputRows = input.rows.slice(inputTop, inputTop + maxInputRows);
  const boxH = inputRows.length + 2;
  const areaH = H - 3 - boxH;

  const rows = [headerRow(W), ruleRow(W)];
  if (state.picker) rows.push(...pickerRows(colW, areaH, left));
  else if (state.messages.length) rows.push(...chatRows(colW, areaH, left, W));
  else rows.push(...splashRows(W, areaH));
  rows.push(statusRow(colW, left));

  // input box
  const margin = ' '.repeat(left);
  const border = state.approval ? fg(AMBER) : state.busy ? DIM + fg(VIOLET) : fg(VIOLET);
  const rtlInput = isRtl(state.input);
  rows.push(margin + border + '╭' + '─'.repeat(colW - 2) + '╮' + RESET);
  inputRows.forEach((text, i) => {
    const prompt = i === 0 && inputTop === 0 ? fg(PINK) + BOLD + '❯' + RESET : ' ';
    const w = input.widths[inputTop + i];
    let content;
    if (!state.input) {
      const text = state.approval ? 'ממתין לאישור שלך…' : state.busy ? 'עובד על זה…' : 'שאל אותי משהו…';
      const hint = toLine([{ t: he(text), s: DIM + ITALIC }]);
      content = hint.s + ' '.repeat(innerW - hint.w);
    } else if (rtlInput) content = ' '.repeat(innerW - w) + `⁧${text}⁩`;
    else content = text + ' '.repeat(innerW - w);
    rows.push(margin + border + '│' + RESET + ' ' + prompt + ' ' + content + ' ' + border + '│' + RESET);
  });
  const hints = toLine(
    state.approval
      ? [
          { t: 'y', s: fg(PINK) },
          { t: ' ' + he('כן') + ' · ', s: DIM },
          { t: 'n', s: fg(PINK) },
          { t: ' ' + he('לא') + ' · ', s: DIM },
          { t: 'a', s: fg(PINK) },
          { t: ' ' + he('תמיד'), s: DIM },
        ]
      : state.busy
      ? [{ t: 'Esc', s: fg(PINK) }, { t: ' ' + he('עצירה'), s: DIM }]
      : [
          { t: 'Enter', s: fg(PINK) },
          { t: ' ' + he('שליחה') + ' · ', s: DIM },
          { t: '↑↓', s: fg(PINK) },
          { t: ' ' + he('גלילה') + ' · ', s: DIM },
          { t: '/help', s: fg(PINK) },
        ],
  );
  const fill = colW - 5 - hints.w;
  rows.push(
    fill > 1
      ? margin + border + '╰─ ' + RESET + hints.s + ' ' + border + '─'.repeat(fill) + '╯' + RESET
      : margin + border + '╰' + '─'.repeat(colW - 2) + '╯' + RESET,
  );

  let cursor = null;
  if (!state.busy && !state.picker) {
    const [row, col] = input.cursor;
    const x = rtlInput && state.input ? Math.max(0, innerW - 1 - col) : Math.min(col, innerW);
    cursor = [H - boxH + 2 + (row - inputTop), left + 5 + x];
  }
  paint(rows.slice(0, H), cursor);
}

function queueRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  setTimeout(render, 16);
}

// ── chat ──────────────────────────────────────────────────────

function describeError(status, body) {
  let detail = '';
  try {
    detail = JSON.parse(body).error?.message ?? '';
  } catch {}
  if (status === 401) return 'המפתח לא תקין. הקלד /key כדי להחליף אותו';
  if (status === 402) return 'אין מספיק קרדיט בחשבון OpenRouter';
  if (status === 429) return 'המודל החינמי עמוס או שנגמרה המכסה היומית. נסה שוב בעוד רגע, או החלף מודל ב-/model';
  if (status === 404 && /data policy|privacy/i.test(detail))
    return 'צריך לאפשר מודלים חינמיים בהגדרות הפרטיות: openrouter.ai/settings/privacy';
  return `שגיאה ${status}${detail ? `: ${detail}` : ''}`;
}

const systemPrompt = () =>
  [
    "You are mac-chat, an AI assistant in a terminal on the user's Mac (macOS, zsh).",
    'You have tools to run shell commands and to read, create and edit files and folders. The user approves risky actions in the UI.',
    `Working directory: ${state.cwd}. Home: ${homedir()}. Today: ${new Date().toISOString().slice(0, 10)}.`,
    "Reply in the user's language, clearly and concisely. Light markdown is rendered (bold, `code`, lists, headings, fenced code). Avoid tables.",
    'Use tools only when the request needs the computer or files; otherwise just answer.',
    'Read a file before editing it. Use edit_file for small changes and write_file for new files or full rewrites.',
    'Relative paths resolve against the working directory, and `cd` in run_command persists.',
    'Commands get no stdin: avoid interactive programs and pagers, and start servers in the background (nohup … &).',
    'Do not delete or overwrite anything the user did not ask about. After acting, briefly say what you did.',
  ].join('\n');

// History in OpenAI format. Every tool call is paired with its tool message.
function apiMessages() {
  const msgs = [];
  for (const m of state.messages) {
    if (m.role === 'user') msgs.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') msgs.push({ role: 'tool', tool_call_id: m.callId, content: m.result });
    else if (m.role === 'assistant' && (m.content || m.toolCalls.length)) {
      const msg = { role: 'assistant', content: m.content };
      if (m.toolCalls.length)
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments || '{}' },
        }));
      msgs.push(msg);
    }
  }
  return msgs;
}

// One model call, streamed into a new assistant message.
async function complete(rtlHint) {
  const messages = [{ role: 'system', content: systemPrompt() }, ...apiMessages()];
  const msg = { role: 'assistant', content: '', model: '', rtlHint, toolCalls: [] };
  const ctrl = new AbortController();
  state.messages.push(msg);
  state.stream = { msg, ctrl, start: Date.now() };
  render();

  try {
    const res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'mac-chat' },
      body: JSON.stringify({
        models: [state.config.model, ...FALLBACK_MODELS.filter((id) => id !== state.config.model)].slice(0, 3),
        stream: true,
        messages,
        tools: TOOLS,
      }),
    });
    if (!res.ok) throw new Error(describeError(res.status, await res.text()));

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.error) throw new Error(describeError(event.error.code, JSON.stringify(event)));
        if (event.model) msg.model = event.model;
        const delta = event.choices?.[0]?.delta ?? {};
        if (delta.reasoning) msg.thinking = true;
        if (delta.content) msg.content += delta.content;
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? (tc.id || !msg.toolCalls.length ? msg.toolCalls.length : msg.toolCalls.length - 1);
          const slot = (msg.toolCalls[i] ??= { id: '', name: '', arguments: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name ||= tc.function.name;
          const args = tc.function?.arguments;
          if (args) slot.arguments += typeof args === 'string' ? args : JSON.stringify(args);
        }
        queueRender();
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') msg.stopped = true;
    else msg.error = err.message === 'fetch failed' ? 'אין חיבור לאינטרנט' : err.message;
  }
  state.stream = null;
  msg.toolCalls = msg.stopped || msg.error ? [] : msg.toolCalls.filter((tc) => tc?.name);
  for (const tc of msg.toolCalls) tc.id ||= `call_${Math.random().toString(36).slice(2, 10)}`;
  if (!msg.content && !msg.toolCalls.length && !msg.error && !msg.stopped)
    msg.error = 'התקבלה תשובה ריקה. נסה שוב, או בחר מודל אחר ב-/model';
  if (msg.stopped) state.cancel = true;
  render();
  return msg;
}

// Answers one user message: call the model, run the tools it asks for, repeat until it just replies.
async function runTurn(rtlHint) {
  state.busy = true;
  state.cancel = false;
  state.scroll = 0;
  try {
    for (let step = 0; step < MAX_STEPS && !state.cancel; step++) {
      const msg = await complete(rtlHint);
      if (state.cancel || !msg.toolCalls.length) break;
      const tools = msg.toolCalls.map((tc) => {
        const tool = { role: 'tool', callId: tc.id, name: tc.name, args: {}, status: 'queued', result: 'Cancelled by the user.' };
        try {
          tool.args = JSON.parse(tc.arguments || '{}');
        } catch {
          tool.badArgs = true;
        }
        state.messages.push(tool);
        return tool;
      });
      render();
      for (const tool of tools) {
        if (state.cancel) break;
        await handleTool(tool);
      }
    }
  } finally {
    state.busy = false;
    state.cancel = false;
    render();
  }
}

async function handleTool(tool) {
  if (tool.badArgs) {
    tool.status = 'error';
    tool.error = 'המודל שלח פרמטרים לא תקינים';
    tool.result = 'Error: the arguments were not valid JSON.';
    return;
  }
  if (NEEDS_APPROVAL.has(tool.name) && !state.autoApprove) {
    tool.status = 'pending';
    const answer = await new Promise((resolve) => {
      state.approval = { tool, resolve };
      render();
    });
    state.approval = null;
    if (answer === 'cancel') {
      state.cancel = true;
      tool.status = 'denied';
      return;
    }
    if (answer === 'no') {
      tool.status = 'denied';
      tool.result = 'The user declined this action. Ask them what to do instead.';
      return render();
    }
    if (answer === 'always') state.autoApprove = true;
  }
  tool.status = 'running';
  tool.start = Date.now();
  render();
  try {
    tool.result = await executeTool(tool);
    tool.status = state.cancel ? 'denied' : 'done';
  } catch (err) {
    tool.status = 'error';
    tool.error = err.code === 'ENOENT' ? `לא נמצא: ${tildify(resolvePath(tool.args.path))}` : err.message;
    tool.result = `Error: ${err.message}`;
  }
  render();
}

// ── computer access ───────────────────────────────────────────

const fn = (name, description, properties, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const PATH = { type: 'string', description: 'File or folder path, absolute or relative to the working directory.' };

const TOOLS = [
  fn(
    'run_command',
    'Run a zsh command on the Mac and get its output and exit code. No stdin; `cd` persists between calls.',
    {
      command: { type: 'string', description: 'The shell command.' },
      timeout_seconds: { type: 'number', description: 'Time limit in seconds (default 120, max 600).' },
    },
    ['command'],
  ),
  fn(
    'read_file',
    'Read a text file. Returns up to 2000 lines from `offset` (1-based).',
    { path: PATH, offset: { type: 'number' }, limit: { type: 'number' } },
    ['path'],
  ),
  fn(
    'write_file',
    'Create or overwrite a file with the given content. Missing parent folders are created.',
    { path: PATH, content: { type: 'string' } },
    ['path', 'content'],
  ),
  fn(
    'edit_file',
    'Replace one exact, unique occurrence of old_text with new_text in a file. Read the file first.',
    { path: PATH, old_text: { type: 'string' }, new_text: { type: 'string' } },
    ['path', 'old_text', 'new_text'],
  ),
  fn('list_dir', 'List the files and folders in a directory (default: the working directory).', { path: PATH }, []),
];
const NEEDS_APPROVAL = new Set(['run_command', 'write_file', 'edit_file']);

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p);
const resolvePath = (p) => path.resolve(state.cwd, expandHome(String(p ?? '.')));
const tildify = (p) => (p === homedir() || p.startsWith(homedir() + '/') ? '~' + p.slice(homedir().length) : p);
const displayPath = (p) => (p.startsWith(state.cwd + '/') ? p.slice(state.cwd.length + 1) : tildify(p));
const lineCount = (n) => (n === 1 ? 'שורה אחת' : `${n} שורות`);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

function clip(text, max = 12000) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… [${text.length - max} characters cut] …\n${text.slice(-half)}`;
}

// Runs a command in zsh from the current folder; a trailer reports the final $PWD so `cd` sticks.
function runShell(command, timeoutSec) {
  return new Promise((resolve) => {
    const marker = '\x1fMACCHAT_CWD:';
    const script = `${command}\n__mc_status=$?\nprintf '\\n${marker}%s' "$PWD"\nexit $__mc_status`;
    const child = spawn('/bin/zsh', ['-c', script], {
      cwd: state.cwd,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let output = '';
    let timedOut = false;
    const collect = (d) => {
      if (output.length < 2_000_000) output += d;
    };
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutSec * 1000);
    state.running = { kill };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => (output += err.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      state.running = null;
      const i = output.lastIndexOf(marker);
      if (i >= 0) {
        const dir = output.slice(i + marker.length).trim();
        if (dir) state.cwd = dir;
        output = output.slice(0, i).replace(/\n$/, '');
      }
      resolve({ code, output: stripAnsi(output), timedOut });
    });
  });
}

async function executeTool(m) {
  const a = m.args;
  switch (m.name) {
    case 'run_command': {
      const timeout = Math.min(600, Math.max(1, Number(a.timeout_seconds) || 120));
      const r = await runShell(String(a.command ?? ''), timeout);
      m.output = r.output;
      m.exitCode = r.code;
      if (state.cancel) return 'The user stopped this command.';
      const status = r.timedOut ? `Timed out after ${timeout}s.` : `Exit code: ${r.code}`;
      return `${status}\nWorking directory: ${state.cwd}\n${clip(r.output) || '(no output)'}`;
    }
    case 'read_file': {
      const file = resolvePath(a.path);
      if (statSync(file).size > 5_000_000) throw new Error('The file is larger than 5 MB.');
      const text = readFileSync(file, 'utf8');
      if (text.includes('\0')) throw new Error('This looks like a binary file.');
      const lines = text.split('\n');
      const start = Math.max(1, Number(a.offset) || 1);
      const slice = lines.slice(start - 1, start - 1 + Math.min(2000, Math.max(1, Number(a.limit) || 2000)));
      m.summary = lineCount(lines.length);
      return `${tildify(file)}: lines ${start}-${start + slice.length - 1} of ${lines.length}\n${clip(slice.join('\n'), 60000)}`;
    }
    case 'write_file': {
      const file = resolvePath(a.path);
      const content = String(a.content ?? '');
      const existed = existsSync(file);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      m.summary = `${existed ? 'עודכן' : 'נוצר'} · ${lineCount(content.split('\n').length)}`;
      return `${existed ? 'Overwrote' : 'Created'} ${tildify(file)} (${content.split('\n').length} lines).`;
    }
    case 'edit_file': {
      const file = resolvePath(a.path);
      const text = readFileSync(file, 'utf8');
      const oldText = String(a.old_text ?? '');
      const count = oldText ? text.split(oldText).length - 1 : 0;
      if (!count) throw new Error('old_text was not found in the file. Read the file and copy the text exactly.');
      if (count > 1) throw new Error(`old_text appears ${count} times. Include more surrounding text so it is unique.`);
      writeFileSync(file, text.replace(oldText, () => String(a.new_text ?? '')));
      return `Edited ${tildify(file)}.`;
    }
    case 'list_dir': {
      const dir = resolvePath(a.path);
      const entries = readdirSync(dir, { withFileTypes: true }).sort(
        (x, y) => y.isDirectory() - x.isDirectory() || x.name.localeCompare(y.name),
      );
      m.summary = `${entries.length} פריטים`;
      const names = entries.slice(0, 500).map((e) => e.name + (e.isDirectory() ? '/' : ''));
      return `${tildify(dir)} (${entries.length} entries)\n${names.join('\n')}${entries.length > 500 ? '\n…' : ''}`;
    }
    default:
      throw new Error(`Unknown tool: ${m.name}`);
  }
}

function send(text) {
  state.messages.push({ role: 'user', content: text });
  runTurn(isRtl(text));
}

function stop() {
  state.cancel = true;
  state.stream?.ctrl.abort();
  state.running?.kill();
  state.approval?.resolve('cancel');
}

function newChat() {
  stop();
  state.messages = [];
  state.scroll = 0;
  toast('✓ שיחה חדשה');
}

function copyLast() {
  const last = [...state.messages].reverse().find((m) => m.role === 'assistant' && m.content);
  if (!last) return toast('אין עדיין תשובה להעתיק', AMBER);
  execFileSync('pbcopy', { input: last.content });
  toast('✓ התשובה הועתקה');
}

function changeKey() {
  toast('פותח חלון להזנת מפתח…', CYAN);
  render();
  setTimeout(() => {
    const key = askForKey(true);
    if (key && key !== apiKey) {
      apiKey = key;
      toast('✓ המפתח עודכן');
    } else toast('המפתח לא שונה', AMBER);
    render();
  }, 60);
}

function showHelp() {
  state.messages.push({
    role: 'note',
    title: 'עזרה',
    content: [
      '**פקודות**',
      '- שיחה חדשה — `/new`',
      '- בחירת מודל חינמי — `/model`',
      '- העתקת התשובה האחרונה — `/copy`',
      '- אישור אוטומטי לפעולות, הפעלה וכיבוי — `/auto`',
      '- החלפת מפתח ה-API — `/key`',
      '- יציאה — `/exit`',
      '',
      '**גישה למחשב**',
      '- אפשר לבקש להריץ פקודות, ליצור, לערוך ולמחוק קבצים ותיקיות, ולכתוב קוד.',
      '- העבודה מתחילה בתיקייה שממנה הפעלת את `ai`. התיקייה הנוכחית מוצגת למעלה.',
      '- קריאת קבצים לא דורשת אישור. כל פקודה וכל שינוי בקובץ מחכים לאישור שלך.',
      '- באישור: y כן, n לא, a כן לכל השיחה, Esc עצירה.',
      '',
      '**מקשים**',
      '- שליחה — Enter',
      '- שורה חדשה — Ctrl+J',
      '- גלילה — הגלגלת או ↑ ↓, עמוד שלם — PgUp PgDn',
      '- בחירת טקסט עם העכבר — להחזיק Fn בזמן הגרירה',
      '- עצירת תשובה — Esc',
      '- שיחה חדשה — Ctrl+L',
      '- יציאה — Ctrl+C',
    ].join('\n'),
  });
  state.scroll = 0;
}

function runCommand(text) {
  const cmd = text.toLowerCase();
  const match = cmd.length > 1 && (COMMANDS.find(([c]) => c === cmd) || COMMANDS.find(([c]) => c.startsWith(cmd)));
  switch (match?.[0]) {
    case '/new':
      return newChat();
    case '/model':
      return openPicker();
    case '/copy':
      return copyLast();
    case '/auto':
      state.autoApprove = !state.autoApprove;
      return toast(
        state.autoApprove ? 'אישור אוטומטי פעיל: פעולות ירוצו בלי לשאול' : '✓ אישור אוטומטי כבוי',
        state.autoApprove ? AMBER : GREEN,
      );
    case '/key':
      return changeKey();
    case '/help':
      return showHelp();
    case '/exit':
      return quit();
    default:
      toast(`פקודה לא מוכרת: ${text}`, RED);
  }
}

function submit() {
  const text = state.input.trim();
  if (!text) return;
  if (/^\/[a-z]*$/i.test(text)) {
    state.input = '';
    state.cursor = 0;
    return runCommand(text);
  }
  if (state.busy) return toast('רגע, עוד עובד… Esc לעצירה', AMBER);
  state.input = '';
  state.cursor = 0;
  send(text);
}

// ── model picker ──────────────────────────────────────────────

async function loadModels() {
  const res = await fetch(`${API}/models`);
  if (!res.ok) throw new Error(String(res.status));
  const { data } = await res.json();
  const free = data.filter(
    (m) =>
      (m.id === AUTO_MODEL || m.id.endsWith(':free')) &&
      !/safety|guard/i.test(m.id) &&
      (m.architecture?.output_modalities ?? ['text']).includes('text'),
  );
  if (!free.some((m) => m.id === AUTO_MODEL)) free.push({ id: AUTO_MODEL });
  free.sort((a, b) => (a.id === AUTO_MODEL ? -1 : b.id === AUTO_MODEL ? 1 : a.id.localeCompare(b.id)));
  return free.map((m) => {
    const tools = m.id === AUTO_MODEL || (m.supported_parameters ?? []).includes('tools');
    const ctx = `${Math.round((m.context_length || 0) / 1000)}K context`;
    return {
      id: m.id,
      label: m.id === AUTO_MODEL ? 'auto  (openrouter/free)' : m.id.replace(/:free$/, ''),
      info: m.id === AUTO_MODEL ? he('בוחר לבד מודל חינמי פנוי') : tools ? ctx : `${ctx} · ${he('בלי גישה למחשב')}`,
    };
  });
}

function openPicker() {
  const focusCurrent = () => {
    const i = state.picker.items.findIndex((it) => it.id === state.config.model);
    state.picker.index = Math.max(0, i);
  };
  state.picker = { items: state.models || [], index: 0, loading: !state.models, error: null };
  focusCurrent();
  if (!state.models) {
    loadModels()
      .then((items) => {
        state.models = items;
        if (!state.picker) return;
        state.picker.items = items;
        state.picker.loading = false;
        focusCurrent();
      })
      .catch(() => {
        if (state.picker) Object.assign(state.picker, { loading: false, error: 'לא הצלחתי לטעון את רשימת המודלים' });
      })
      .finally(render);
  }
}

function pickerKey(k) {
  const p = state.picker;
  const n = p.items.length;
  if (k.name === 'escape') state.picker = null;
  else if (!n) return;
  else if (k.name === 'up') p.index = (p.index - 1 + n) % n;
  else if (k.name === 'down') p.index = (p.index + 1) % n;
  else if (k.name === 'pageup') p.index = Math.max(0, p.index - 10);
  else if (k.name === 'pagedown') p.index = Math.min(n - 1, p.index + 10);
  else if (k.name === 'return') {
    state.config.model = p.items[p.index].id;
    saveConfig();
    state.picker = null;
    toast(`✓ המודל הוחלף: ${shortModel(state.config.model)}`);
  }
  render();
}

// ── input editing ─────────────────────────────────────────────

const boundaries = () => [...Array.from(segmenter.segment(state.input), (x) => x.index), state.input.length];
const prevBoundary = () => boundaries().filter((i) => i < state.cursor).pop() ?? 0;
const nextBoundary = () => boundaries().find((i) => i > state.cursor) ?? state.input.length;

function insert(text) {
  state.input = state.input.slice(0, state.cursor) + text + state.input.slice(state.cursor);
  state.cursor += text.length;
}

function removeRange(from, to) {
  state.input = state.input.slice(0, from) + state.input.slice(to);
  state.cursor = from;
}

function wordLeft() {
  const m = state.input.slice(0, state.cursor).match(/(\S+\s*|\s+)$/);
  return state.cursor - (m ? m[0].length : 0);
}

function wordRight() {
  const m = state.input.slice(state.cursor).match(/^\s*\S+/);
  return state.cursor + (m ? m[0].length : state.input.length - state.cursor);
}

function scrollBy(n) {
  state.scroll = Math.min(state.maxScroll, Math.max(0, state.scroll + n));
}

function onKey(ch, k) {
  if (k.name === 'paste-start') return void (state.pasting = true);
  if (k.name === 'paste-end') {
    state.pasting = false;
    return render();
  }
  if (state.pasting) {
    if (ch === '\n' && state.lastCR) return void (state.lastCR = false);
    state.lastCR = ch === '\r';
    if (ch === '\r' || ch === '\n') insert('\n');
    else if (ch === '\t') insert('  ');
    else if (ch && ch >= ' ') insert(ch);
    return queueRender();
  }

  if (k.ctrl && k.name === 'c') return state.busy ? stop() : quit();
  if (state.approval) {
    // y/n/a also work on a Hebrew keyboard layout (ט/מ/ש).
    const c = (ch || '').toLowerCase();
    const answer =
      k.name === 'return' || c === 'y' || c === 'ט'
        ? 'yes'
        : c === 'n' || c === 'מ'
        ? 'no'
        : c === 'a' || c === 'ש'
        ? 'always'
        : k.name === 'escape'
        ? 'cancel'
        : null;
    if (answer) state.approval.resolve(answer);
    return;
  }
  if (k.ctrl && k.name === 'd' && !state.input) return quit();
  if (state.picker) return pickerKey(k);

  if (k.ctrl) {
    if (k.name === 'a') state.cursor = 0;
    else if (k.name === 'e') state.cursor = state.input.length;
    else if (k.name === 'u') removeRange(0, state.cursor);
    else if (k.name === 'k') state.input = state.input.slice(0, state.cursor);
    else if (k.name === 'w') removeRange(wordLeft(), state.cursor);
    else if (k.name === 'l') newChat();
    else if (k.name === 'left') state.cursor = wordLeft();
    else if (k.name === 'right') state.cursor = wordRight();
    return render();
  }

  switch (k.name) {
    case 'return':
      if (k.meta) insert('\n');
      else submit();
      break;
    case 'enter':
      insert('\n');
      break;
    case 'escape':
      if (state.busy) stop();
      else removeRange(0, state.input.length);
      break;
    case 'backspace':
      removeRange(k.meta ? wordLeft() : prevBoundary(), state.cursor);
      break;
    case 'delete':
      removeRange(state.cursor, nextBoundary());
      break;
    case 'left':
      state.cursor = k.meta ? wordLeft() : prevBoundary();
      break;
    case 'right':
      state.cursor = k.meta ? wordRight() : nextBoundary();
      break;
    case 'home':
      state.cursor = 0;
      break;
    case 'end':
      state.cursor = state.input.length;
      break;
    case 'up':
      scrollBy(2);
      break;
    case 'down':
      scrollBy(-2);
      break;
    case 'pageup':
      scrollBy(Math.max(1, (out.rows || 24) - 10));
      break;
    case 'pagedown':
      scrollBy(-Math.max(1, (out.rows || 24) - 10));
      break;
    case 'tab': {
      const match = COMMANDS.find(([c]) => /^\/\S*$/.test(state.input) && c.startsWith(state.input));
      if (match) {
        state.input = match[0];
        state.cursor = state.input.length;
      }
      break;
    }
    default:
      if (k.meta && k.name === 'b') state.cursor = wordLeft();
      else if (k.meta && k.name === 'f') state.cursor = wordRight();
      else if (ch && !k.meta && ch >= ' ' && ch !== '\x7f') insert(ch);
      else return;
  }
  render();
}

// ── lifecycle ─────────────────────────────────────────────────

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  try {
    stdin.setRawMode(false);
  } catch {}
  out.write('\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[0 q\x1b[?7h\x1b[?25h\x1b[?1049l');
}

function quit() {
  stop();
  restore();
  process.exit(0);
}

function crash(err) {
  restore();
  console.error(err);
  process.exit(1);
}

// SGR mouse report (enabled with ?1000h + ?1006h): ESC [ < button ; x ; y M/m
const MOUSE_EVENT = /\x1b\[<(\d+);\d+;\d+[Mm]/g;

// With mouse reporting on, the wheel scrolls the chat instead of the terminal's own scrollback.
function onMouse(button) {
  if (!(button & 64)) return; // clicks are ignored; only the wheel is used
  const up = !(button & 1);
  if (state.picker) return pickerKey({ name: up ? 'up' : 'down' });
  scrollBy(up ? 2 : -2);
  render();
}

function start(initialPrompt) {
  // Mouse reports are taken out of the input before readline turns the rest into keypresses.
  const keys = new PassThrough();
  readline.emitKeypressEvents(keys, { escapeCodeTimeout: 50 });
  keys.on('keypress', (ch, k) => {
    try {
      onKey(ch, k || {});
    } catch (err) {
      crash(err);
    }
  });
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.on('data', (data) => {
    try {
      const rest = data.replace(MOUSE_EVENT, (_, button) => (onMouse(Number(button)), ''));
      if (rest) keys.write(rest);
    } catch (err) {
      crash(err);
    }
  });
  out.write('\x1b[?1049h\x1b[?7l\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[5 q');
  out.on('resize', render);
  process.on('exit', restore);
  process.on('SIGTERM', quit);
  process.on('SIGHUP', quit);
  process.on('uncaughtException', crash);

  setInterval(() => {
    state.frame++;
    const expired = state.toast && Date.now() > state.toast.until;
    if (expired) state.toast = null;
    if (expired || state.busy || state.picker?.loading || (!state.messages.length && !state.picker)) queueRender();
  }, 80);

  render();
  if (initialPrompt) send(initialPrompt);
}

const args = process.argv.slice(2);
if (!stdin.isTTY || !out.isTTY) {
  console.error('mac-chat needs an interactive terminal.');
  process.exit(1);
}
state.config = { model: DEFAULT_MODEL, ...loadConfig() };

if (args[0] === '--key') {
  const ok = !!askForKey();
  process.exit(ok ? 0 : 1);
}

apiKey = readKey();
if (!apiKey) {
  console.log('🔑 לא נמצא מפתח OpenRouter. פותח חלון להזנת המפתח…');
  apiKey = askForKey();
  if (!apiKey) {
    console.log('לא נשמר מפתח. אפשר לנסות שוב עם: ai --key');
    process.exit(1);
  }
}
start(args.join(' ').trim());
