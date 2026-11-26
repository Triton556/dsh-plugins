// dsh-artifact-panes вЂ” Host half.
//
// Routes:
//  - GET  /artifact-panes/library вЂ” the workspace `artifacts/` folder listing;
//  - POST /artifact-panes/answer  вЂ” a questionnaire's final answers;
//  - POST /artifact-panes/draft   вЂ” autosaved draft (one file per questionnaire);
//  - GET  /artifact-panes/state   вЂ” the last saved answers, so a reload restores them.
//
// The tab type, dropdown and renderer live in ./client.js.
import { mkdir, writeFile, readFile, readdir, unlink, stat, realpath } from 'node:fs/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { relative, resolve, join, isAbsolute } from 'node:path'
import { artifactsScope, logicalArtifact, within } from './tools/artifacts-root.js'

// Diagnostic sinks belong to the profile, not to a source checkout: another
// machine has no C:/Users/Danil path, and a missing log directory must never make
// the plugin fail. With DSH_HOME unset the plugin simply logs nowhere.
const dshHomePath = (() => {
  const value = process.env.DSH_HOME
  return typeof value === 'string' && value ? value.replace(/[\\/]+$/, '') : ''
})()
const logDir = dshHomePath ? dshHomePath + '/.dsh/artifact-panes' : ''
const bootLog = logDir ? logDir + '/host-load.log' : ''
const dividerDiagLog = logDir ? logDir + '/divider-diag.log' : ''
if (logDir) {
  try { mkdirSync(logDir, { recursive: true }) } catch (error) { console.error('[artifact-panes:host-load] log-dir-failed', error?.code || 'UNKNOWN') }
}

function boot(event, data = {}) {
  if (!bootLog) return
  const record = { time: new Date().toISOString(), pid: process.pid, event, module: import.meta.url, ...data }
  try { appendFileSync(bootLog, JSON.stringify(record) + '\n') }
  catch (error) { console.error('[artifact-panes:host-load]', event, 'log-write-failed', error?.code || 'UNKNOWN') }
}
boot('module-import')

// The existing HTTP routes require webServer; tools are awaited in a child.
// attachments is optional and is obtained through ctx.get, not ctx.attachments.
export const inject = ['webServer']

// What `/artifact-panes/file` may serve: an HTML artifact of one known
// workspace, capped so one page cannot pin megabytes of base64 in the answer.
const ARTIFACT_BYTES_LIMIT = 5 * 1024 * 1024
const ARTIFACT_EXT = /\.(?:html?|xhtml)$/i
// A list row only needs the `<title>`; a 100+ MB page must not be decoded on
// every scan just to label it (the page itself is still capped below).
const TITLE_BYTES_LIMIT = 1024 * 1024

// One spelling for comparing workspace paths: forward slashes, no trailing
// separator, case-folded (Windows paths are case-insensitive).
const wsKey = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const versionOf = (info) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`

// A `node:fs` face shaped like the sandboxed `fs` service, so the library walk
// runs unchanged over a workspace the sandbox refuses (a closed one).
const nodeIo = {
  async resolve(path) {
    const info = await stat(path)
    if (!info.isDirectory()) throw new Error('not a directory: ' + path)
    return { targetKey: wsKey(path), path }
  },
  async listDir(target) {
    const entries = await readdir(target.path, { withFileTypes: true })
    const out = []
    for (const entry of entries) {
      const full = join(target.path, entry.name)
      let info
      try {
        info = await stat(full, { bigint: true })
      } catch (e) {
        // A drained entry or an unreadable name: still list it, like the
        // service does, so the list never hides a race.
        out.push({ name: entry.name, type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file', target: { targetKey: wsKey(full), path: full }, version: '0:0:0:0:0', size: 0 })
        continue
      }
      out.push({
        name: entry.name,
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
        target: { targetKey: wsKey(full), path: full },
        version: versionOf(info),
        size: Number(info.size),
      })
    }
    return out
  },
  async readText(target) {
    return readFile(target.path, 'utf8')
  },
  processPath(target) {
    return target.path
  },
}

export function apply(ctx) {
  const has = (name) => { try { return !!ctx.get(name) } catch { return false } }
  boot('apply', { webServer: has('webServer'), tools: has('tools'), attachments: has('attachments') })
  const webServer = ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    boot('webServer-unavailable')
    return
  }
  boot('tools-waiting')
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(async () => {
      boot('bootstrap-import-start')
      try {
        const { activateHostTools } = await import('./tools/host-load.mjs')
        return await activateHostTools(toolCtx, { webServer, log: boot })
      } catch (error) {
        boot('tools-bootstrap-failed', { code: error?.code || 'BOOTSTRAP_FAILED', message: String(error?.message || 'Bootstrap failed').slice(0, 400) })
        throw error
      }
    }, 'artifact-panes: tools-v1 host')
  })

  const titleCache = new Map()
  const abs = (root, rel) => String(root).replace(/[\\/]+$/, '') + '/' + rel

  // Every cwd the persisted session index remembers. A session that is not
  // live still names a workspace; this is what makes it readable. Without
  // DSH_HOME there is no index to read: closed workspaces are simply not offered.
  async function closedWorkspaceRecords() {
    const records = []
    const home = process.env.DSH_HOME
    if (typeof home !== 'string' || !home) return records
    try {
      const dir = home.replace(/[\\/]+$/, '') + '/storages/session_projcache/sessions'
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.json')) continue
        let record
        try {
          record = JSON.parse(await readFile(dir + '/' + name, 'utf8'))
        } catch (e) { continue }
        const cwd = record && record.record && record.record.identity && record.record.identity.cwd
        if (typeof cwd !== 'string' || !cwd) continue
        records.push({ indexId: name.replace(/\.json$/, ''), cwd })
      }
    } catch (e) { /* no index available: live sessions only */ }
    return records
  }

  // The workspaces this plugin may read: cwds of live sessions first, then the
  // ones only the closed index remembers. Keyed by the normalized path, which
  // is exactly the check `/library?root=` and `/file` apply.
  async function knownWorkspaces() {
    const byKey = new Map()
    try {
      const sessions = ctx.get('sessions')
      const list = sessions && typeof sessions.list === 'function' ? sessions.list() : []
      for (const session of list || []) {
        const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : ''
        if (!cwd) continue
        const key = wsKey(cwd)
        if (byKey.has(key)) continue
        byKey.set(key, { cwd, live: true, sessionId: session.id })
      }
    } catch (e) { /* no session service: closed workspaces only */ }
    for (const record of await closedWorkspaceRecords()) {
      const key = wsKey(record.cwd)
      if (byKey.has(key)) continue
      byKey.set(key, { cwd: record.cwd, live: false, sessionId: null, indexId: record.indexId })
    }
    return byKey
  }

  // The workspace a `root` parameter names, or undefined when it is not one of
  // the workspaces above. Registration is by normalized path, so trailing
  // separators and case do not decide access.
  async function knownWorkspace(root) {
    if (typeof root !== 'string' || !root || root.length > 4096 || !isAbsolute(root)) return undefined
    const known = await knownWorkspaces()
    return known.get(wsKey(root))
  }

  // The library root is the workspace the user actually works in: the cwd of
  // the most recently created live session. sandboxPolicy.workspaceRoot is
  // only the last fallback вЂ” it is not always the visible workspace.
  async function resolveLibraryRoot(ctx, fs, preferredSessionId) {
    try {
      const sessions = ctx.get('sessions')
      const live = sessions && typeof sessions.list === 'function' ? sessions.list() : undefined
      const candidates = []
      let preferred
      for (const session of live || []) {
        const cwd = session && session.header && typeof session.header.cwd === 'string' && session.header.cwd
        const at = session && session.header && typeof session.header.createdAt === 'number' ? session.header.createdAt : 0
        if (cwd) candidates.push({ cwd, at })
        if (preferredSessionId && session && session.id === preferredSessionId && cwd) preferred = cwd
      }
      const usable = async (cwd) => {
        try {
          const info = await fs.stat(await fs.resolve(cwd))
          return !!(info && info.type === 'directory')
        } catch (e) { return false }
      }
      // An explicitly requested session wins: the picker must list exactly the
      // workspace the user chose, not the newest one.
      if (preferred && await usable(preferred)) return preferred
      candidates.sort((a, b) => b.at - a.at)
      for (const { cwd } of candidates) {
        if (await usable(cwd)) return cwd
      }
    } catch (e) {}
    try {
      const policy = ctx.get('sandboxPolicy')
      if (policy && typeof policy.workspaceRoot === 'string') return policy.workspaceRoot
    } catch (e) {}
    return undefined
  }

  // Workspaces the picker can switch to: the cwds of live sessions, plus the
  // cwds the closed-session index remembers when they have an artifacts folder
  // (the /file route reads those by path, so no session id is needed).
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact-panes/workspaces',
    handler: async (req, res) => {
      const send = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(payload))
      }
      const norm = (cwd) => String(cwd || '').replace(/[\\/]+$/, '').replace(/\\/g, '/')
      const labelOf = (cwd) => norm(cwd).split('/').filter(Boolean).pop() || norm(cwd)
      const hasArtifactsDir = async (cwd) => {
        // Only a validated scope counts: a local folder shadowed by a broken
        // declaration, or a regular file named `artifacts`, cannot be served.
        try { await artifactsScope(cwd); return true } catch (e) { return false }
      }
      const known = await knownWorkspaces()
      const workspaces = []
      // Live sessions first: they can be read through workspaceFiles.
      for (const entry of known.values()) {
        if (!entry.live) continue
        workspaces.push({
          sessionId: entry.sessionId,
          cwd: entry.cwd,
          label: labelOf(entry.cwd),
          hasArtifacts: await hasArtifactsDir(entry.cwd),
          live: true,
        })
      }
      // Closed sessions: the persisted index keeps every session with its cwd,
      // so their workspaces are offered before the user reopens them. Only those
      // that actually have artifacts/ are worth a row in the picker.
      for (const entry of known.values()) {
        if (entry.live) continue
        if (!await hasArtifactsDir(entry.cwd)) continue
        workspaces.push({
          sessionId: null,
          indexId: entry.indexId,
          cwd: entry.cwd,
          label: labelOf(entry.cwd),
          hasArtifacts: true,
          live: false,
        })
      }
      workspaces.sort((a, b) => a.label.localeCompare(b.label))
      send({ ok: true, workspaces })
    },
  }), 'artifact-panes: workspaces route')

  // The cwd behind one live session id. A session tab needs it to read through
  // the host resolver: the declared artifacts root exists only on the host, and
  // `<cwd>/artifacts` in the renderer is not that folder. Metadata only - no
  // file bytes and no new permission: `/file?root=` applies the same rule.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact-panes/session-root',
    handler: async (req, res) => {
      const send = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(payload))
      }
      if (req.method !== 'GET') { send(405, { ok: false, error: 'GET only' }); return }
      const query = (() => {
        try { return new URL(String(req.url || '/'), 'http://127.0.0.1').searchParams } catch (e) { return new URLSearchParams() }
      })()
      const sessionId = String(query.get('sessionId') || '').trim()
      if (!sessionId || sessionId.length > 256) { send(400, { ok: false, error: 'sessionId is required' }); return }
      try {
        const sessions = ctx.get('sessions')
        const list = sessions && typeof sessions.list === 'function' ? sessions.list() : []
        const hit = (list || []).find((session) => session && session.id === sessionId)
        const cwd = hit && hit.header && typeof hit.header.cwd === 'string' ? hit.header.cwd : ''
        if (!cwd || !await knownWorkspace(cwd)) { send(404, { ok: false, error: 'session not found' }); return }
        send(200, { ok: true, cwd })
      } catch (e) {
        send(500, { ok: false, error: 'session root unavailable' })
      }
    },
  }), 'artifact-panes: session root route')

  // Agent-facing UI channel: the client polls `.dsh/artifact-panes/ui-command.json`
  // and posts the outcome here. This lets an agent inspect and click the panel
  // through the real DOM instead of guessing from screenshots.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact-panes/ui-result',
    handler: async (req, res) => {
      const send = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(payload))
      }
      if (req.method !== 'POST') { send(405, { ok: false, error: 'POST only' }); return }
      const chunks = []
      for await (const chunk of req) {
        chunks.push(chunk)
        if (Buffer.concat(chunks).length > 1_000_000) { send(413, { ok: false, error: 'payload too large' }); return }
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (e) { send(400, { ok: false, error: 'invalid json' }); return }
      const id = body && typeof body.id === 'string' ? body.id : ''
      if (!/^[a-z0-9-]{4,60}$/i.test(id)) { send(400, { ok: false, error: 'invalid id' }); return }
      const fs = ctx.get('fs')
      const root = await resolveLibraryRoot(ctx, fs, typeof body.sessionId === 'string' ? body.sessionId : '')
      if (!root) { send(500, { ok: false, error: 'workspace not resolved' }); return }
      // Plain node:fs on purpose: the sandboxed fs service refuses writes to
      // dot-directories, exactly like the survey answers route avoids it.
      const dir = abs(root, '.dsh/artifact-panes')
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(dir + '/ui-result.json', JSON.stringify(body), 'utf8')
        send(200, { ok: true })
      } catch (e) {
        send(500, { ok: false, error: e && e.message ? String(e.message) : 'write failed' })
      }
    },
  }), 'artifact-panes: ui result route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact-panes/library',
    handler: async (req, res) => {
      const send = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(payload))
      }
      const fsService = ctx.get('fs')
      const query = (() => {
        try { return new URL(String(req.url || '/'), 'http://127.0.0.1').searchParams } catch (e) { return new URLSearchParams() }
      })()
      const sessionId = query.get('sessionId') || ''
      const includeOutside = query.get('outside') === '1'
      // `root` names a workspace by path: a closed session's workspace has no
      // session id to list through, so the picker passes the cwd it was given.
      // The same known-workspace rule authorizes it as `/artifact-panes/file`.
      // Without the parameter the live-session behaviour is unchanged.
      const requestedRoot = query.get('root') || ''
      let root
      let io = fsService
      if (requestedRoot) {
        const entry = await knownWorkspace(requestedRoot)
        if (!entry) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({ ok: false, artifacts: [], error: 'root not allowed' }))
          return
        }
        root = entry.cwd
        io = nodeIo
      } else {
        root = await resolveLibraryRoot(ctx, fsService, sessionId)
      }
      if (!root) { send({ ok: false, artifacts: [], error: 'workspace not resolved' }); return }
      if (!io || typeof io.listDir !== 'function') { send({ ok: false, artifacts: [], error: 'filesystem unavailable' }); return }
      // The physical folder that logical `artifacts/` stands for: the root the
      // workspace declared, or `<root>/artifacts` under the historical rule.
      // A broken declaration is reported, never silently replaced; a workspace
      // without any artifacts folder still lists the HTML outside it.
      let scope = null
      try {
        scope = await artifactsScope(root)
      } catch (error) {
        const code = error && error.code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          const text = code === 'PATH_OUT_OF_SCOPE'
            ? (/not a directory/i.test(String(error.message || '')) ? 'artifacts root is not a directory' : 'artifacts root escapes workspace')
            : code === 'ARTIFACTS_ROOT_INVALID' ? 'artifacts root declaration is invalid'
            : 'artifacts root is unavailable'
          send({ ok: false, artifacts: [], error: text })
          return
        }
      }
      const artifactsDir = scope ? (scope.declared ? scope.base : abs(root, 'artifacts')) : null
      let workspaceReal = root
      try { workspaceReal = await realpath(root) } catch (e) {}
      // The walk below is written against the `fs` face; the adapter is the
      // sandboxed service for a live session and plain node:fs for a root.
      const fs = io
      const wanted = /\.(?:html?|xhtml|md|markdown|svg|pdf)$/i
      const artifacts = []
      const errors = []
      // FsVersion embeds `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`; the
      // epoch millisecond lives in part 4. Absent or unparsable в†’ 0.
      const versionMtime = (version) => {
        try {
          const ns = Number(String(version || '').split(':')[3])
          return Number.isFinite(ns) && ns > 0 ? Math.round(ns / 1e6) : 0
        } catch (e) { return 0 }
      }
      // fs.listDir takes a RESOLVED target (fs.resolve result), not a path
      // string; entries carry {name, type, target, version, size?}.
      const walk = async (dirPath, depth) => {
        if (depth > 3 || artifacts.length >= 150) return
        let target
        try { target = await fs.resolve(dirPath) } catch (e) {
          if (errors.length < 4) errors.push(String(e && e.message ? e.message : e) + ' @ ' + dirPath)
          return
        }
        let entries
        try { entries = await fs.listDir(target) } catch (e) {
          if (errors.length < 4) errors.push(String(e && e.message ? e.message : e) + ' @ ' + dirPath)
          return
        }
        for (const entry of entries) {
          if (artifacts.length >= 150) return
          if (!entry || !entry.name || entry.name.startsWith('.')) continue
          if (entry.type === 'symlink') continue
          if (entry.type === 'directory') { await walk(dirPath + '/' + entry.name, depth + 1); continue }
          if (!wanted.test(entry.name)) continue
          const filePath = dirPath + '/' + entry.name
          // Only a canonical path inside the physical folder may be listed or
          // have its <title> read; a link that leaves it is skipped.
          let canonical
          try { canonical = await realpath(typeof fs.processPath === 'function' ? fs.processPath(entry.target) : filePath) } catch (e) { continue }
          if (!within(scope.base, canonical)) continue
          let title = ''
          if (/\.(?:html?|xhtml)$/i.test(entry.name) && (!entry.size || entry.size <= TITLE_BYTES_LIMIT)) {
            const cacheKey = entry.target && entry.target.targetKey ? entry.target.targetKey : filePath
            const cached = titleCache.get(cacheKey)
            if (cached && cached.version === entry.version) {
              title = cached.title
            } else {
              try {
                const text = await fs.readText(entry.target)
                const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(text || '').slice(0, 200000))
                if (m) title = m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
                titleCache.set(cacheKey, { version: entry.version, title })
              } catch (e) {}
            }
          }
          artifacts.push({
            path: typeof fs.processPath === 'function' ? fs.processPath(entry.target) : filePath,
            title,
            size: entry.size || 0,
            mtime: versionMtime(entry.version),
          })
        }
      }
      try {
        if (artifactsDir) await walk(artifactsDir, 0)
        if (includeOutside) {
          // Recent HTML outside artifacts/: the user opted in for this. Strictly
          // bounded - 30 days, 50 files, depth 3, no build/agent folders.
          const cutoff = Date.now() - 30 * 24 * 3600 * 1000
          const skipDirs = new Set(['node_modules', '.git', '.dsh', 'dist', 'build', '.next', 'out', 'coverage'])
          const seen = new Set(artifacts.map((item) => item.path))
          const extra = []
          const titleOf = async (entry, filePath) => {
            if (entry.size && entry.size > TITLE_BYTES_LIMIT) return ''
            try {
              const text = await fs.readText(entry.target)
              const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(text || '').slice(0, 200000))
              return m ? m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) : ''
            } catch (e) { return '' }
          }
          const walkOutside = async (dirPath, depth) => {
            if (depth > 3 || extra.length >= 50) return
            let target
            try { target = await fs.resolve(dirPath) } catch (e) { return }
            let entries
            try { entries = await fs.listDir(target) } catch (e) { return }
            for (const entry of entries) {
              if (extra.length >= 50) return
              if (!entry || !entry.name) continue
              if (entry.type === 'symlink') continue
              if (entry.type === 'directory') {
                if (entry.name.startsWith('.') || skipDirs.has(entry.name) || entry.name === 'artifacts') continue
                await walkOutside(dirPath + '/' + entry.name, depth + 1)
                continue
              }
              if (!/\.(?:html?|xhtml)$/i.test(entry.name)) continue
              const mtime = versionMtime(entry.version)
              if (mtime && mtime < cutoff) continue
              const filePath = dirPath + '/' + entry.name
              const outPath = typeof fs.processPath === 'function' ? fs.processPath(entry.target) : filePath
              if (seen.has(outPath)) continue
              let canonical
              try { canonical = await realpath(outPath) } catch (e) { continue }
              if (!within(workspaceReal, canonical)) continue
              seen.add(outPath)
              extra.push({ path: outPath, title: await titleOf(entry, filePath), size: entry.size || 0, mtime, outside: true })
            }
          }
          await walkOutside(root, 0)
          artifacts.push(...extra)
        }
        artifacts.sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || a.path.localeCompare(b.path))
        // One address for every entry: an artifact keeps its logical
        // `artifacts/...` form even when its physical base is external, because
        // tab identity and de-duplication are built from it.
        const wsBase = String(root).replace(/\\/g, '/').replace(/\/+$/, '')
        for (const item of artifacts) {
          const normalized = String(item.path).replace(/\\/g, '/')
          const logical = scope ? logicalArtifact(scope, item.path) : undefined
          item.rel = logical || (normalized.toLowerCase().startsWith(wsBase.toLowerCase() + '/')
            ? normalized.slice(wsBase.length + 1)
            : normalized)
        }
        send({ ok: true, root: artifactsDir || abs(root, 'artifacts'), outside: includeOutside, artifacts, errors })
      } catch (e) {
        send({ ok: false, artifacts: [], root, error: e && e.message ? String(e.message) : 'library scan failed', errors })
      }
    },
  }), 'artifact-panes: library route')

  // Read one HTML artifact of a known workspace by path. This is what a closed
  // workspace needs: no live session id exists to read through
  // `workspaceFiles`, so the pane asks here, and the answer is authorized by the
  // same rule as `/library?root=` plus a realpath containment check.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact-panes/file',
    handler: async (req, res) => {
      const send = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(payload))
      }
      if (req.method !== 'GET') { send(405, { ok: false, error: 'GET only' }); return }
      const query = (() => {
        try { return new URL(String(req.url || '/'), 'http://127.0.0.1').searchParams } catch (e) { return new URLSearchParams() }
      })()
      const rawRoot = String(query.get('root') || '').trim()
      const relPath = String(query.get('path') || '').replace(/\\/g, '/').trim()
      if (!rawRoot || !relPath) { send(400, { ok: false, error: 'root and path are required' }); return }
      if (rawRoot.length > 4096 || relPath.length > 4096) { send(400, { ok: false, error: 'path is too long' }); return }
      if (!isAbsolute(rawRoot)) { send(400, { ok: false, error: 'root must be absolute' }); return }
      // The path is a workspace-relative address, never an absolute one and
      // never a traversal: `..` would name a file the workspace list did not
      // offer, and that is a malformed request, not a permission question.
      const segments = relPath.split('/')
      if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)
        || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        send(400, { ok: false, error: 'path must be relative to the workspace' })
        return
      }
      // Only one kind of file is ever served through this route.
      if (!ARTIFACT_EXT.test(relPath)) { send(400, { ok: false, error: 'not html' }); return }
      const entry = await knownWorkspace(rawRoot)
      if (!entry) { send(403, { ok: false, error: 'root not allowed' }); return }
      // Logical `artifacts/...` names the physical folder its workspace declared
      // (or its own `artifacts/`, confined exactly as before). Any other
      // workspace HTML reads inside the workspace root and needs no artifacts
      // folder at all: an ordinary workspace may have none.
      const underArtifacts = relPath.startsWith('artifacts/')
      let scope = null
      let rootReal
      if (underArtifacts) {
        try {
          scope = await artifactsScope(entry.cwd)
        } catch (e) {
          if (e && e.code === 'CALLER_UNAVAILABLE') { send(404, { ok: false, error: 'workspace not found' }); return }
          if (e && e.code === 'ARTIFACTS_ROOT_INVALID') { send(500, { ok: false, error: 'artifacts root declaration is invalid' }); return }
          if (e && e.code === 'PATH_OUT_OF_SCOPE') { send(403, { ok: false, error: 'outside workspace' }); return }
          send(404, { ok: false, error: 'not found' }); return
        }
        rootReal = scope.root
      } else {
        try { rootReal = await realpath(entry.cwd) } catch (e) { send(404, { ok: false, error: 'workspace not found' }); return }
      }
      const base = underArtifacts ? scope.base : rootReal
      const candidate = underArtifacts ? join(scope.base, ...relPath.split('/').slice(1)) : resolve(rootReal, relPath)
      let fileReal
      try {
        fileReal = await realpath(candidate)
      } catch (e) {
        send(404, { ok: false, error: 'not found' })
        return
      }
      // Containment on the real path: a symlink or junction that points
      // anywhere else resolves to its target and is refused.
      if (!within(base, fileReal)) {
        send(403, { ok: false, error: 'outside workspace' })
        return
      }
      let info
      try {
        info = await stat(fileReal)
      } catch (e) {
        send(404, { ok: false, error: 'not found' })
        return
      }
      if (!info.isFile()) { send(404, { ok: false, error: 'not a file' }); return }
      if (info.size > ARTIFACT_BYTES_LIMIT) {
        send(413, { ok: false, error: 'file too large', size: info.size, limit: ARTIFACT_BYTES_LIMIT })
        return
      }
      try {
        const buffer = await readFile(fileReal)
        send(200, {
          ok: true,
          root: rootReal,
          path: relPath,
          mime: 'text/html; charset=utf-8',
          size: buffer.length,
          dataBase64: buffer.toString('base64'),
        })
      } catch (e) {
        send(500, { ok: false, error: e && e.message ? String(e.message) : 'read failed' })
      }
    },
  }), 'artifact-panes: file route')

  // Questionnaire answers. The sandboxed iframe cannot write files, so the
  // client forwards its postMessage payloads here:
  //  - every choice autosaves a draft (one stable file per questionnaire), so
  //    a reload or a DSH restart does not lose the progress;
  //  - "РћС‚РїСЂР°РІРёС‚СЊ РѕС‚РІРµС‚С‹" writes the final answer next to the drafts;
  //  - GET /state returns the freshest of the two, so the page can restore.
  const sendJson = (res, code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  // Read and parse a JSON body; on failure the response is already sent and
  // undefined comes back.
  async function readJsonBody(req, res) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 256 * 1024) { sendJson(res, 413, { ok: false, error: 'payload is too large' }); return undefined }
      chunks.push(chunk)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid json' })
      return undefined
    }
  }

  // One filesystem-safe id per questionnaire: it names the draft file and is
  // the suffix of the final answer file.
  const safeId = (value, fallback) => {
    const cleaned = String(value || '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 80)
    return cleaned || fallback
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact-panes/answer',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const payload = await readJsonBody(req, res)
      if (payload === undefined) return
      if (!payload || typeof payload !== 'object') { sendJson(res, 400, { ok: false, error: 'invalid payload' }); return }
      const fs = ctx.get('fs')
      const root = await resolveLibraryRoot(ctx, fs)
      if (!root) { sendJson(res, 500, { ok: false, error: 'workspace not resolved' }); return }
      const requestId = safeId(payload.requestId, 'answer')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const dir = abs(root, '.dsh/artifact-panes/answers')
      const file = dir + '/' + stamp + '-' + requestId + '.json'
      const body = JSON.stringify({
        requestId: payload.requestId === undefined ? null : payload.requestId,
        sessionId: payload.sessionId === undefined ? null : payload.sessionId,
        receivedAt: new Date().toISOString(),
        answers: payload.answers === undefined ? null : payload.answers,
      }, null, 2)
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(file, body, 'utf8')
        sendJson(res, 200, { ok: true, kind: 'final', path: file, requestId })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e && e.message ? String(e.message) : 'write failed' })
      }
    },
  }), 'artifact-panes: answer route')

  // Autosaved draft: one file per questionnaire, overwritten on every change,
  // so the file is always the user's current progress.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact-panes/draft',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const payload = await readJsonBody(req, res)
      if (payload === undefined) return
      if (!payload || typeof payload !== 'object') { sendJson(res, 400, { ok: false, error: 'invalid payload' }); return }
      const fs = ctx.get('fs')
      const root = await resolveLibraryRoot(ctx, fs)
      if (!root) { sendJson(res, 500, { ok: false, error: 'workspace not resolved' }); return }
      const requestId = safeId(payload.requestId, 'draft')
      const dir = abs(root, '.dsh/artifact-panes/drafts')
      const file = dir + '/' + requestId + '.json'
      const body = JSON.stringify({
        requestId,
        sessionId: payload.sessionId === undefined ? null : payload.sessionId,
        savedAt: new Date().toISOString(),
        answers: payload.answers === undefined ? null : payload.answers,
      }, null, 2)
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(file, body, 'utf8')
        sendJson(res, 200, { ok: true, kind: 'draft', path: file, requestId })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e && e.message ? String(e.message) : 'write failed' })
      }
    },
  }), 'artifact-panes: draft route')

  // The freshest saved answers for one questionnaire, so a reloaded page can
  // restore the selection instead of starting from scratch.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact-panes/state',
    handler: async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      let url
      try { url = new URL(String(req.url || '/'), 'http://artifact-panes.local') } catch (e) { url = new URL('http://artifact-panes.local/') }
      const requestId = safeId(url.searchParams.get('requestId'), '')
      if (!requestId) { sendJson(res, 400, { ok: false, error: 'requestId is required' }); return }
      const fs = ctx.get('fs')
      const root = await resolveLibraryRoot(ctx, fs)
      if (!root) { sendJson(res, 500, { ok: false, error: 'workspace not resolved' }); return }
      const dir = abs(root, '.dsh/artifact-panes')
      const candidates = []
      try {
        const files = await readdir(dir + '/answers')
        for (const name of files) {
          if (!name.endsWith('-' + requestId + '.json')) continue
          try {
            const raw = JSON.parse(await readFile(dir + '/answers/' + name, 'utf8'))
            candidates.push({ kind: 'final', savedAt: String(raw.receivedAt || ''), answers: raw.answers })
          } catch (e) { /* skip an unreadable file */ }
        }
      } catch (e) { /* no final answers yet */ }
      try {
        const raw = JSON.parse(await readFile(dir + '/drafts/' + requestId + '.json', 'utf8'))
        candidates.push({ kind: 'draft', savedAt: String(raw.savedAt || ''), answers: raw.answers })
      } catch (e) { /* no draft yet */ }
      candidates.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      const best = candidates[0]
      if (!best) { sendJson(res, 200, { ok: false, requestId, error: 'nothing saved yet' }); return }
      sendJson(res, 200, { ok: true, requestId, kind: best.kind, savedAt: best.savedAt, answers: best.answers })
    },
  }), 'artifact-panes: state route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact-panes/screenshot',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const payload = await readJsonBody(req, res)
      if (!payload || typeof payload !== 'object') return
      const fs = ctx.get('fs')
      const root = await resolveLibraryRoot(ctx, fs)
      if (!root) { sendJson(res, 500, { ok: false, error: 'workspace not resolved' }); return }
      const rect = payload.rect && typeof payload.rect === 'object' ? payload.rect : {}
      const x = Math.max(0, Math.round(Number(rect.x) || 0))
      const y = Math.max(0, Math.round(Number(rect.y) || 0))
      const w = Math.max(1, Math.round(Number(rect.w) || 0))
      const h = Math.max(1, Math.round(Number(rect.h) || 0))
      const pad = Math.min(48, Math.max(0, Math.round(Number(payload.padding) || 12)))
      const dir = abs(root, '.dsh/artifact-panes/shots')
      const preview = payload.preview === true
      try {
        await mkdir(dir, { recursive: true })
        if (preview) {
          try {
            for (const name of await readdir(dir)) {
              if (name.startsWith('preview-') && name.endsWith('.png')) {
                try { await unlink(dir + '/' + name) } catch (e) { /* already gone */ }
              }
            }
          } catch (e) { /* first preview */ }
        }
        const file = dir + '/' + (preview ? 'preview-' : '') + new Date().toISOString().replace(/[:.]/g, '-') + '.png'
        if (process.platform === 'win32') {
          const script = fileURLToPath(new URL('./shot.ps1', import.meta.url))
          const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
            '-Out', file, '-X', String(x), '-Y', String(y), '-W', String(w), '-H', String(h), '-Pad', String(pad)]
          await new Promise((resolve, reject) => {
            execFile('powershell.exe', args, { windowsHide: true, timeout: 15000 }, (error) => (error ? reject(error) : resolve()))
          })
        } else {
          throw new Error('screenshot is supported on Windows only in this build')
        }
        sendJson(res, 200, { ok: true, path: relative(root, file).replace(/\\/g, '/'), file })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? String(error.message) : 'screenshot failed' })
      }
    },
  }), 'artifact-panes: screenshot route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact-panes/shot',
    handler: async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const fs = ctx.get('fs')
      const root = await resolveLibraryRoot(ctx, fs)
      if (!root) { sendJson(res, 500, { ok: false, error: 'workspace not resolved' }); return }
      let requested = ''
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        requested = String(url.searchParams.get('path') || '').replace(/\\/g, '/')
      } catch (e) {}
      if (!requested.startsWith('.dsh/artifact-panes/shots/')) { sendJson(res, 400, { ok: false, error: 'invalid path' }); return }
      try {
        const buffer = await readFile(abs(root, requested))
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': buffer.length })
        res.end(buffer)
      } catch (error) {
        sendJson(res, 404, { ok: false, error: 'not found' })
      }
    },
  }), 'artifact-panes: shot route')

  // Temporary divider profiling sink (removed after the performance pass).
  // Counter route lets the orchestrator trigger the in-page drag self-test.
  let dividerSelfTestRequest = 0
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact-panes/divider-selftest',
    handler: async (req, res) => {
      if (req.method === 'POST') dividerSelfTestRequest += 1
      else if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      sendJson(res, 200, { ok: true, n: dividerSelfTestRequest })
    },
  }), 'artifact-panes: divider selftest trigger')
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact-panes/divider-diag',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 64 * 1024) { sendJson(res, 413, { ok: false, error: 'payload is too large' }); return }
        chunks.push(chunk)
      }
      if (dividerDiagLog) {
        try { appendFileSync(dividerDiagLog, Buffer.concat(chunks).toString('utf8').trim() + '\n') } catch (e) {}
      }
      sendJson(res, 200, { ok: true })
    },
  }), 'artifact-panes: divider diag')

}
