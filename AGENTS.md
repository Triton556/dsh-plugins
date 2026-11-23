# Agent instructions

Working rules for any agent that edits this repository, plus the setup steps for
each package. The rules section is deliberately concrete: research first, design
second, code third, and report every step.

## Repository layout

| Path | What it is |
| --- | --- |
| `artifact-panes/` | DSH sidebar plugin that renders workspace HTML artifacts. File rewrites are applied immediately; there is no "Apply" step. |
| `dsh-computer-use/` | Desktop control tools for DSH: windows, occlusion-proof screenshots, mouse/keyboard, UI Automation, OCR, frame recording. |
| `dsh-browser-bridge/` | Browser automation over an MV3 extension plus a native messaging host: accessibility snapshots and trusted input in an already running browser, with no debug port. |
| `docs/`, `artifacts/`, `tools/` | Reference docs, sample artifacts, helper scripts. |

## Report everything, ask whenever the answer changes the work

- Every step is reported, including a read-only one: what you did, what you found,
  what comes next. Reporting is never optional.
- Understanding questions are the normal way to remove uncertainty. If two readings
  of the request would lead to different results, ask instead of picking one
  silently. Ask at the decision point, with the option you recommend and the reason.
  Never ask what a file, a doc or a command answers, and never ask for the same
  permission twice.
- Permission questions are only about acting on the user's things: irreversible
  changes, other people's data, publishing, payments, accounts, servers,
  credentials, system settings, installs. Reversible work inside the repository
  needs a report, not permission.
- A gate is per task, not per step: once approved, work through the task and report
  at every meaningful checkpoint.

## Feature work: research, design, approval, then code

Use for a new feature, an integration, a migration, or a change spanning several
modules. A bug fix or a one-file change: do it, then report.

1. Restate the goal, the known constraints and what is unknown.
2. Research the real sources: the code, its README and tests, vendor docs, and the
   local installation (configs, bundles, logs, registry). Cite web sources by URL.
   Read files instead of guessing. Separate verified facts from assumptions.
3. Write the design: goal, the options with their trade-offs, the chosen option and
   why, interface or protocol, failure modes, test plan. Save it next to the project.
4. Show the design and ask for approval. No implementation before it.
5. Build in slices: the smallest verifiable piece first, then show the evidence,
   then continue.
6. Report what was verified, what was not, the limitations and the next step.

If the user tells you to skip a step, skip it explicitly and say what risk it adds.

## Questions

- One round per decision point, as many questions as it needs, each with the
  recommended option and why. This applies to understanding and permission questions.
- `ask()` only when nothing else can proceed. Otherwise ask the timed form, keep
  working on independent parts; the question stays answerable in the session.
- In an unattended run, no blocking questions: write them to `QUESTIONS.md`,
  continue, and report them in the morning.

## Autonomous runs (overnight, "work without me")

- Before the user leaves, write the authorized scope in one short block: goal,
  allowed actions, forbidden actions, definition of done. That block is the
  approval for every step inside it.
- Report as you go: `PROGRESS.md` (done / running / blocked), `DECISIONS.md`
  (choice and reason), `QUESTIONS.md` (everything you would have asked).
- Take the safest reversible option when a choice is missing, record it, continue.
- Never unattended: deleting or overwriting user data, publishing, paying, changing
  accounts, servers, credentials or system settings, installing software.
- Stop only when the scope is done or an external dependency blocks every remaining
  step; report the blocker instead of idling.

## Reporting

- Lead with the result, then the evidence: what was verified and how, what was not,
  and what remains. Never report an unrun check as passed; a build is not a UI check.
- Small work: three to six lines. Large work: headings for result, verification,
  limitations, next steps.
- Restate each decision in one line with its reason, so a later session finds it
  without replaying the conversation.

## Visual artifacts

Make one when a picture compresses the explanation: architecture, protocol or
message flow, a plan with gates, an option comparison, or a UI change the user has
to judge.

- Keep artifacts in per-project subfolders: `artifacts/<project>/<topic>.html`.
- If a decision needs a choice or several marks, put the options inside the
  artifact (radios, checkboxes, a comment field, a send button) instead of asking
  the same thing in prose. Do not move ordinary questions into artifacts.
- UI work: before/after screenshots and what to look at. Protocols: a table of
  messages (name, direction, payload, errors).
- Skip it for a one-line fix or anything a short table in the chat explains.

## Setup and verification per package

| Package | Build and verify |
| --- | --- |
| `artifact-panes` | `node --test test/` (six suites: client, host, csp, picker, survey, annotations) |
| `dsh-computer-use` | PowerShell engine `tools/cua.ps1`; `node --check index.js`. There is no CDP tool: browser automation lives in `dsh-browser-bridge`. |
| `dsh-browser-bridge` | `powershell -ExecutionPolicy Bypass -File build.ps1`, then `install-host.ps1`, then load `extension/` unpacked at `chrome://extensions`; verify with `check.ps1` and `node bridge.mjs '{"cmd":"ping"}'` |

`dsh-browser-bridge` details:

- The extension id is pinned by the `key` field in `extension/manifest.json`; do not
  regenerate it casually, `allowed_origins` in the host manifest depends on it.
- After changing extension code, the extension must be reloaded from its card in
  `chrome://extensions` (a full browser restart also works). Restarting only the
  service worker does not re-read the files from disk.
- `reload-extension.ps1` reloads it through UI Automation; it needs the
  `chrome://extensions` tab to be the active one.

## Hard rules for this repository

- **Never start Chrome or Edge with `--remote-debugging-port`** and never open an
  external DevTools port to a browser the user is working in. That needs a browser
  restart, which drops session cookies and open tabs. Drive an already running
  browser only through `dsh-browser-bridge` (extension + native messaging,
  `chrome.debugger` attached inside the extension at tab scope).
- Installing or repairing the browser extension and its native host is the user's
  action. An agent may run diagnostics and ask the user to reinstall; it must not
  edit the Chrome profile, `Secure Preferences`, extension state or the registry on
  its own initiative.
- No secrets in the repository: no passwords, private keys, tokens, cookies,
  `.env` files or machine-specific credential dumps. Keep them out of commits and
  out of the chat.
- Commit messages: `<package>: <what changed and why>`.
