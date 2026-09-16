import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { render } from 'ink';
import type { ListLayout, ListOptions, ListRow } from './list-view.js';
import { t } from './i18n.js';

export interface TuiActions {
  install?: (row: ListRow, report: (message: string) => void) => Promise<void>;
  use?: (row: ListRow, report: (message: string) => void) => Promise<void>;
  setDefault?: (row: ListRow, report: (message: string) => void) => Promise<void>;
  uninstall?: (row: ListRow, report: (message: string) => void) => Promise<void>;
  refresh?: () => Promise<void>;
}

interface Props { rows: ListRow[]; layout: ListLayout; options: ListOptions; actions?: TuiActions; }

function App({ rows, layout, options, actions }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState(false);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? rows.filter(row => `${row.version} ${row.status ?? ''} ${row.detail ?? ''}`.toLowerCase().includes(q)) : rows;
  }, [rows, query, tick]);
  const viewportSize = Math.max(3, (stdout.rows || 24) - 10);
  const viewportStart = Math.min(Math.max(0, selected - viewportSize + 1), Math.max(0, filtered.length - viewportSize));
  const viewport = filtered.slice(viewportStart, viewportStart + viewportSize);
  useEffect(() => setSelected(value => Math.min(value, Math.max(0, filtered.length - 1))), [filtered.length]);
  const row = filtered[selected];
  const run = async (action: ((r: ListRow, report: (m: string) => void) => Promise<void>) | undefined) => {
    if (!row || !action || busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await action(row, setMessage); setMessage(t('Completed')); setTick(value => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  useInput((input, key) => {
    if (busy) return;
    if (key.ctrl && input === 'c') { exit(); return; }
    if (help) { if (key.escape || input === '?' || input === 'q') setHelp(false); return; }
    if (input === 'q' || key.escape) { exit(); return; }
    if (input === '?') { setHelp(true); return; }
    if (input === '/') { setSearchMode(true); setMessage(''); return; }
    if (searchMode) { if (key.escape) { setSearchMode(false); setQuery(''); setMessage(''); } return; }
    if (key.upArrow || input === 'k') setSelected(value => Math.max(0, value - 1));
    else if (key.downArrow || input === 'j') setSelected(value => Math.min(filtered.length - 1, value + 1));
    else if (key.pageUp) setSelected(value => Math.max(0, value - 10));
    else if (key.pageDown) setSelected(value => Math.min(filtered.length - 1, value + 10));
    else if (key.home) setSelected(0);
    else if (key.end) setSelected(Math.max(0, filtered.length - 1));
    else if (input === 'r' && actions?.refresh) actions.refresh().catch(cause => setError(String(cause)));
    else if (input === 'i') void run(actions?.install);
    else if (input === 'u' || key.return) void run(actions?.use ?? actions?.install);
    else if (input === 'd') void run(actions?.setDefault);
    else if (input === 'x') void run(actions?.uninstall);
  });
  if (help) return <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}><Text color="cyan" bold>{t('Nova keyboard help')}</Text><Text>↑/↓ j/k  {t('select')}   Enter/u {t('use/install')}</Text><Text>i {t('install')}   d {t('set default')}   x {t('uninstall')}</Text><Text>/ {t('search')}   {actions?.refresh ? `r ${t('refresh')}   ` : ''}q {t('quit')}</Text><Text dimColor>{t('Press ? or Esc to close')}</Text></Box>;
  return <Box flexDirection="column" paddingX={1}>
    <Text color="cyan" bold>{layout.title} ({filtered.length}/{rows.length})</Text>
    {searchMode ? <Box><Text color="cyan">{t('Search')}: </Text><TextInput value={query} onChange={setQuery} onSubmit={() => { setSearchMode(false); setMessage(''); }} /></Box> : <Text dimColor>{query ? `${t('Search')}: ${query}` : t('Press / to search, ? for help')}</Text>}
    <Box marginTop={1} flexDirection="column">
      <Text bold>{t('VERSION')}{layout.statuses ? `  ${t('STATUS')}` : ''}{options.verbose ? `  ${t('PATH')}` : ''}</Text>
      {viewportStart > 0 && <Text dimColor>  ⋮ {viewportStart} {t('more above')}</Text>}
      {viewport.map((item, offset) => { const index = viewportStart + offset; return <Text key={`${item.version}-${index}`} inverse={index === selected && !options.noColor} color={!options.noColor && process.env.NO_COLOR === undefined && item.status?.includes('latest') ? 'green' : undefined}>{index === selected ? '› ' : '  '}{item.version}{layout.statuses ? `  ${item.status ?? ''}` : ''}{options.verbose ? `  ${item.detail ?? ''}` : ''}</Text>; })}
      {viewportStart + viewport.length < filtered.length && <Text dimColor>  ⋮ {filtered.length - viewportStart - viewport.length} {t('more below')}</Text>}
    </Box>
    <Box marginTop={1}><Text>{busy ? <><Spinner type="dots" /> {message || t('Working…')}</> : error ? <Text color="red">✖ {error}</Text> : message ? <Text color="green">✔ {message}</Text> : <Text dimColor>{t('↑/↓ select · Enter action · / search · ? help · q quit')}</Text>}</Text></Box>
  </Box>;
}

export async function displayTui(rows: ListRow[], layout: ListLayout, options: ListOptions, actions?: TuiActions): Promise<void> {
  const instance = render(<App rows={rows} layout={layout} options={options} actions={actions} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
}
