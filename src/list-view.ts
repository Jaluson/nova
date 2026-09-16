import { t } from './i18n.js';
import { emitKeypressEvents, type Key } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { cancellation } from './network.js';

export interface ListRow {
  version: string;
  status?: string;
  detail?: string;
  plain: string;
  priority?: number;
}
export interface ListOptions { all?: boolean; page?: number; pageSize?: number; verbose?: boolean; json?: boolean; jsonData?: unknown; noColor?: boolean }
export interface ListLayout { title: string; statuses?: boolean }

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function clean(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}
function cellWidth(value: string): number {
  if (/^\p{Mark}+$/u.test(value)) return 0;
  if (/\p{Extended_Pictographic}/u.test(value)) return 2;
  const point = value.codePointAt(0) ?? 0;
  return (point >= 0x1100 && (point <= 0x115f || point === 0x2329 || point === 0x232a
    || (point >= 0x2e80 && point <= 0xa4cf) || (point >= 0xac00 && point <= 0xd7a3)
    || (point >= 0xf900 && point <= 0xfaff) || (point >= 0xfe10 && point <= 0xfe6f)
    || (point >= 0xff01 && point <= 0xff60) || (point >= 0xffe0 && point <= 0xffe6)
    || (point >= 0x20000 && point <= 0x3fffd))) ? 2 : 1;
}
export function displayWidth(value: string): number {
  return [...segments.segment(clean(value))].reduce((sum, part) => sum + cellWidth(part.segment), 0);
}
export function fit(value: string, width: number): string {
  const text = clean(value);
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  let result = '', used = 0;
  for (const part of segments.segment(text)) {
    const size = cellWidth(part.segment);
    if (used + size > width - 1) break;
    result += part.segment; used += size;
  }
  return result + '…';
}
function pad(value: string, width: number): string {
  const clipped = fit(value, width);
  return clipped + ' '.repeat(Math.max(0, width - displayWidth(clipped)));
}
export function pageSize(options: ListOptions, terminalRows?: number): number {
  const requested = options.pageSize ?? 20;
  return terminalRows ? Math.min(requested, Math.max(1, terminalRows - 8)) : requested;
}
export function renderPage(rows: ListRow[], layout: ListLayout, options: ListOptions, page: number, size: number, width: number, interactive: boolean, selected = -1): string {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  if (page < 1 || page > pages) throw new Error(t("Page {0} is out of range (1-{1}).", page, pages));
  const start = (page - 1) * size;
  const visible = rows.slice(start, start + size);
  const versionWidth = Math.max(displayWidth(t('VERSION')), ...rows.map(row => displayWidth(row.version)));
  const statusWidth = Math.max(displayWidth(t('STATUS')), ...rows.map(row => displayWidth(row.status ?? '')));
  const format = (version: string, status: string, detail: string) => {
    const columns = [pad(version, versionWidth)];
    if (layout.statuses) columns.push(pad(status, statusWidth));
    if (options.verbose) columns.push(detail);
    return fit(columns.join('  ').trimEnd(), width);
  };
  const color = interactive && !options.noColor && process.env.NO_COLOR === undefined;
  const paint = (code: string, value: string) => color ? `\x1b[${code}m${value}\x1b[0m` : value;
  const lines = [paint('1;36', fit(`${layout.title} (${rows.length})`, width)), '', paint('1', format(t('VERSION'), t('STATUS'), t('PATH'))),
    ...visible.map((row, index) => {
      const line = format(row.version, row.status ?? '', row.detail ?? '');
      const styled = row.status?.includes(t('latest')) || row.status?.includes('latest') ? paint('32', line) : line;
      return fit(index === selected ? paint('7', `› ${styled}`) : `  ${styled}`, width);
    }),
    '', fit(t('{0}-{1} / {2}  |  Page {3}/{4}', start + 1, start + visible.length, rows.length, page, pages), width)];
  if (interactive) lines.push(fit(`${t('q: quit first  |  ↑/↓: select  |  Enter: choose  |  n/p: page  |  /: search')}`, width));
  else if (pages > 1) lines.push(fit(t('Use --page <n> to navigate, or --all for the full list.'), width));
  if (options.verbose && !interactive) lines.push(fit(t('Full paths: --all'), width));
  return lines.join('\n') + '\n';
}

export async function displayList(rows: ListRow[], layout: ListLayout, options: ListOptions): Promise<void> {
  if (options.json) {
    console.log(JSON.stringify(options.jsonData ?? rows.map(row => ({ version: row.version, ...(row.status ? { status: row.status } : {}), ...(row.detail ? { path: row.detail } : {}) }))));
    return;
  }
  const terminal = Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
  const explicitPage = options.page !== undefined || options.pageSize !== undefined;
  if (options.all || (!terminal && !explicitPage)) {
    for (const row of rows) console.log(row.plain);
    return;
  }
  const ordered = [...rows].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const width = () => terminal ? Math.max(1, (process.stdout.columns || 80) - 1) : 100;
  const size = () => pageSize(options, terminal ? process.stdout.rows || 24 : undefined);
  let page = options.page ?? 1;
  let selected = 0;
  const canBrowse = terminal && Boolean(process.stdin.isTTY) && options.page === undefined && ordered.length > size();
  if (!canBrowse) {
    process.stdout.write(renderPage(ordered, layout, options, page, size(), width(), false));
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const wasRaw = Boolean(process.stdin.isRaw);
    const wasFlowing = process.stdin.readableFlowing === true;
    let closed = false;
    const draw = () => {
      page = Math.min(page, Math.max(1, Math.ceil(ordered.length / size())));
      process.stdout.write('\x1b[H\x1b[2J' + renderPage(ordered, layout, options, page, size(), width(), true, selected));
    };
    const finish = (interrupted = false, error?: unknown) => {
      if (closed) return;
      closed = true;
      process.stdin.removeListener('keypress', onKey);
      process.stdin.removeListener('end', onEnd);
      process.stdout.removeListener('resize', draw);
      cancellation.signal.removeEventListener('abort', onAbort);
      process.stdin.setRawMode(wasRaw);
      if (!wasFlowing) process.stdin.pause();
      process.stdout.write('\x1b[?25h\x1b[?1049l');
      if (interrupted) process.exitCode = 130;
      else process.stdout.write(renderPage(ordered, layout, options, page, size(), width(), false));
      if (error !== undefined) reject(error);
      else resolve();
    };
    const onEnd = () => finish();
    const onAbort = () => finish(true);
    const onKey = (_text: string, key: Key) => {
      if (key.ctrl && key.name === 'c') { finish(true); return; }
      if (key.name === 'q' || key.name === 'escape') { finish(); return; }
      const last = Math.max(1, Math.ceil(ordered.length / size()));
      if (key.name === 'down') selected = Math.min(Math.max(0, Math.min(size(), ordered.length - 1) - 1), selected + 1);
      else if (key.name === 'up') selected = Math.max(0, selected - 1);
      else if (key.name === 'return') { finish(); return; }
      else if (['right', 'pagedown', 'n', 'space'].includes(key.name ?? '')) page = Math.min(last, page + 1);
      else if (['left', 'up', 'pageup', 'p', 'backspace'].includes(key.name ?? '')) page = Math.max(1, page - 1);
      else if (key.name === 'home') page = 1;
      else if (key.name === 'end') page = last;
      else return;
      draw();
    };
    try {
      emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('keypress', onKey);
      process.stdin.once('end', onEnd);
      process.stdout.on('resize', draw);
      cancellation.signal.addEventListener('abort', onAbort, { once: true });
      process.stdout.write('\x1b[?1049h\x1b[?25l');
      draw();
      if (cancellation.signal.aborted) finish(true);
    } catch (error) { finish(true, error); }
  });
}
