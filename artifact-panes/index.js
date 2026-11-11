// dsh-artifact-panes вЂ” Host half.
//
// Routes:
//  - GET  /artifact-panes/library вЂ” the workspace `artifacts/` folder listing;
//  - POST /artifact-panes/answer  вЂ” a questionnaire's final answers;
//  - POST /artifact-panes/draft   вЂ” autosaved draft (one file per questionnaire);
//  - GET  /artifact-panes/state   вЂ” the last saved answers, so a reload restores them.
//
// The tab type, dropdown and renderer live in ./client.js.
import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { relative } from 'node:path'

const bootLog = 'C:/Users/Danil/Documents/deepseek-harness/default-workspace/tools/codex-worker/evidence/tools-v1/host-load.log'
const dividerDiagLog = 'C:/Users/Danil/Documents/deepseek-harness/default-workspace/tools/codex-worker/evidence/tools-v1/divider-diag.log'
const dividerAuthFile = process.env.TEMP + '/dsh-gui-auth.json'
function boot(event, data = {}) {
  const record = { time: new Date().toISOString(), pid: process.pid, event, module: import.meta.url, ...data }
  try { appendFileSync(bootLog, JSON.stringify(record) + '\n') }
  catch (error) { console.error('[artifact-panes:host-load]', event, 'log-write-failed', error?.code || 'UNKNOWN') }
}
boot('module-import')

// The existing HTTP routes require webServer; tools are awaited in a child.
// attachments is optional and is obtained through ctx.get, not ctx.attachments.
export const inject = ['webServer']

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

  // The library root is the workspace the user actually works in: the cwd of
  // the most recently created live session. sandboxPolicy.workspaceRoot is
  // only the last fallback вЂ” it is not always the visible workspace.
  async function resolveLibraryRoot(ctx, fs) {
    try {
      const sessions = ctx.get('sessions')
      const live = sessions && typeof sessions.list === 'function' ? sessions.list() : undefined
      const candidates = []
      for (const session of live || []) {
        const cwd = session && session.header && typeof session.header.cwd === 'string' && session.header.cwd
        const at = session && session.header && typeof session.header.createdAt === 'number' ? session.header.createdAt : 0
        if (cwd) candidates.push({ cwd, at })
      }
      candidates.sort((a, b) => b.at - a.at)
      for (const { cwd } of candidates) {
        try {
          const info = await fs.stat(await fs.resolve(cwd))
          if (info && info.type === 'directory') return cwd
        } catch (e) { /* stale candidate вЂ” try the next one */ }
      }
    } catch (e) {}
    try {
      const policy = ctx.get('sandboxPolicy')
      if (policy && typeof policy.workspaceRoot === 'string') return policy.workspaceRoot
    } catch (e) {}
    return undefined
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact-panes/library',
    handler: async (req, res) => {
      const send = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(payload))
      }
      const fs = ctx.get('fs')
      if (!fs || typeof fs.listDir !== 'function') { send({ ok: false, artifacts: [], error: 'filesystem unavailable' }); return }
      const root = await resolveLibraryRoot(ctx, fs)
      if (!root) { send({ ok: false, artifacts: [], error: 'workspace not resolved' }); return }
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
          if (entry.type === 'directory') { await walk(dirPath + '/' + entry.name, depth + 1); continue }
          if (!wanted.test(entry.name)) continue
          const filePath = dirPath + '/' + entry.name
          let title = ''
          if (/\.(?:html?|xhtml)$/i.test(entry.name)) {
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
        await walk(abs(root, 'artifacts'), 0)
        artifacts.sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || a.path.localeCompare(b.path))
        send({ ok: true, root: root + '/artifacts', artifacts, errors })
      } catch (e) {
        send({ ok: false, artifacts: [], root, error: e && e.message ? String(e.message) : 'library scan failed', errors })
      }
    },
  }), 'artifact-panes: library route')

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
  // Temporary: capture the GUI launch URL/cookie so an external Chromium can be
  // authenticated against the same host (profiling the GUI over CDP). The file
  // is deleted by the caller and never logged.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/artifact-panes/gui-auth',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 16 * 1024) { sendJson(res, 413, { ok: false, error: 'payload is too large' }); return }
        chunks.push(chunk)
      }
      try { writeFileSync(dividerAuthFile, Buffer.concat(chunks).toString('utf8'), { mode: 0o600 }) } catch (e) {}
      sendJson(res, 200, { ok: true })
    },
  }), 'artifact-panes: gui auth probe')
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
      try { appendFileSync(dividerDiagLog, Buffer.concat(chunks).toString('utf8').trim() + '\n') } catch (e) {}
      sendJson(res, 200, { ok: true })
    },
  }), 'artifact-panes: divider diag')

}
