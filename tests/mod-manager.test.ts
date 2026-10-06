import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'mod-manager',
  component: 'Pane',
  requestId: 'mod-manager',
  viewport: { columns: 160, rows: 40 },
  props: {
    title: 'Mods',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const PLATFORMS = [
  { os: 'windows', cwd: 'C:\\work', home: 'C:\\Users\\me', sep: '\\' },
  { os: 'posix', cwd: '/work', home: '/Users/me', sep: '/' },
] as const

type Platform = (typeof PLATFORMS)[number]

function fixtures(p: Platform) {
  const plugins = p.home + p.sep + '.claude' + p.sep + 'plugins'
  const mk = (name: string) => plugins + p.sep + 'marketplaces' + p.sep + name
  const cache = (mkt: string, name: string, v: string) =>
    [plugins, 'cache', mkt, name, v].join(p.sep)
  const installed = [
    // A catalog with a relative source: the newest version is in the plugin's own plugin.json
    { id: 'alpha@shop', version: '1.0.0', scope: 'user', enabled: true, installPath: cache('shop', 'alpha', '1.0.0') },
    // The catalog entry carries the version, and it matches
    { id: 'beta@shop', version: '2.0.0', scope: 'project', enabled: true, installPath: cache('shop', 'beta', '2.0.0') },
    // Pinned to a git commit: a different sha means a newer commit
    { id: 'gamma@official', version: '1.0.0', scope: 'user', enabled: true, installPath: cache('official', 'gamma', '1.0.0') },
    // Disabled, and up to date
    { id: 'delta@shop', version: '0.3.0', scope: 'user', enabled: false, installPath: cache('shop', 'delta', '0.3.0') },
    // Loaded with --plugin-dir
    { id: 'devmod@inline', version: '0.1.0', scope: 'session', enabled: true, installPath: p.cwd + p.sep + 'devmod' },
  ]
  const markets = [
    { name: 'shop', source: 'github', repo: 'me/shop', installLocation: mk('shop') },
    { name: 'official', source: 'github', repo: 'org/official', installLocation: mk('official') },
  ]
  const files: Record<string, string> = {
    'marketplaces/shop/.claude-plugin/marketplace.json': JSON.stringify({
      name: 'shop',
      plugins: [
        { name: 'alpha', source: './plugins/alpha', description: 'Alpha does things', homepage: 'https://example.com/alpha' },
        { name: 'beta', source: './plugins/beta', version: '2.0.0' },
        { name: 'delta', source: './plugins/delta', version: '0.3.0' },
      ],
    }),
    'marketplaces/shop/plugins/alpha/.claude-plugin/plugin.json': JSON.stringify({ name: 'alpha', version: '1.2.0' }),
    'marketplaces/official/.claude-plugin/marketplace.json': JSON.stringify({
      name: 'official',
      plugins: [{ name: 'gamma', source: { source: 'url', url: 'https://example.com/gamma.git', sha: 'bbbbbbb1111' } }],
    }),
    'marketplaces/tools/.claude-plugin/marketplace.json': JSON.stringify({
      name: 'tools',
      metadata: { description: 'Team tools' },
      plugins: [
        { name: 'tool-a', source: './a', version: '1.0.0', description: 'First tool' },
        { name: 'tool-b', source: './b', version: '2.0.0', description: 'Second tool' },
      ],
    }),
    'plugins/installed_plugins.json':
      '\uFEFF' +
      JSON.stringify({
        version: 2,
        plugins: { 'gamma@official': [{ scope: 'user', version: '1.0.0', gitCommitSha: 'aaaaaaa2222' }] },
      }),
  }
  const toolsMarket = { name: 'tools', source: 'git', url: 'https://gitlab.com/grp/tools.git', installLocation: mk('tools') }
  return { installed, markets, files, toolsMarket }
}

// Stubs everything the mod reaches outside itself; returns the argv of every process it ran
function setup(
  $: any,
  on: any,
  p: Platform,
  opts: { failUpdate?: boolean; store?: Record<string, unknown>; addResult?: 'ok' | 'missing' } = {},
) {
  const runs: string[][] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const commands: string[] = []
  const fx = fixtures(p)
  const clock = mock.clock(on, { now: 1_000_000 })
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })

  on('session.start', () => ({ cwd: p.cwd }))
  on('session.cwd', () => ({ value: p.cwd }))
  on('env.get', ($: any, e: any) => ({
    value: e.name === 'OS' ? (p.os === 'windows' ? 'Windows_NT' : undefined) : p.home,
  }))
  on('command.register', () => ({ value: { command: 'mod-manager' } }))
  on('command.run', ($: any, e: any) => {
    commands.push(e.command)
    return {}
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($: any, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: undefined }))
  on('fs.read', ($: any, e: any) => {
    const path = String(e.path).replace(/\\/g, '/')
    const hit = Object.keys(fx.files).find((k) => path.endsWith(k))
    return hit ? { value: fx.files[hit] } : { deny: 'ENOENT: ' + path }
  })
  on('process.run', ($: any, e: any) => {
    const argv = [...e.argv] as string[]
    runs.push(argv)
    const i = argv.indexOf('plugin')
    const args = i >= 0 ? argv.slice(i + 1) : argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (argv[0] === 'git') return ok('ccccccc3333\tHEAD\n')
    if (args[0] === 'list') return ok(JSON.stringify({ installed: fx.installed }))
    if (args[0] === 'marketplace' && args[1] === 'list') return ok(JSON.stringify(fx.markets))
    if (args[0] === 'marketplace' && args[1] === 'update') return ok('updated')
    if (args[0] === 'marketplace' && args[1] === 'add') {
      if (opts.addResult === 'missing')
        return {
          value: {
            exitCode: 1,
            stdout: JSON.stringify({ command: 'marketplace-add', outcome: 'failed', message: 'Marketplace file not found', failureCode: 'manifest_missing' }),
            stderr: '',
          },
        }
      fx.markets.push(fx.toolsMarket)
      return ok('warming up\n' + JSON.stringify({ command: 'marketplace-add', outcome: 'success', name: 'tools' }))
    }
    if (args[0] === 'update' && opts.failUpdate)
      return { value: { exitCode: 1, stdout: '', stderr: 'Error: network unreachable\r\n' } }
    if (['update', 'uninstall', 'enable', 'disable', 'install'].includes(args[0])) return ok('done')
    return ok('')
  })
  return { runs, toasts, statuses, commands, clock, store }
}

async function openAndCheck($: any, clock: any) {
  await $.command.run({ command: 'mod-manager', args: '' })
  for (let i = 0; i < 5; i++) {
    await clock.advance(10)
    await clock.settle()
  }
}

for (const p of PLATFORMS) {
  test('lists mods by section and flags the outdated ones on ' + p.os, async ($, on) => {
    const { runs, clock } = setup($, on, p)
    await openAndCheck($, clock)

    // claude runs directly first on both platforms (no shell)
    expect(runs.find((r) => r.includes('list'))?.[0]).toBe('claude')
    // Opening the pane refreshed the marketplaces the mods came from
    expect(runs.some((r) => r.join(' ').endsWith('marketplace update shop'))).toBe(true)
    expect(runs.some((r) => r.join(' ').endsWith('marketplace update official'))).toBe(true)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface } as any)
      expect(await ui.find({ type: 'Text', text: 'UPDATES AVAILABLE (2)' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'INSTALLED (1)' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'DISABLED (1)' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'LOCAL FOLDERS (--plugin-dir) (1)' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '→ 1.2.0' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '→ new commit' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /2 updates/ })).toBeDefined()
      await ui.unmount()
    }
  })
}

test('the status line counts updates after the start-up check', async ($, on) => {
  const { statuses, clock } = setup($, on, PLATFORMS[0])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' } as any)
  for (let i = 0; i < 5; i++) {
    await clock.advance(5_000)
    await clock.settle()
  }
  expect(statuses.at(-1)).toBe('▲ 2 mod updates · /mod-manager')
})

test('u updates the highlighted mod with its scope, then offers a reload', async ($, on) => {
  const { runs, commands, clock } = setup($, on, PLATFORMS[0])
  await openAndCheck($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'act-u' })
  expect(runs.some((r) => r.join(' ').endsWith('plugin update alpha@shop --scope user'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Updated alpha 1\.0\.0 → 1\.2\.0/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'UPDATES AVAILABLE (1)' })).toBeDefined()
  await ui.press({ key: 'act-r' })
  expect(commands).toContain('reload-plugins')
})

test('a failed update shows the CLI error', async ($, on) => {
  const { clock } = setup($, on, PLATFORMS[1], { failUpdate: true })
  await openAndCheck($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'act-u' })
  expect(await ui.find({ type: 'Text', text: /Could not update alpha: Error: network unreachable/ })).toBeDefined()
})

test('x asks before uninstalling; n cancels and y uninstalls', async ($, on) => {
  const { runs, clock } = setup($, on, PLATFORMS[0])
  await openAndCheck($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)

  await ui.press({ key: 'act-x' })
  expect(await ui.find({ type: 'Text', text: 'Uninstall alpha@shop?' })).toBeDefined()
  await ui.press({ key: 'confirm-no' })
  expect(runs.some((r) => r.includes('uninstall'))).toBe(false)

  await ui.press({ key: 'act-x' })
  await ui.press({ key: 'confirm-yes' })
  expect(runs.some((r) => r.join(' ').endsWith('plugin uninstall alpha@shop --scope user'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'UPDATES AVAILABLE (1)' })).toBeDefined()
})

test('a update-all confirms, then updates every outdated mod', async ($, on) => {
  const { runs, clock } = setup($, on, PLATFORMS[1])
  await openAndCheck($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'act-a' })
  await ui.press({ key: 'confirm-yes' })
  const updates = runs.filter((r) => r.includes('update') && !r.includes('marketplace')).map((r) => r.join(' '))
  expect(updates.length).toBe(2)
  expect(await ui.find({ type: 'Text', text: /Updated 2 of 2 mods/ })).toBeDefined()
})

test('Enter opens details; e disables; b goes back; filter narrows the list', async ($, on) => {
  const { runs, clock } = setup($, on, PLATFORMS[0])
  await openAndCheck($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)

  await ui.press({ key: 'row:alpha@shop|user' })
  expect(await ui.find({ type: 'Text', text: 'Alpha does things' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▲ update available' })).toBeDefined()
  await ui.press({ key: 'act-e' })
  expect(runs.some((r) => r.join(' ').endsWith('plugin disable alpha@shop --scope user'))).toBe(true)
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: 'DISABLED (2)' })).toBeDefined()

  await ui.press({ key: 'act-f' })
  await ui.input({ key: 'filter', text: 'gam', kind: 'change' } as any)
  expect(await ui.find({ type: 'Text', text: 'UPDATES AVAILABLE (1)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'DISABLED (2)' })).toBeUndefined()
})

test('mods loaded with --plugin-dir are not updated or uninstalled', async ($, on) => {
  const { runs, clock } = setup($, on, PLATFORMS[1])
  await openAndCheck($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'row:devmod@inline|session' })
  await ui.press({ key: 'act-x' })
  expect(runs.some((r) => r.includes('uninstall'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /loaded from a folder with --plugin-dir/ })).toBeDefined()
})

test('auto-update updates the opted-in mods after a check, and only those', async ($, on) => {
  const { runs, toasts, clock } = setup($, on, PLATFORMS[0], { store: { 'auto-update:alpha@shop': true } })
  await openAndCheck($, clock)
  const updates = runs.filter((r) => r.includes('update') && !r.includes('marketplace')).map((r) => r.join(' '))
  expect(updates.length).toBe(1)
  expect(updates[0]).toMatch(/plugin update alpha@shop --scope user$/)
  expect(toasts).toContain('Auto-updated 1 mod')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /Auto-updated alpha/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'auto' })).toBeDefined()
})

test('t turns auto-update on for a mod, saves it, and updates it straight away', async ($, on) => {
  const { runs, clock, store } = setup($, on, PLATFORMS[1])
  await openAndCheck($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await ui.press({ key: 'act-t' })
  expect(store.get('auto-update:alpha@shop')).toBe(true)
  expect(runs.some((r) => r.join(' ').endsWith('plugin update alpha@shop --scope user'))).toBe(true)
})

test('m adds a GitLab repo as a marketplace and installs the ticked plugins', async ($, on) => {
  const { runs, clock } = setup($, on, PLATFORMS[0])
  await openAndCheck($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'act-m' })
  await ui.input({ key: 'repo', text: 'https://gitlab.com/grp/tools/-/tree/main' })
  expect(runs.some((r) => r.join(' ').endsWith('plugin marketplace add https://gitlab.com/grp/tools.git --json'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'Team tools' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Added marketplace tools: 2 plugins/ })).toBeDefined()

  // Both are ticked; untick tool-b, then install
  await ui.press({ key: 'pick:tool-b' })
  await ui.press({ key: 'act-i' })
  const installs = runs.filter((r) => r.includes('install')).map((r) => r.join(' '))
  expect(installs.length).toBe(1)
  expect(installs[0]).toMatch(/plugin install tool-a@tools --scope user$/)
  expect(await ui.find({ type: 'Text', text: /Installed tool-a/ })).toBeDefined()
})

test('a GitHub URL becomes owner/repo; a repo without marketplace.json is explained', async ($, on) => {
  const { runs, clock } = setup($, on, PLATFORMS[1], { addResult: 'missing' })
  await openAndCheck($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'act-m' })
  await ui.input({ key: 'repo', text: 'https://github.com/someone/plain-repo.git' })
  expect(runs.some((r) => r.join(' ').endsWith('plugin marketplace add someone/plain-repo --json'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /is not a Claude Code marketplace/ })).toBeDefined()
})

test('text that is not a URL never reaches the CLI', async ($, on) => {
  const { runs, clock } = setup($, on, PLATFORMS[0])
  await openAndCheck($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'act-m' })
  await ui.input({ key: 'repo', text: 'owner/repo & del /q C:' })
  expect(runs.some((r) => r.includes('add'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /does not look like a repository URL/ })).toBeDefined()
})
