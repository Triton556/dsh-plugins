# Plugin reliability QA

**Scope:** Artifact Panes, Computer Use, and Browser Bridge, from main
`af03c74dc60df3ab4c830c7522a7ab04493dddb2`. Isolated Linux profile only;
no account login, model calls, changes to the owner's PC, registry, or Chrome
profile. This is not a Windows desktop acceptance result.

## Comparisons and design decisions

- [Codex Computer Use](https://learn.chatgpt.com/docs/computer-use#windows-foreground-use)
  documents real Windows foreground interaction. This branch verifies the target
  just before input and opts out of silently sending it to another app.
- [Claude Cowork](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)
  documents preferring connector/browser interactions before the screen and
  its background mode on macOS. These are UX references, not full public
  Desktop implementations. DSH's semantic UIA and Browser Bridge remain
  distinct from global mouse/keyboard. This branch does not claim general
  background desktop control on Windows.
- The overlay is a short, thin target marker rather than a 72-DIP glow around
  all screens; full-screen use has its own notice. Geometry is emitted from
  the input dispatch path and is converted from screen to WPF coordinates.
- Do not replay browser input or artifact changes when their effect is unknown.
  Reassign delivered artifact work only if the old renderer never accepted it.

## Verified in the isolated lab

- Official npm @deepseek-ai/dsh `0.2.3-alpha.2`, Node `24.22.3`;
  all three repository bundles installed into the same throwaway Web profile
  using `dsh plugin --profile web add`. Composed config contains all three;
  real host registered 19 computer tools. Local authenticated HTTP returned
  200 and the Firefox screenshot showed the actual DSH workbench.
- Artifact Panes: 8 suites, including a regression red before/green after
  for renderer loss without a goodbye and a clean-clone CSP fixture.
- Browser Bridge: 6 tests cover npm contents, explicit empty form values,
  malformed requests, split replies, stale request IDs, early EOF, invalidated
  AX snapshots and no replay after ambiguous dispatch. Chrome API/native
  pipe substitutes are mocks, not actual Chrome extension acceptance.
- Computer Use: 19 definitions accepted by the real DSH tools package;
  overlay lifecycle/consent tested via fake engine; both PowerShell scripts
  parsed in 7.5.4, focus/point guards used fake native symbols and the
  x64 INPUT declaration compiled to 40 bytes. None of these drives a real
  Windows desktop.

## Repeat portable checks

```sh
node --test artifact-panes/test/*.test.mjs dsh-browser-bridge/test/*.test.mjs
node dsh-computer-use/tools/contract.mjs
node dsh-computer-use/tools/text-encoding.mjs
test_tmp="$(mktemp -d)"
TMPDIR="$test_tmp" DSH_CUA_TEST_TEMP="$test_tmp" node dsh-computer-use/tools/overlay-contract.mjs
pwsh -NoProfile -File dsh-computer-use/tools/input-contract.ps1
DSH_REAL_TOOLS=/path/to/@deepseek-ai/dsh-tools/lib/index.js node dsh-computer-use/tools/real-schema.mjs
```

## Follow-up: cancellation

Escape now signals the active action instead of terminating its worker. Click,
drag, and the hit fallback release a pressed button on cancellation before
returning. Those workers also enforce their own deadline rather than being killed
by Node while the button is down. The portable PowerShell contract simulates
Escape and a deadline after mouse-down and checks that mouse-up happens exactly
once. If a native call stalls, cancellation cannot take effect until it returns.

In one DSH host, read-only tools do not change the active input indicator or
consume its Escape notice. A second desktop mutation gets BUSY until the first
one finishes. The portable test overlaps a window list with a drag and checks
stale geometry callbacks. Separate host processes are not coordinated by this
guard; the shared overlay on a real Windows desktop still needs an overlap test.

The indicator receives geometry before dispatch, but WPF renders asynchronously.
Check frame-to-click timing on the Windows fixture rather than assuming the halo
is already visible when a click lands.

## Windows acceptance (not run)

Use a disposable, unlocked Windows desktop, separate from any work or credentials.
Record DSH version, commit, DPI, display topology and screenshots before/after.

1. Two disposable Notepad windows: type a unique Cyrillic string into only A;
   leave B foreground or use an overlapping test window. Confirm either
   success in A or a safe refusal, never typing into B. Test click, double-click,
   scroll and drag. Verify a denied click leaves both fixture states unchanged.
2. Move a fixture across monitors at 100% and 150%, including negative screen
   coordinates. Check halo follows visible bounds; its cursor coincides with
   the actual click. Check minimized/restore, Alt-Tab, Esc during a long call,
   successful linger and no halo on screenshots/listing. Check physical
   mouse-button release after interrupting a drag.
3. Chrome/Edge in a clean profile where the owner has installed the native host
   and extension: wait, snapshot, fill/clear, click, navigate, verify a stale
   index is rejected. Check detach after an input never repeats it.
4. In DSH Desktop, render a disposable HTML artifact, run annotation and
   switch chats while work is pending, validate deferred commands are picked
   up and a command that might have started isn't applied twice.
5. Repeat against the same harmless fixture in Codex/Claude if available.
   Compare correct-target rate, time from request to visible indication and
   time to clear; do not infer parity from static styling or Linux results.
