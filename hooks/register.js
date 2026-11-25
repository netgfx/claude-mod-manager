// mod-manager: a /mod-manager side pane that lists every installed mod and
// plugin, checks the marketplaces for newer versions in the background, and
// updates, uninstalls, enables, disables, reloads and opens them.
//
// All plugin changes go through the `claude plugin …` CLI, so the pane does
// exactly what the person would do in a shell. Helpers that take $ are
// top-level functions: static analysis refuses $ passed anywhere else.

import { atom, read, update } from 'claude-code'

const PANE = 'mod-manager'
const PANE_COLUMNS = 60
const NOTICE_MS = 12_000
const RELOADING = 'Reloading plugins…'
const CHECK_DELAY_MS = 4_000

// Data the pane draws lives in $.state so it survives /reload-plugins and hot reloads
const modsAtom = atom({ plugin: 'powermods-mod-manager', key: 'mods' }, [])
const scanAtom = atom({ plugin: 'powermods-mod-manager', key: 'scan' }, { phase: 'idle', at: 0, error: '' })
const noticeAtom = atom({ plugin: 'powermods-mod-manager', key: 'notice' }, null)
const busyAtom = atom({ plugin: 'powermods-mod-manager', key: 'busy' }, null)
const pendingAtom = atom({ plugin: 'powermods-mod-manager', key: 'pendingReload' }, false)

// UI state: module variables, reset on reload (that's fine for these)
let view = 'list' // 'list' | 'detail' | 'add' | 'pick'
let selected = '' // uid of the highlighted row
let filter = ''
let filterOpen = false
let confirm = null // { uid, kind: 'uninstall' | 'update-all' }
let addDraft = '' // the repository field in the add view
let addError = ''
// The marketplace just added: its plugins and which ones are ticked for install
let pick = null // { market, description, plugins: [{ name, description, version, installed }], chosen: Set }

let options = {}
let platform // 'windows' | 'posix'
let home = ''
let scanning = false
// Updates auto-update already tried this session (uid@version), so a failing one isn't retried every check
const autoTried = new Set()

// ---- Platform and processes ------------------------------------------------

async function detectPlatform($) {
  if (platform) return platform
  const cwd = await $.session.cwd()
  if (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\')) {
    platform = 'windows'
  } else {
    platform = (await $.env.get('OS')) === 'Windows_NT' ? 'windows' : 'posix'
  }
  home = platform === 'windows' ? (await $.env.get('USERPROFILE')) ?? '' : (await $.env.get('HOME')) ?? ''
  return platform
}

// ---- What may reach a command line ---------------------------------------------
//
// Plugin and marketplace names come from marketplace.json files that anyone can
// publish, so they are checked before they reach any command: letters, digits,
// dot, underscore and hyphen, starting with a letter or digit (the names Claude
// Code itself installs). Nothing else is passed on.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SCOPES = ['user', 'project', 'local', 'managed']
// The only characters an argument may hold when it has to go through cmd.exe (npm's
// claude.cmd shim): none of them is special to cmd (& | < > ^ % ! " ( ) , ; = and
// spaces are all outside it).
const CMD_SAFE = /^[A-Za-z0-9._~:/@#+-]+$/
// The flags this mod passes; any other argument that starts with - is refused, so a
// name or source can never be read as an option
const FLAGS = ['--json', '--scope']

function isName(s) {
  return typeof s === 'string' && NAME_RE.test(s)
}

function isScope(s) {
  return SCOPES.includes(s)
}

// A plugin id the CLI may receive: name@marketplace, both checked
function isPluginId(id) {
  const at = String(id ?? '').lastIndexOf('@')
  return at > 0 && isName(id.slice(0, at)) && isName(id.slice(at + 1))
}

// Refuses an argument list that could be read as anything but what this mod built
function checkArgs(args) {
  for (const a of args) {
    if (typeof a !== 'string' || !a) throw new Error('refused an empty argument')
    if (a.startsWith('-') && !FLAGS.includes(a)) throw new Error('refused the argument "' + a.slice(0, 40) + '"')
  }
}

// The ways to start the claude CLI on this machine, best first. Each is argv[0..n)
// to put before the arguments, and whether it goes through cmd.exe.
async function claudeLaunchers($) {
  const os = await detectPlatform($)
  if (os !== 'windows') return [{ argv: ['claude'] }, { argv: [home + '/.local/bin/claude'] }]
  // where.exe lists every claude on PATH. An .exe runs directly, with no shell.
  let found = []
  try {
    const r = await $.process.run(['where.exe', 'claude'], { timeoutMs: 10_000 })
    if (r.exitCode === 0) found = String(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  } catch {
    // where.exe missing or PATH empty: the fixed candidates below still apply
  }
  const exes = found.filter((p) => /\.exe$/i.test(p))
  const list = [...exes.map((p) => ({ argv: [p] })), { argv: ['claude'] }, { argv: [home + '\\.local\\bin\\claude.exe'] }]
  // npm's claude.cmd shim can only start through cmd.exe. Last resort, and only
  // with arguments that pass CMD_SAFE (runClaude checks them).
  const shim = found.find((p) => /\.cmd$/i.test(p) && CMD_SAFE.test(p.replace(/\\/g, '/')))
  list.push({ argv: ['cmd', '/d', '/s', '/c', shim ?? 'claude'], viaCmd: true })
  return list
}

let launcher = null // the launcher that worked last, tried first next time

// Runs `claude <args>`. $.process.run uses no shell: the CLI starts directly
// wherever possible (claude.exe, or claude on macOS and Linux), with the native
// installer's ~/.local/bin copy as a fallback for the Desktop app's shorter PATH.
// Only when nothing else starts does it go through cmd.exe for npm's claude.cmd,
// and then every argument must be made of CMD_SAFE characters.
async function runClaude($, args, timeoutMs) {
  checkArgs(args)
  const cmdSafe = args.every((a) => CMD_SAFE.test(a))
  if (launcher && (!launcher.viaCmd || cmdSafe)) {
    try {
      return await $.process.run([...launcher.argv, ...args], { timeoutMs: timeoutMs ?? 60_000 })
    } catch {
      launcher = null // look again
    }
  }
  let lastError
  for (const l of await claudeLaunchers($)) {
    if (l.viaCmd && !cmdSafe) {
      lastError = new Error('only npm\'s claude.cmd was found, and it can only run through cmd.exe, which these arguments are not safe for')
      continue
    }
    try {
      const r = await $.process.run([...l.argv, ...args], { timeoutMs: timeoutMs ?? 60_000 })
      launcher = l
      return r
    } catch (err) {
      lastError = err
    }
  }
  throw new Error('Could not start the claude CLI: ' + (lastError?.message ?? 'not found on PATH'))
}

// git URLs a catalog may name for `git ls-remote`: https, ssh or scp-style only, so a
// value such as --upload-pack=… or ext::… never reaches git
function isGitUrl(url) {
  return typeof url === 'string' && /^(https:\/\/|ssh:\/\/|git@)[A-Za-z0-9._~:/@%+-]+$/.test(url)
}

function isGitRef(ref) {
  return typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref)
}

async function runGit($, args) {
  try {
    const r = await $.process.run(['git', ...args], { timeoutMs: 15_000 })
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null
  }
}

// Opens a folder or URL with the OS: Explorer, Finder, or xdg-open
async function openWithOs($, target) {
  const os = await detectPlatform($)
  const attempts =
    os === 'windows'
      ? [['explorer.exe', /^https?:/i.test(target) ? target : target.replace(/\//g, '\\')]]
      : [['open', target], ['xdg-open', target]]
  for (const argv of attempts) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 10_000 })
      // explorer.exe exits 1 even when it opened the window
      if (os === 'windows' || r.exitCode === 0) return true
    } catch {
      // try the next opener
    }
  }
  return false
}

// ---- Parsing helpers (no $) ------------------------------------------------

function parseJson(text) {
  const clean = String(text ?? '').replace(/^\uFEFF/, '').trim()
  try {
    return JSON.parse(clean)
  } catch {
    // The CLI can print a warning line before the JSON
    const start = clean.search(/[[{]/)
    if (start < 0) throw new Error('no JSON in output')
    return JSON.parse(clean.slice(start))
  }
}

function firstLine(text) {
  return (
    String(text ?? '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l) ?? ''
  )
}

function norm(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

function joinPath(base, ...parts) {
  let out = norm(base).replace(/\/+$/, '')
  for (const part of parts) out += '/' + norm(part).replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
  return out
}

// Compares dotted versions numerically: 1.10.0 > 1.9.3. Returns null when either isn't one.
function compareVersions(a, b) {
  const parse = (v) => {
    const m = String(v ?? '').trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)/)
    return m ? m[1].split('.').map(Number) : null
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

function sameSha(a, b) {
  if (!a || !b) return null
  const n = Math.min(a.length, b.length, 40)
  return a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase()
}

function ago(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return Math.round(s / 60) + 'm ago'
  if (s < 86_400) return Math.round(s / 3600) + 'h ago'
  return Math.round(s / 86_400) + 'd ago'
}

function pad(text, width) {
  const t = String(text)
  if (t.length > width) return t.slice(0, Math.max(1, width - 1)) + '…'
  return t + ' '.repeat(width - t.length)
}

// The last JSON line the CLI printed with --json, or null
function lastJsonLine(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).reverse()
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      // keep looking
    }
  }
  return null
}

// Turns what the person pasted into a source `claude plugin marketplace add` takes.
// Only URL characters get through: on Windows the cmd.exe fallback would read & | < > ^.
function normalizeSource(input) {
  const s = String(input ?? '').trim().replace(/\/+$/, '')
  if (!s) return { error: 'Paste a GitHub or GitLab repository URL.' }
  if (!/^[A-Za-z0-9._~:/@#+-]+$/.test(s)) return { error: 'That does not look like a repository URL.' }
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i)
  if (m) return { source: m[1] + '/' + m[2], host: 'GitHub' }
  m = s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i)
  if (m) return { source: m[1] + '/' + m[2], host: 'GitHub' }
  // gitlab.com or a self-hosted GitLab; drops /-/tree/<branch> and the like
  m = s.match(/^(?:https?:\/\/)?([\w.-]*gitlab[\w.-]*)\/(.+?)(?:\.git)?(?:\/-\/.*)?$/i)
  if (m) return { source: 'https://' + m[1] + '/' + m[2] + '.git', host: 'GitLab' }
  if (/^git@[\w.-]+:.+$/.test(s)) return { source: /\.git$/i.test(s) ? s : s + '.git', host: 'git' }
  if (/^https?:\/\/[\w.-]+\/.+$/i.test(s)) return { source: /\.(git|json)$/i.test(s) ? s : s + '.git', host: 'git' }
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return { source: s, host: 'GitHub' }
  return { error: 'Use github.com/owner/repo, gitlab.com/group/project, owner/repo, or a git URL.' }
}

function sourceKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

function explainAddFailure(result, r) {
  if (result?.failureCode === 'manifest_missing')
    return 'That repository is not a Claude Code marketplace: it has no .claude-plugin/marketplace.json at its root.'
  if (result?.failureCode === 'error_not_found') return "Repository not found, or you don't have access to it."
  return firstLine(result?.message) || firstLine(r?.stderr) || firstLine(r?.stdout) || 'claude plugin marketplace add failed'
}

function toMod(p, previous) {
  const id = String(p.id ?? p.name ?? '')
  const at = id.lastIndexOf('@')
  const name = at > 0 ? id.slice(0, at) : id
  const marketplace = at > 0 ? id.slice(at + 1) : ''
  const scope = String(p.scope ?? 'user')
  const isDev = marketplace === 'inline' || scope === 'session'
  return {
    uid: id + '|' + scope,
    id,
    name,
    marketplace,
    version: String(p.version ?? ''),
    scope,
    enabled: p.enabled !== false,
    isDev,
    installPath: String(p.installPath ?? ''),
    lastUpdated: String(p.lastUpdated ?? p.installedAt ?? ''),
    sha: '',
    folderVersion: String(p.folderVersion ?? ''),
    // Keep the last answer on screen while the new check runs
    status: isDev ? 'dev' : previous && previous.version === String(p.version ?? '') ? previous.status : 'checking',
    latest: previous?.latest ?? '',
    latestSha: previous?.latestSha ?? '',
    reason: previous?.reason ?? '',
    description: previous?.description ?? '',
    homepage: previous?.homepage ?? '',
    auto: previous?.auto ?? false,
  }
}

function sectionOf(m) {
  if (m.isDev) return 'dev'
  if (!m.enabled) return 'disabled'
  if (m.status === 'outdated') return 'outdated'
  return 'installed'
}

function matches(m, text) {
  const q = text.trim().toLowerCase()
  if (!q) return true
  return (m.name + ' ' + m.marketplace + ' ' + m.description).toLowerCase().includes(q)
}

// ---- Reading what's installed and what's latest ------------------------------

async function listInstalled($) {
  const r = await runClaude($, ['plugin', 'list', '--json'], 30_000)
  if (r.exitCode !== 0) throw new Error(firstLine(r.stderr || r.stdout) || 'claude plugin list failed')
  const data = parseJson(r.stdout)
  return Array.isArray(data) ? data : (data.installed ?? [])
}

async function listMarketplaces($) {
  try {
    const r = await runClaude($, ['plugin', 'marketplace', 'list', '--json'], 30_000)
    if (r.exitCode !== 0) return []
    const data = parseJson(r.stdout)
    return Array.isArray(data) ? data : (data.marketplaces ?? [])
  } catch {
    return []
  }
}

// installed_plugins.json records the git commit each install came from
async function readInstalledShas($, mods, markets) {
  const sample = [...mods.map((m) => m.installPath), ...markets.map((m) => m.installLocation ?? '')]
    .map(norm)
    .map((p) => p.match(/^(.*\/plugins)\/(cache|marketplaces)\//i))
    .find(Boolean)
  if (!sample) return new Map()
  try {
    const data = parseJson(await $.fs.read(sample[1] + '/installed_plugins.json'))
    const shas = new Map()
    for (const [id, entries] of Object.entries(data.plugins ?? {})) {
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        if (entry?.gitCommitSha) shas.set(id + '|' + (entry.scope ?? 'user'), entry.gitCommitSha)
      }
    }
    return shas
  } catch {
    return new Map()
  }
}

async function refreshMarketplace($, name) {
  if (!isName(name)) return 'skipped a marketplace whose name is not plain letters, digits, . _ or -'
  try {
    const r = await runClaude($, ['plugin', 'marketplace', 'update', name], 90_000)
    return r.exitCode === 0 ? '' : firstLine(r.stderr || r.stdout)
  } catch (err) {
    return err.message
  }
}

async function readCatalog($, market) {
  if (!market?.installLocation) return null
  try {
    return parseJson(await $.fs.read(joinPath(market.installLocation, '.claude-plugin/marketplace.json')))
  } catch {
    return null
  }
}

async function readPluginVersion($, dir) {
  try {
    return String(parseJson(await $.fs.read(joinPath(dir, '.claude-plugin/plugin.json'))).version ?? '')
  } catch {
    return ''
  }
}

// Works out the newest version the marketplace offers and whether `m` is behind it
async function resolveLatest($, m, catalog, market) {
  if (m.isDev) return { ...m, status: 'dev', reason: 'Loaded from a folder with --plugin-dir' }
  if (!catalog) return { ...m, status: 'unknown', reason: 'Marketplace "' + m.marketplace + '" is not available' }
  const entry = (catalog.plugins ?? []).find((p) => p?.name === m.name)
  if (!entry) return { ...m, status: 'gone', latest: '', reason: 'No longer listed in ' + m.marketplace }

  const src = entry.source
  const info = {
    description: String(entry.description ?? m.description ?? ''),
    homepage: String(entry.homepage ?? entry.repository ?? (src?.repo ? 'https://github.com/' + src.repo : '') ?? ''),
  }
  let latest = String(entry.version ?? '')
  let latestSha = ''

  if (typeof src === 'string') {
    if (!latest) latest = await readPluginVersion($, joinPath(market.installLocation, src))
  } else if (src && typeof src === 'object') {
    latestSha = String(src.sha ?? '')
    if (!latest && /^v?\d+\.\d+/.test(String(src.ref ?? ''))) latest = String(src.ref).replace(/^v/i, '')
    // Not pinned in the catalog: ask the remote what its branch points at now
    const url = src.url ?? (src.repo ? 'https://github.com/' + src.repo + '.git' : '')
    const ref = src.ref ?? 'HEAD'
    // The URL and ref come from the catalog: only plain git URLs and refs reach git
    if (!latestSha && !latest && m.sha && isGitUrl(url) && isGitRef(ref)) {
      const out = await runGit($, ['ls-remote', '--', url, ref])
      latestSha = firstLine(out).split(/\s+/)[0] ?? ''
    }
  }
  if (!latest && m.folderVersion) latest = m.folderVersion

  let status = 'unknown'
  let reason = ''
  const cmp = compareVersions(latest, m.version)
  const shaMatch = sameSha(latestSha, m.sha)
  if (cmp === 1 || (cmp === null && latest && m.version && latest !== m.version)) {
    status = 'outdated'
    reason = 'Version ' + latest + ' is available'
  } else if (shaMatch === false && (cmp === 0 || !latest)) {
    status = 'outdated'
    reason = 'A newer commit (' + latestSha.slice(0, 7) + ') is available'
  } else if (cmp !== null || shaMatch === true || (latest && latest === m.version)) {
    status = 'current'
  } else {
    reason = 'The marketplace does not say which version is newest'
  }
  return { ...m, ...info, latest, latestSha, status, reason }
}

// The background check. Lists what's installed straight away, then refreshes
// the marketplaces those mods came from and works out what is behind.
async function checkForUpdates($) {
  if (scanning) return
  scanning = true
  try {
    await update($, scanAtom, (s) => ({ ...s, phase: 'listing', error: '' }))
    const [installed, markets] = await Promise.all([listInstalled($), listMarketplaces($)])
    const previous = new Map((await read($, modsAtom)).map((m) => [m.uid, m]))
    let mods = installed.map((p) => toMod(p, previous.get(String(p.id ?? p.name) + '|' + String(p.scope ?? 'user'))))
    const shas = await readInstalledShas($, mods, markets)
    mods = mods.map((m) => ({ ...m, sha: shas.get(m.uid) ?? shas.get(m.id + '|user') ?? '' }))
    mods = await Promise.all(mods.map(async (m) => ({ ...m, auto: await autoSetting($, m) })))
    await update($, modsAtom, () => mods)
    await update($, scanAtom, (s) => ({ ...s, phase: 'fetching' }))

    const used = [...new Set(mods.filter((m) => !m.isDev && m.marketplace).map((m) => m.marketplace))]
    const byName = new Map(markets.map((mk) => [mk.name, mk]))
    const failures = (await Promise.all(used.filter((n) => byName.has(n)).map((n) => refreshMarketplace($, n)))).filter(Boolean)
    const catalogs = new Map()
    for (const name of used) catalogs.set(name, await readCatalog($, byName.get(name)))

    mods = await Promise.all(
      mods.map((m) => resolveLatest($, m, catalogs.get(m.marketplace), byName.get(m.marketplace))),
    )
    mods = await Promise.all(mods.map((m) => carryRenamedAuto($, m, catalogs.get(m.marketplace))))
    await update($, modsAtom, () => mods)
    const at = await $.clock.now()
    await update($, scanAtom, () => ({
      phase: 'idle',
      at,
      error: failures.length ? 'Some marketplaces could not refresh: ' + failures[0] : '',
    }))
    await showStatus($)
  } catch (err) {
    await update($, scanAtom, (s) => ({ ...s, phase: 'idle', error: err.message }))
    return
  } finally {
    scanning = false
  }
  await autoUpdate($)
}

// A mod's own choice ($.store, per machine) wins; otherwise the auto_update setting
async function autoSetting($, m) {
  if (m.isDev) return false
  try {
    const own = await $.store.get('auto-update:' + m.id)
    if (typeof own === 'boolean') return own
  } catch {
    // no saved choice
  }
  return options.auto_update === true
}

// A plugin its marketplace renamed (the catalog's `renames` map, as Claude Code follows
// it) keeps the auto-update choice made under its old name: the choice is copied to the
// new id once, so turning auto-update on for git-mod still holds after it becomes
// powermods-git.
async function carryRenamedAuto($, m, catalog) {
  const renames = catalog?.renames
  if (m.isDev || !renames || typeof renames !== 'object') return m
  try {
    if (typeof (await $.store.get('auto-update:' + m.id)) === 'boolean') return m
    const resolve = (name) => {
      const seen = new Set()
      while (typeof renames[name] === 'string' && !seen.has(name)) {
        seen.add(name)
        name = renames[name]
      }
      return name
    }
    for (const old of Object.keys(renames)) {
      if (old === m.name || resolve(old) !== m.name) continue
      const choice = await $.store.get('auto-update:' + old + '@' + m.marketplace)
      if (typeof choice !== 'boolean') continue
      await $.store.set('auto-update:' + m.id, choice)
      return { ...m, auto: choice }
    }
  } catch {
    // keep what autoSetting found
  }
  return m
}

// Before 0.3.0 this plugin was named mod-manager, and $.store keeps each plugin's values
// under its own name. Once, copy the per-mod auto-update choices from mod-manager's store
// file into this plugin's store, without replacing a choice already made here. Only
// files named mod-manager_*.json in Claude Code's plugin store folder are read.
async function migrateStore($) {
  try {
    if (await $.store.get('migrated:mod-manager')) return
    await $.store.set('migrated:mod-manager', true)
    let base = ''
    try {
      base = String((await $.env.get('CLAUDE_CONFIG_DIR')) ?? '')
    } catch {
      // not set
    }
    if (!base && home) base = joinPath(home, '.claude')
    if (!base) return
    const dir = joinPath(base, 'plugins', 'store')
    let files = []
    try {
      files = await $.fs.list(dir)
    } catch {
      return
    }
    for (const f of files) {
      if (f.kind === 'directory' || !f.name.startsWith('mod-manager_') || !/\.json$/i.test(f.name)) continue
      let old = null
      try {
        old = parseJson(await $.fs.read(joinPath(dir, f.name)))
      } catch {
        continue
      }
      if (!old || typeof old !== 'object') continue
      for (const [k, v] of Object.entries(old)) {
        if (!k.startsWith('auto-update:') || typeof v !== 'boolean') continue
        if (typeof (await $.store.get(k)) === 'boolean') continue
        await $.store.set(k, v)
      }
    }
  } catch (err) {
    $.ui.log('mod-manager: could not copy auto-update choices from mod-manager: ' + err.message, { to: 'debug' })
  }
}

// Updates the outdated mods that have auto-update on. Each update is tried once per session.
async function autoUpdate($) {
  if (await read($, busyAtom)) return
  const due = (await read($, modsAtom)).filter(
    (m) => m.auto && m.status === 'outdated' && !m.isDev && !autoTried.has(m.uid + '@' + (m.latest || m.latestSha)),
  )
  if (!due.length) return
  const done = []
  for (const m of due) {
    autoTried.add(m.uid + '@' + (m.latest || m.latestSha))
    if (await runAction($, m.uid, 'update')) done.push(m.name)
  }
  if (!done.length) return
  $.ui.toast('Auto-updated ' + done.length + ' mod' + (done.length === 1 ? '' : 's'))
  if (options.auto_reload === true) {
    await reloadPlugins($)
  } else {
    await setNotice($, 'Auto-updated ' + done.join(', ') + '. Press r to reload plugins and apply.', 'ok')
  }
}

async function toggleAuto($, uid) {
  const m = await findMod($, uid)
  if (!m) return
  if (m.isDev) {
    await setNotice($, m.name + ' is loaded from a folder, so there is nothing to auto-update.', 'info')
    return
  }
  const turnOn = !m.auto
  await $.store.set('auto-update:' + m.id, turnOn)
  await update($, modsAtom, (mods) => mods.map((x) => (x.id === m.id ? { ...x, auto: turnOn } : x)))
  await setNotice($, 'Auto-update ' + (turnOn ? 'on' : 'off') + ' for ' + m.name + '.', 'info')
  if (turnOn && m.status === 'outdated') await autoUpdate($)
}

// ---- Adding a marketplace from a repository URL ---------------------------------

async function addMarketplace($, input) {
  const parsed = normalizeSource(input)
  if (parsed.error) {
    addError = parsed.error
    $.ui.invalidate('ui.render')
    return false
  }
  if (await read($, busyAtom)) {
    $.ui.toast('Wait for the current action to finish')
    return false
  }
  addError = ''
  await update($, busyAtom, () => ({ uid: '', verb: 'add', label: 'Adding marketplace from ' + parsed.source }))
  let r = null
  let runError = ''
  const before = await listMarketplaces($)
  try {
    r = await runClaude($, ['plugin', 'marketplace', 'add', parsed.source, '--json'], 300_000)
  } catch (err) {
    runError = err.message
  } finally {
    await update($, busyAtom, () => null)
  }
  const result = lastJsonLine(r?.stdout)
  const after = await listMarketplaces($)
  const named = String(result?.name ?? result?.marketplace ?? result?.marketplaceName ?? '')
  const known = new Set(before.map((mk) => mk.name))
  const key = sourceKey(parsed.source)
  const market =
    after.find((mk) => named && mk.name === named) ??
    after.find((mk) => !known.has(mk.name)) ??
    // Already added earlier: carry on with it
    after.find((mk) => [mk.repo, mk.url, mk.source?.repo, mk.source?.url].some((v) => v && sourceKey(v) === key))

  if (!market) {
    addError = runError || explainAddFailure(result, r)
    $.ui.invalidate('ui.render')
    return false
  }
  if (!isName(market.name)) {
    addError = 'Added it, but the marketplace calls itself "' + String(market.name).slice(0, 60) + '", which is not plain letters, digits, . _ or -, so this pane will not pass it to any command.'
    $.ui.invalidate('ui.render')
    return false
  }
  const catalog = await readCatalog($, market)
  if (!catalog) {
    addError = 'Added ' + market.name + ', but its marketplace.json could not be read.'
    $.ui.invalidate('ui.render')
    return false
  }

  let installedIds = new Set((await read($, modsAtom)).map((m) => m.id))
  try {
    installedIds = new Set((await listInstalled($)).map((p) => String(p.id ?? '')))
  } catch {
    // keep what the pane already knows
  }
  const plugins = (catalog.plugins ?? [])
    .filter((p) => p && typeof p.name === 'string')
    .map((p) => ({
      name: p.name,
      description: String(p.description ?? ''),
      version: String(p.version ?? ''),
      installed: installedIds.has(p.name + '@' + market.name),
      // a name that isn't plain letters, digits, . _ or - is listed but never installed
      safe: isName(p.name),
      // the plugin's folder inside the marketplace, when the catalog ships it there
      dir: localSource(market.installLocation, p.source),
    }))
  // Nothing is ticked: you choose each plugin yourself, after reading what it does
  pick = {
    market: market.name,
    description: String(catalog.description ?? catalog.metadata?.description ?? ''),
    plugins,
    chosen: new Set(),
    checks: {},
  }
  addDraft = ''
  view = 'pick'
  const isNew = !known.has(market.name)
  await setNotice(
    $,
    (isNew ? 'Added marketplace ' : 'Marketplace ') + market.name + (isNew ? '' : ' was already added') + ': ' +
      plugins.length + ' plugin' + (plugins.length === 1 ? '' : 's') + '.',
    'ok',
  )
  const started = pick
  $.clock.after(1, () => validatePicked($, started))
  return true
}

// A relative source inside the marketplace's own folder, or '' (a plugin fetched from
// elsewhere at install time, or a path that climbs out of the marketplace)
function localSource(installLocation, source) {
  if (!installLocation || typeof source !== 'string' || !source.startsWith('./')) return ''
  if (source.split(/[\\/]/).includes('..')) return ''
  return joinPath(installLocation, source)
}

// What `claude plugin validate` says a plugin does: its result line and its hooks:,
// calls:, env and network lines, without the paths in front
function summarizeValidate(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trim())
  const out = []
  for (const l of lines) {
    const m = l.match(/^❯\s+\S+\s+(hooks|calls|env reads|env writes):\s*(.*)$/)
    if (m) out.push(m[1] + ': ' + m[2])
    else if (/^Hosts (not declared|declared|not read)/.test(l)) out.push(l)
  }
  const verdict = lines.find((l) => /Validation (passed|failed)/.test(l))
  if (verdict) out.unshift(verdict)
  return out
}

// Runs `claude plugin validate` on each plugin the marketplace ships in its own folder,
// one after another, so the pick view can show what each one hooks and calls before you
// tick it. Plugins fetched from elsewhere are only known after they are installed.
async function validatePicked($, p) {
  for (const x of p.plugins) {
    if (pick !== p) return // the view moved on
    if (x.installed || !x.safe) continue
    if (!x.dir) {
      p.checks[x.name] = { state: 'remote', lines: [] }
      continue
    }
    p.checks[x.name] = { state: 'checking', lines: [] }
    $.ui.invalidate('ui.render')
    try {
      const r = await runClaude($, ['plugin', 'validate', x.dir], 60_000)
      p.checks[x.name] = { state: 'done', lines: summarizeValidate(r.stdout + '\n' + r.stderr) }
    } catch (err) {
      p.checks[x.name] = { state: 'error', lines: [err.message] }
    }
    $.ui.invalidate('ui.render')
  }
}

async function installPicked($) {
  if (!pick) return
  const names = pick.plugins.filter((p) => pick.chosen.has(p.name) && !p.installed && p.safe).map((p) => p.name)
  if (!names.length) {
    await setNotice($, 'Tick at least one plugin to install.', 'info')
    return
  }
  if (await read($, busyAtom)) return
  const market = pick.market
  const ok = []
  const failed = []
  for (const [i, name] of names.entries()) {
    const id = name + '@' + market
    if (!isPluginId(id)) {
      failed.push(name + ': not a plain plugin name, so it was not installed')
      continue
    }
    await update($, busyAtom, () => ({ uid: '', verb: 'install', label: 'Installing ' + name + ' (' + (i + 1) + '/' + names.length + ')' }))
    try {
      const r = await runClaude($, ['plugin', 'install', id, '--scope', 'user'], 300_000)
      if (r.exitCode === 0) ok.push(name)
      else {
        const why = firstLine(lastJsonLine(r.stdout)?.message) || firstLine(r.stderr) || firstLine(r.stdout)
        const hint = /confirm|--yes|-y\b|tty/i.test(r.stderr + r.stdout) ? ' (run `claude plugin install ' + id + '` in a terminal to confirm it)' : ''
        failed.push(name + ': ' + why + hint)
      }
    } catch (err) {
      failed.push(name + ': ' + err.message)
    }
  }
  await update($, busyAtom, () => null)
  if (ok.length) await update($, pendingAtom, () => true)
  pick = null
  view = 'list'
  await setNotice(
    $,
    (ok.length ? 'Installed ' + ok.join(', ') + '. Press r to reload plugins.' : '') +
      (failed.length ? (ok.length ? ' ' : '') + 'Could not install ' + failed.join('; ') : ''),
    failed.length ? 'error' : 'ok',
  )
  startCheck($)
}

function startCheck($) {
  $.clock.after(1, () => checkForUpdates($))
}

async function showStatus($) {
  if (options.show_status === false) return
  const outdated = (await read($, modsAtom)).filter((m) => m.status === 'outdated').length
  $.ui.status(outdated ? '▲ ' + outdated + ' mod update' + (outdated === 1 ? '' : 's') + ' · /mod-manager' : undefined)
}

// ---- Actions ------------------------------------------------------------------

async function setNotice($, text, kind) {
  const at = await $.clock.now()
  await update($, noticeAtom, () => ({ text, kind, at }))
  $.clock.after(NOTICE_MS, async () => {
    const current = await read($, noticeAtom)
    if (current?.at === at) await update($, noticeAtom, () => null)
  })
}

async function findMod($, uid) {
  return (await read($, modsAtom)).find((m) => m.uid === uid)
}

// update | uninstall | enable | disable, through `claude plugin <verb>`
async function runAction($, uid, verb) {
  const m = await findMod($, uid)
  if (!m) return false
  if (await read($, busyAtom)) {
    $.ui.toast('Wait for the current action to finish')
    return false
  }
  if (m.isDev) {
    await setNotice($, m.name + ' is loaded from a folder with --plugin-dir. Edit or remove it there.', 'info')
    return false
  }
  if (verb === 'update' && m.status !== 'outdated') {
    await setNotice($, m.name + ' is already up to date.', 'info')
    return false
  }
  if (!isPluginId(m.id) || !isScope(m.scope)) {
    await setNotice($, 'Not run: "' + m.id.slice(0, 80) + '" (' + String(m.scope).slice(0, 20) + ') is not a plain plugin id and scope, so this pane will not pass it to a command. Use `claude plugin` in a terminal.', 'error')
    return false
  }

  await update($, busyAtom, () => ({ uid, verb }))
  let ok = false
  try {
    const r = await runClaude($, ['plugin', verb, m.id, '--scope', m.scope], 300_000)
    ok = r.exitCode === 0
    if (!ok) {
      const why = firstLine(r.stderr) || firstLine(r.stdout) || 'exit ' + r.exitCode
      const hint = /confirm|--yes|-y\b|tty/i.test(r.stderr + r.stdout)
        ? ' Run `claude plugin ' + verb + ' ' + m.id + '` in a terminal to confirm it.'
        : ''
      await setNotice($, 'Could not ' + verb + ' ' + m.name + ': ' + why + hint, 'error')
    }
  } catch (err) {
    await setNotice($, 'Could not ' + verb + ' ' + m.name + ': ' + err.message, 'error')
  } finally {
    await update($, busyAtom, () => null)
  }
  if (!ok) return false

  await update($, modsAtom, (mods) =>
    verb === 'uninstall'
      ? mods.filter((x) => x.uid !== uid)
      : mods.map((x) => {
          if (x.uid !== uid) return x
          if (verb === 'update')
            return { ...x, version: x.latest || x.version, sha: x.latestSha || x.sha, status: 'current', reason: '' }
          return { ...x, enabled: verb === 'enable' }
        }),
  )
  await update($, pendingAtom, () => true)
  const done = { update: 'Updated', uninstall: 'Uninstalled', enable: 'Enabled', disable: 'Disabled' }[verb]
  const to = verb === 'update' && m.latest ? ' ' + m.version + ' → ' + m.latest : ''
  await setNotice($, done + ' ' + m.name + to + '. Press r to reload plugins and apply it.', 'ok')
  if (verb === 'uninstall' && selected === uid) {
    selected = ''
    view = 'list'
  }
  await showStatus($)
  return true
}

async function updateAll($) {
  const outdated = (await read($, modsAtom)).filter((m) => m.status === 'outdated' && !m.isDev)
  let count = 0
  for (const m of outdated) if (await runAction($, m.uid, 'update')) count += 1
  if (outdated.length > 1) {
    await setNotice(
      $,
      'Updated ' + count + ' of ' + outdated.length + ' mods.' + (count ? ' Press r to reload plugins.' : ''),
      count === outdated.length ? 'ok' : 'error',
    )
  }
}

async function reloadPlugins($) {
  await update($, pendingAtom, () => false)
  await setNotice($, RELOADING, 'info')
  try {
    // Queued until the session is idle; it reloads this mod too
    await $.command.run({ command: 'reload-plugins' })
  } catch (err) {
    await update($, pendingAtom, () => true)
    await setNotice($, 'Could not reload (' + err.message + '). Type /reload-plugins.', 'error')
  }
}

async function openMod($, uid, what) {
  const m = await findMod($, uid)
  if (!m) return
  const target = what === 'homepage' ? m.homepage : m.installPath
  if (!target) {
    await setNotice($, m.name + ' has no ' + (what === 'homepage' ? 'homepage' : 'install folder') + ' listed.', 'info')
    return
  }
  const ok = await openWithOs($, target)
  if (!ok) {
    $.ui.copy(target)
    await setNotice($, 'Could not open it, so the ' + (what === 'homepage' ? 'link' : 'path') + ' was copied.', 'info')
  }
}

async function openPane($, focus) {
  return $.ui.open({ id: PANE, title: 'Mods', columns: PANE_COLUMNS, ...(focus ? { focus: true } : {}), closeOnEscape: true })
}

// ---- Hooks --------------------------------------------------------------------

export function register(on, opts) {
  options = opts ?? {}

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await detectPlatform($)
    await migrateStore($)
    // A reload just ran (or this is a fresh session): nothing is waiting any more
    await update($, pendingAtom, () => false)
    // $.state kept the notice but the reload cancelled the timer that clears it
    const notice = await read($, noticeAtom)
    if (notice?.text === RELOADING) await setNotice($, 'Plugins reloaded.', 'ok')
    else if (notice) await setNotice($, notice.text, notice.kind)

    try {
      await $.command.register({
        name: 'mod-manager',
        description: 'Open the mod manager pane (open | close | check | add <repo>)',
        argumentHint: '[open|close|check|add <repo>]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('mod-manager: could not register /mod-manager: ' + err.message, { to: 'debug' })
    }
    try {
      await $.command.register({ name: 'mods', description: 'Open the mod manager pane', immediate: true })
    } catch {
      // Another plugin owns /mods; /mod-manager still works
    }

    if (options.check_on_start !== false) $.clock.after(CHECK_DELAY_MS, () => checkForUpdates($))
    const hours = Number(options.check_interval_hours ?? 6)
    if (hours > 0) $.clock.every(hours * 3_600_000, () => checkForUpdates($))
    if (options.auto_open === true) await openPane($, false)
    return started
  })

  // /clear, /resume and /branch reset $.state: list again so the pane isn't empty
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    startCheck($)
    return next(e)
  }).catch(($, e, next) => next(e)) // fail open: the hook guards nothing

  on('command.run', { command: ['mod-manager', 'mods'] }, async ($, e) => {
    const raw = String(e.args ?? '').trim()
    const arg = raw.toLowerCase()
    // /mod-manager add <repo>: open the pane on the add view and add it straight away
    if (arg === 'add' || arg.startsWith('add ')) {
      view = 'add'
      addError = ''
      addDraft = raw.slice(3).trim()
      await openPane($, true)
      if (addDraft) {
        const draft = addDraft
        $.clock.after(1, () => addMarketplace($, draft))
      }
      return {}
    }
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return {}
    }
    if (arg === 'check') {
      startCheck($)
      $.ui.toast('Checking mods for updates…')
      return {}
    }
    view = 'list'
    confirm = null
    const placed = await openPane($, true)
    if (placed && placed.isPlaced === false && placed.reason) $.ui.toast('Mod manager is waiting: ' + placed.reason)
    // Check behind the scenes every time the pane opens
    startCheck($)
    return {}
  })

  // Track which row has the focus ring, so the action keys act on it
  on('ui.focus', async ($, e, next) => {
    if (e.requestId === PANE && typeof e.element === 'string' && e.element.startsWith('row:')) {
      selected = e.element.slice(4)
      $.ui.invalidate('ui.render')
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // fail open: the hook guards nothing

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Input, Link } = $.ui.resolve(e)
    const width = Math.max(30, Number(e.props?.bodyColumns ?? PANE_COLUMNS))
    const wide = width >= 52

    const mods = await read($, modsAtom)
    const scan = await read($, scanAtom)
    const notice = await read($, noticeAtom)
    const busy = await read($, busyAtom)
    const pending = await read($, pendingAtom)
    const now = await $.clock.now()
    const redraw = () => $.ui.invalidate('ui.render')

    const visible = mods.filter((m) => matches(m, filter))
    const order = ['outdated', 'installed', 'disabled', 'dev']
    const sorted = [...visible].sort(
      (a, b) => order.indexOf(sectionOf(a)) - order.indexOf(sectionOf(b)) || a.name.localeCompare(b.name),
    )
    if (!sorted.some((m) => m.uid === selected)) selected = sorted[0]?.uid ?? ''
    const current = mods.find((m) => m.uid === selected)
    if (view === 'detail' && !current) view = 'list'
    const outdated = mods.filter((m) => m.status === 'outdated')

    const key = (k, label, onPress, isOff) =>
      Button({ key: 'act-' + k, label: k + ' ' + label, hotkey: k, plain: true, dimColor: Boolean(isOff), onPress })

    // ---- Header: counts and what the background check is doing
    const scanText =
      scan.phase === 'listing'
        ? Text({ color: 'cyan', children: ['⟳ reading…'] })
        : scan.phase === 'fetching'
          ? Text({ color: 'cyan', children: ['⟳ checking marketplaces…'] })
          : scan.error
            ? Text({ color: 'red', wrap: 'truncate-end', children: ['✕ ' + scan.error] })
            : Number.isFinite(scan.at) && scan.at
              ? Text({ dimColor: true, children: ['✓ checked ' + ago(scan.at, now)] })
              : Text({ dimColor: true, children: ['not checked yet'] })

    const counts = [
      Text({ bold: true, children: [mods.length + ' installed'] }),
      ...(outdated.length ? [Text({ color: 'yellow', children: [' · ' + outdated.length + ' update' + (outdated.length === 1 ? '' : 's')] })] : []),
    ]
    const header = Box({
      flexDirection: 'column',
      children: [Box({ flexDirection: 'row', children: counts }), scanText],
    })

    const banners = []
    if (busy) {
      const m = mods.find((x) => x.uid === busy.uid)
      const verbing = { update: 'Updating', uninstall: 'Uninstalling', enable: 'Enabling', disable: 'Disabling' }[busy.verb]
      banners.push(Text({ color: 'cyan', wrap: 'truncate-end', children: ['⟳ ' + (busy.label ?? verbing + ' ' + (m?.name ?? '')) + '…'] }))
    }
    if (notice) {
      const color = notice.kind === 'error' ? 'red' : notice.kind === 'ok' ? 'green' : undefined
      banners.push(Text({ color, wrap: 'wrap', children: [(notice.kind === 'error' ? '✕ ' : notice.kind === 'ok' ? '✓ ' : '• ') + notice.text] }))
    }
    if (pending && !busy) {
      banners.push(
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Text({ color: 'yellow', children: ['Changes apply after a reload.'] }),
            Button({ key: 'reload-now', label: 'Reload now', plain: true, onPress: () => reloadPlugins($) }),
          ],
        }),
      )
    }
    if (confirm) {
      const m = mods.find((x) => x.uid === confirm.uid)
      const question =
        confirm.kind === 'update-all'
          ? 'Update ' + outdated.length + ' mod' + (outdated.length === 1 ? '' : 's') + '?'
          : 'Uninstall ' + (m?.id ?? '') + (m?.name === 'powermods-mod-manager' || m?.name === 'mod-manager' ? ' (this pane)' : '') + '?'
      const yes = async () => {
        const c = confirm
        confirm = null
        redraw()
        if (c.kind === 'update-all') await updateAll($)
        else await runAction($, c.uid, 'uninstall')
      }
      banners.push(
        Box({
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'yellow',
          paddingX: 1,
          children: [
            Text({ bold: true, children: [question] }),
            Box({
              flexDirection: 'row',
              columnGap: 3,
              children: [
                Button({ key: 'confirm-yes', label: 'y Yes', hotkey: 'y', plain: true, autoFocus: true, onPress: yes }),
                Button({ key: 'confirm-no', label: 'n Cancel', hotkey: 'n', plain: true, onPress: () => { confirm = null; redraw() } }),
              ],
            }),
          ],
        }),
      )
    }

    const rule = Text({ dimColor: true, children: ['─'.repeat(width)] })

    // Action keys for the highlighted mod
    const canUpdate = current && current.status === 'outdated' && !current.isDev
    const modKeys = current
      ? [
          key('u', 'Update', () => runAction($, current.uid, 'update'), !canUpdate),
          key('x', 'Uninstall', () => { if (current.isDev) return runAction($, current.uid, 'uninstall'); confirm = { uid: current.uid, kind: 'uninstall' }; redraw() }, current.isDev),
          key('e', current.enabled ? 'Disable' : 'Enable', () => runAction($, current.uid, current.enabled ? 'disable' : 'enable'), current.isDev),
          key('o', 'Open folder', () => openMod($, current.uid, 'folder'), !current.installPath),
          key('t', current.auto ? 'Auto-update: on' : 'Auto-update: off', () => toggleAuto($, current.uid), current.isDev),
        ]
      : []
    const globalKeys = [
      key('a', 'Update all' + (outdated.length ? ' (' + outdated.length + ')' : ''), () => {
        if (!outdated.length) return setNotice($, 'Everything is up to date.', 'info')
        confirm = { uid: '', kind: 'update-all' }
        redraw()
      }, !outdated.length),
      key('c', 'Check now', () => startCheck($), scan.phase !== 'idle'),
      key('r', 'Reload', () => reloadPlugins($)),
      key('f', filterOpen ? 'Close filter' : 'Filter', () => { filterOpen = !filterOpen; if (!filterOpen) filter = ''; redraw() }),
      key('m', 'Add marketplace', () => { view = 'add'; addError = ''; confirm = null; redraw() }),
    ]
    const keyRows = (keys) => Box({ flexDirection: 'row', columnGap: 2, flexWrap: 'wrap', children: keys })
    const backButton = (label, onPress) =>
      Button({ key: 'back', label: 'b ‹ ' + label, hotkey: 'b', plain: true, onPress })

    // ---- Add view: paste a repository, it becomes a marketplace
    if (view === 'add') {
      return Box({
        flexDirection: 'column',
        children: [
          backButton('Back to list', () => { view = 'list'; addError = ''; redraw() }),
          Text({ children: [' '] }),
          Text({ bold: true, children: ['ADD A MARKETPLACE'] }),
          Text({
            dimColor: true,
            wrap: 'wrap',
            children: ['Paste a GitHub or GitLab repository. It must have .claude-plugin/marketplace.json at its root. You pick which of its plugins to install next.'],
          }),
          Text({ children: [' '] }),
          Input({
            key: 'repo',
            label: 'Repository',
            placeholder: 'github.com/owner/repo',
            value: addDraft,
            autoFocus: true,
            submitLabel: 'add',
            onInput: (v) => { addDraft = v },
            onSubmit: (v) => { addDraft = v; return addMarketplace($, v) },
          }),
          ...(addError ? [Text({ color: 'red', wrap: 'wrap', children: ['✕ ' + addError] })] : []),
          ...banners,
          Text({ children: [' '] }),
          Text({ dimColor: true, children: ['Accepted forms:'] }),
          Text({ dimColor: true, children: ['  owner/repo'] }),
          Text({ dimColor: true, children: ['  https://github.com/owner/repo'] }),
          Text({ dimColor: true, children: ['  https://gitlab.com/group/project'] }),
          Text({ dimColor: true, children: ['  git@gitlab.com:group/project.git'] }),
          rule,
          Text({ dimColor: true, wrap: 'wrap', children: ['Enter adds it · Tab or ↓ leaves the field · Esc closes'] }),
        ],
      })
    }

    // ---- Pick view: which plugins of the new marketplace to install
    if (view === 'pick' && pick) {
      const p = pick
      const chosen = p.plugins.filter((x) => p.chosen.has(x.name) && !x.installed && x.safe).length
      const open = p.plugins.filter((x) => !x.installed && x.safe)
      const nameW = Math.min(28, Math.max(8, ...p.plugins.map((x) => x.name.length)))
      // What `claude plugin validate` found for a plugin, shown under its row
      const checkLines = (x) => {
        if (x.installed) return []
        if (!x.safe) return [Text({ color: 'red', wrap: 'wrap', children: ['    not installable here: its name is not plain letters, digits, . _ or -'] })]
        const c = p.checks[x.name]
        if (!c || c.state === 'checking') return [Text({ dimColor: true, children: ['    ⟳ claude plugin validate…'] })]
        if (c.state === 'remote') return [Text({ dimColor: true, wrap: 'wrap', children: ['    fetched from its own source at install time: run claude plugin validate on it after installing'] })]
        if (c.state === 'error') return [Text({ color: 'red', wrap: 'truncate-end', children: ['    validate: ' + (c.lines[0] ?? 'failed')] })]
        if (!c.lines.length) return [Text({ dimColor: true, children: ['    validate: no hooks module (no mod code)'] })]
        return c.lines.map((l, i) => Text({ key: 'chk-' + x.name + '-' + i, color: /failed/.test(l) ? 'red' : 'cyan', wrap: 'truncate-end', children: ['    ' + l] }))
      }
      const pickRow = (x) =>
        Box({
          key: 'pickline-' + x.name,
          flexDirection: 'column',
          children: [
            Box({
              flexDirection: 'row',
              columnGap: 1,
              children: [
                Button({
                  key: 'pick:' + x.name,
                  label: (x.installed ? '[•] ' : !x.safe ? '[✕] ' : p.chosen.has(x.name) ? '[✓] ' : '[ ] ') + pad(x.name, nameW),
                  plain: true,
                  dimColor: x.installed || !x.safe,
                  onPress: () => {
                    if (x.installed || !x.safe) return
                    if (p.chosen.has(x.name)) p.chosen.delete(x.name)
                    else p.chosen.add(x.name)
                    redraw()
                  },
                }),
                Text({ dimColor: true, children: [x.version] }),
                ...(x.installed ? [Text({ color: 'green', children: ['installed'] })] : []),
              ],
            }),
            ...(x.description ? [Text({ dimColor: true, wrap: 'truncate-end', children: ['    ' + x.description] })] : []),
            ...checkLines(x),
          ],
        })
      return Box({
        flexDirection: 'column',
        children: [
          backButton('Done (skip installing)', () => { pick = null; view = 'list'; startCheck($); redraw() }),
          Text({ children: [' '] }),
          Text({ bold: true, children: [p.market] }),
          ...(p.description ? [Text({ dimColor: true, wrap: 'wrap', children: [p.description] })] : []),
          ...banners,
          rule,
          ...(p.plugins.length
            ? p.plugins.map(pickRow)
            : [Text({ dimColor: true, children: ['This marketplace lists no plugins.'] })]),
          rule,
          keyRows([
            key('i', 'Install selected (' + chosen + ')', () => installPicked($), !chosen),
            key('s', chosen === open.length ? 'Select none' : 'Select all', () => {
              if (chosen === open.length) p.chosen.clear()
              else for (const x of open) p.chosen.add(x.name)
              redraw()
            }, !open.length),
          ]),
          Text({ dimColor: true, wrap: 'wrap', children: ['Nothing is ticked: install only plugins from authors you trust. Mods run with your permissions. ↑↓ move · Enter ticks a plugin · installs for your user'] }),
        ],
      })
    }

    // ---- Detail view
    if (view === 'detail' && current) {
      const m = current
      const field = (label, value, color) =>
        Box({
          flexDirection: 'row',
          children: [
            Text({ dimColor: true, children: [pad(label, 12)] }),
            Text({ color, wrap: 'truncate-middle', children: [value || '—'] }),
          ],
        })
      const statusWord = {
        current: ['● up to date', 'green'],
        outdated: ['▲ update available', 'yellow'],
        checking: ['· checking…', undefined],
        unknown: ['? unknown', undefined],
        dev: ['◆ local folder', 'magenta'],
        gone: ['✕ removed from marketplace', 'red'],
      }[m.status] ?? ['?', undefined]
      return Box({
        flexDirection: 'column',
        children: [
          Button({ key: 'back', label: 'b ‹ Back to list', hotkey: 'b', plain: true, onPress: () => { view = 'list'; redraw() } }),
          Text({ children: [' '] }),
          Text({ bold: true, children: [m.name] }),
          ...(m.description ? [Text({ dimColor: true, wrap: 'wrap', children: [m.description] })] : []),
          Text({ children: [' '] }),
          field('Status', statusWord[0], statusWord[1]),
          ...(m.reason ? [field('', m.reason)] : []),
          field('Installed', m.version),
          field('Latest', m.latest || (m.latestSha ? m.latestSha.slice(0, 7) : ''), m.status === 'outdated' ? 'yellow' : undefined),
          field('Marketplace', m.marketplace),
          field('Scope', m.scope),
          field('Enabled', m.enabled ? 'yes' : 'no', m.enabled ? undefined : 'red'),
          field('Auto-update', m.isDev ? 'n/a' : m.auto ? 'on' : 'off', m.auto ? 'cyan' : undefined),
          field('Updated', m.lastUpdated ? m.lastUpdated.slice(0, 10) : ''),
          field('Folder', m.installPath),
          ...(m.homepage ? [Box({ flexDirection: 'row', children: [Text({ dimColor: true, children: [pad('Homepage', 12)] }), Link({ href: m.homepage, label: m.homepage })] })] : []),
          Text({ children: [' '] }),
          ...banners,
          rule,
          keyRows(modKeys),
          keyRows([
            key('h', 'Homepage', () => openMod($, m.uid, 'homepage'), !m.homepage),
            key('p', 'Copy folder path', () => { $.ui.copy(m.installPath); $.ui.toast('Copied ' + m.installPath) }, !m.installPath),
            key('r', 'Reload', () => reloadPlugins($)),
          ]),
        ],
      })
    }

    // ---- List view
    const nameWidth = Math.min(28, Math.max(10, ...visible.map((m) => m.name.length)))
    const row = (m) => {
      const isSel = m.uid === selected
      const glyph = !m.enabled
        ? ['○', undefined]
        : {
            current: ['●', 'green'],
            outdated: ['▲', 'yellow'],
            checking: ['·', undefined],
            unknown: ['?', undefined],
            dev: ['◆', 'magenta'],
            gone: ['✕', 'red'],
          }[m.status] ?? ['?', undefined]
      const version =
        m.status === 'outdated' && m.latest && m.latest !== m.version
          ? [Text({ dimColor: true, children: [m.version + ' '] }), Text({ color: 'yellow', bold: true, children: ['→ ' + m.latest] })]
          : m.status === 'outdated'
            ? [Text({ dimColor: true, children: [m.version + ' '] }), Text({ color: 'yellow', children: ['→ new commit'] })]
            : [Text({ dimColor: !m.enabled, children: [m.version || '—'] })]
      return Box({
        key: 'line-' + m.uid,
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ color: 'cyan', children: [isSel ? '▸' : ' '] }),
          Text({ color: glyph[1], dimColor: !glyph[1], children: [glyph[0]] }),
          Button({
            key: 'row:' + m.uid,
            label: pad(m.name, nameWidth),
            plain: true,
            dimColor: !m.enabled,
            onPress: () => {
              selected = m.uid
              view = 'detail'
              confirm = null
              redraw()
            },
          }),
          ...version,
          ...(m.auto ? [Text({ color: 'cyan', children: ['auto'] })] : []),
          ...(wide && m.scope !== 'user' && !m.isDev ? [Text({ dimColor: true, children: ['(' + m.scope + ')'] })] : []),
        ],
      })
    }

    const sectionTitles = {
      outdated: ['UPDATES AVAILABLE', 'yellow'],
      installed: ['INSTALLED', undefined],
      disabled: ['DISABLED', undefined],
      dev: ['LOCAL FOLDERS (--plugin-dir)', 'magenta'],
    }
    const listChildren = []
    for (const section of order) {
      const items = sorted.filter((m) => sectionOf(m) === section)
      if (!items.length) continue
      listChildren.push(
        Text({ key: 'h-' + section, bold: true, color: sectionTitles[section][1], dimColor: !sectionTitles[section][1], children: [sectionTitles[section][0] + ' (' + items.length + ')'] }),
      )
      for (const m of items) listChildren.push(row(m))
      listChildren.push(Text({ key: 'gap-' + section, children: [' '] }))
    }
    if (!listChildren.length) {
      listChildren.push(
        Text({
          dimColor: true,
          children: [mods.length ? 'No mods match "' + filter + '".' : scan.phase === 'idle' ? 'No mods installed.' : 'Loading…'],
        }),
      )
    }

    const filterBox = filterOpen
      ? [
          Input({
            key: 'filter',
            label: 'Filter',
            placeholder: 'name, marketplace or description',
            value: filter,
            autoFocus: true,
            submitLabel: 'done',
            onInput: (v) => { filter = v; redraw() },
            onSubmit: (v) => { filter = v; filterOpen = false; redraw() },
          }),
        ]
      : filter
        ? [Text({ dimColor: true, children: ['filter: "' + filter + '" · f to change'] })]
        : []

    const hint = current
      ? Text({ dimColor: true, wrap: 'truncate-end', children: ['↑↓ move · Enter details · keys act on ' + current.name] })
      : Text({ dimColor: true, children: ['↑↓ move · Enter details'] })

    return Box({
      flexDirection: 'column',
      children: [
        header,
        ...banners,
        ...filterBox,
        rule,
        ...listChildren,
        rule,
        ...(modKeys.length ? [keyRows(modKeys)] : []),
        keyRows(globalKeys),
        hint,
      ],
    })
  })
}
