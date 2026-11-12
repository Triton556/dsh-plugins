import { readFileSync, writeFileSync } from 'node:fs';
const target = 'C:/Users/Danil/Documents/deepseek-harness/default-workspace/dsh-computer-use/index.js';
let text = readFileSync(target, 'utf8');

// System prompt section: what the tools are for, when to offer them, when to ask.
const promptSection = `
// ------------------------------------------------------------------ system prompt
const CUA_PROMPT = [
  'Computer use: the computer_* tools drive the real desktop (windows, clicks, typing,',
  'browser tabs, screenshots, recordings, OCR, Chrome DevTools).',
  '',
  'When to use them: anything that is only reachable through a GUI - an app with no CLI,',
  'a browser page that needs a login, a native dialog, a canvas or video frame that must be',
  'read. Prefer shell/file tools whenever they can do the job.',
  '',
  'Be proactive: if the user asks for something and the only way is the GUI, say so briefly',
  'and offer to do it with computer use instead of silently refusing.',
  '',
  'Consent rules:',
  '- Driving ONE app or ONE browser tab (pass window or pid / a CDP target) needs no special',
  '  permission; just do it and report what you touched.',
  '- Driving the WHOLE SCREEN (click/type/scroll without window or pid) takes the mouse and',
  '  keyboard away from the user. Before the first such call, ask whether they are ready to',
  '  leave the machine alone, then pass user_ready: true. A banner "DeepSeek using your',
  '  computer" appears on screen meanwhile.',
  '- If the user presses ESC, the next call fails with STOPPED and the marker stays for 15',
  '  minutes: ask whether to continue, then retry with user_ready: true.',
  '- Never fight the user for the cursor: if they take over, stop and ask.',
].join('\\n');
`;

const marker = '// ------------------------------------------------------------------- catalogue';
text = text.replace(marker, promptSection + '\n' + marker);

// register the section when the host exposes the system prompt service
const applyAnchor = "  ctx.inject(['tools'], (toolCtx) => {";
if (!text.includes(applyAnchor)) { console.error('apply anchor missing'); process.exit(2); }
const sectionWiring = `  // Tell every new session what these tools are for, and when to ask first.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['systemPrompt'], (promptCtx) => {
        try {
          promptCtx.effect(() => {
            const prompt = typeof promptCtx.get === 'function' ? promptCtx.get('systemPrompt') : null;
            if (!prompt || typeof prompt.section !== 'function') return () => {};
            const dispose = prompt.section({ name: 'tool:computer-use', order: 120, text: CUA_PROMPT });
            return () => { try { if (typeof dispose === 'function') dispose(); } catch (error) {} };
          }, 'dsh-computer-use: system prompt');
        } catch (error) {
          console.warn('[dsh-computer-use] system prompt section failed:', String(error && error.message || error).slice(0, 160));
        }
        return () => {};
      });
    } catch (error) {}
  }

` + applyAnchor;
text = text.replace(applyAnchor, sectionWiring);

writeFileSync(target, text, 'utf8');
console.log('system prompt section wired');