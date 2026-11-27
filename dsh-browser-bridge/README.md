# DSH Browser Bridge

Drive an **already running** Chrome/Edge from a DSH session without a debug port,
without restarting the browser and without moving the user's cursor.

Design and decisions: [`../dsh-computer-use/BROWSER-BRIDGE.md`](../dsh-computer-use/BROWSER-BRIDGE.md).

## How it works

```
DSH tool / bridge.mjs
      в”‚ named pipe \\.\pipe\dsh-browser-bridge
      в–ј
native host (host\NativeHost.exe, stdio JSON-RPC framing)
      в”‚ native messaging
      в–ј
extension (extension\, MV3)
      в”‚ chrome.debugger attached to ONE tab
      в–ј
the tab
```

- The extension attaches `chrome.debugger` **inside the running browser**, so no
  `--remote-debugging-port` and no restart: session cookies and open tabs survive.
- While attached, Chrome shows its own "started debugging this browser" infobar.
  The extension detaches after 20 seconds of idle so the bar disappears.
- The host is spawned by the browser itself from an HKCU native-messaging
  registration; no TCP port is opened.
- Internal pages (`chrome://`, `chrome-extension://`, `about:`) are refused.

## Install (once, done by the user)

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
powershell -ExecutionPolicy Bypass -File install-host.ps1
```

Then load the extension once in the browser: `chrome://extensions` в†’ enable
**Developer mode** в†’ **Load unpacked** в†’ `extension\` of this project.

Verify:

```powershell
powershell -ExecutionPolicy Bypass -File check.ps1
node bridge.mjs '{"cmd":"ping"}'
```

Updating the extension later: the **Reload** button on its card in
`chrome://extensions` (no reinstall needed).

## Connection and observation commands

| Command | Args | Result |
| --- | --- | --- |
| `ping` | вЂ“ | host name, attached tabs, claimed tabs |
| `tabs.list` | вЂ“ | id, windowId, title, url, active, pinned, status, claimed |
| `tabs.claim` | `tabId` or `tabMatch`, optional `expectTitle`, `expectUrl` | refuses when the tab changed since the mention |
| `tabs.release` | `tabId` | drops the claim and detaches |
| `ax.snapshot` | `tabId`/`tabMatch`, `limit`, `bounds` | accessibility nodes: index, role, name, value, backendNodeId, optional bounds |
| `page.shot` | `tabId`/`tabMatch`, `format`, `out` | base64 PNG/JPEG, or a file when `out` is given |
| `page.wait` | `selector` or `text`, `timeoutMs` | waits for the page to reach the state |

Examples:

```powershell
node bridge.mjs '{"cmd":"tabs.list"}'
node bridge.mjs '{"cmd":"ax.snapshot","args":{"tabMatch":"yourvm","limit":80,"bounds":true}}'
node bridge.mjs '{"cmd":"page.shot","args":{"tabMatch":"yourvm","out":"C:/temp/tab.png"}}'
```

## Safety rules

- Claims mark a selected tab; they are not an exclusive lock across clients.
  When claiming, pass the expected title or URL to reject a stale selection.
- A title or URL substring must match exactly one tab. If it matches more than
  one, list tabs and use an exact `tabId`.
- No `eval`, no cookies, no history, no passwords вЂ” these are not commands at all.
- The agent never installs or repairs the host; it runs `check.ps1` and asks the
  user to reinstall.

## Files

| File | Role |
| --- | --- |
| `extension/` | MV3 service worker and manifest (stable id from `key`) |
| `host/NativeHost.cs` | native messaging host: stdio framing + named pipe |
| `host/com.dsh.browser.json` | manifest written by `install-host.ps1` |
| `bridge.mjs` | local client used by the tools and by hand |
| `build.ps1`, `install-host.ps1`, `check.ps1` | build, register, diagnose |
| `genkey.cjs` | one-time extension key/id generator |

## Input and navigation commands

| Command | Args | Result |
| --- | --- | --- |
| `ax.click` | `index` from `ax.snapshot` | trusted click at the element centre |
| `ax.setValue` | `index`, `value` | sets a form field through the native setter, fires input/change |
| `input.type` | `text` | inserts text into the focused element |
| `input.key` | `keys` (`ENTER`, `CTRL+A`, ...) | activates the tab first, then dispatches key events |
| `page.navigate` | `url` | navigates and waits for `document.readyState === "complete"` |

If Chrome detaches after an input or navigation might already have run, the
bridge reports an uncertain outcome. It does not replay the action. Verify the
page state and refresh the accessibility snapshot before deciding what to do.

**After changing extension code, press Reload on the extension card.** Stopping
the service worker does not re-read the unpacked files (verified: killing the
native host and waiting 45 s still served the old build).

### M1 verification status (2026-11-23)

| Command | Status |
| --- | --- |
| `tabs.new`, `tabs.list`, `tabs.claim` | verified |
| `ax.snapshot` | verified (roles, names, values, bounds) |
| `ax.click` | verified (submitted a real form through a real click) |
| `ax.setValue` | verified (value set and read back) |
| `page.navigate` | verified (navigated and waited for readyState) |
| `input.type`, `input.key` | verified with a visible window: text appended, Enter submitted the form. A hidden window does not keep focus, so the same calls fail there |

Reload helper: `reload-extension.ps1` (UI Automation, no mouse). It needs the
`chrome://extensions` tab to be the active one.

