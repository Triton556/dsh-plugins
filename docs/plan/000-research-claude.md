# Research: как устроен Claude Desktop (evidence-based)

Дата: 2026-11-10. Источники: локальный `app.asar` Claude Desktop 4.23118.1 (Electron 44.9.3),
открытые DevTools приложения, документация Anthropic/OpenAI, замеры собственного GUI.
Все утверждения ниже помечены: **[код]** — прочитано в asar, **[наблюдение]** — видно в UI,
**[замер]** — измерено нами, **[вопрос]** — не подтверждено.

## 1. Архитектура окна: ключ к производительности

**[код]** Главное окно — `BrowserWindow` (shell-хром), а веб-приложение claude.ai живёт в
отдельном **`WebContentsView`**:

```js
// .vite/build/index.chunk-B4M-ub9T.js
function ITe(e,{ownFocusRule:t,webPreferences:n}){
  H = new u.WebContentsView({ webPreferences:{...n, sandbox:true, contextIsolation:true, nodeIntegration:false} });
  let r = H.webContents;
  Vi(r, Bi.CLAUDE_AI_WEB, {...});
```

**[код]** Панель сессии/артефакты — тоже нативные view:

```js
// .vite/build/index.chunk-BNRz4JSu.js
_.contentView.addChildView(l), l.setBounds({x:0,y:0,width:n,height:r})
// .vite/build/index.chunk-B4M-ub9T.js
function o7n(e){ let t=PF(e); t!==void 0 && !e.isDestroyed() && e.setBounds(t.target) }
```

**Следствие:** при перетаскивании панели shell-HTML не переобтекает вообще — меняются только
`bounds` нативных view. Именно поэтому у них «гладко на любом чате».

Для DSH это недоступно: наш GUI — чистая веб-страница в одном WebContents (наш плагин
`artifact-panes` — клиентская часть внутри этой же страницы, артефакт — `<iframe>`).

## 2. Ресайз панели: точная реализация

**[код]** `resources/frame/shell/frame-shell-chrome.js`:

```js
var DCe = 720, OCe = .75;
function vK(){ return Math.max(340, Math.min(DCe, Math.floor((window.innerWidth - av()) * OCe))) }
function yK(e){ return Number.isFinite(e) ? Math.min(Math.max(Math.round(e), 340), vK()) : 340 }
function bK(el, px){ el?.style.setProperty("--session-panel-w", `${px}px`) }   // одна запись
function xK(clientX, rtl){ return rtl ? clientX : window.innerWidth - clientX }

onPointerDown: setPointerCapture(pointerId); o.current = width; l.current = clientX;
              s.current = xK(clientX, rtl) - width;
              document.body.style.cursor = "col-resize"; userSelect = "none"
onPointerMove: if (|clientX - l.current| > PCe/*3px*/) dirty = true;
              o.current = yK(xK(clientX, rtl) - s.current);
              bK(panelRef.current, o.current);        // <- на каждый move, без анимации
onPointerUp:   dirty ? onCommit(o.current) : restore(width)   // React-состояние только тут
onDoubleClick: reset 340
onKeyDown:     ArrowLeft/Right ±8, Shift ±32, Home 340, End max, Enter toggle
```

Выводы:
1. **Никакой анимации ширины.** Ширина = функция позиции курсора, один `setProperty` за move.
2. **Одна CSS-переменная**, а не три layout-свойства (у нас сейчас `grid-template-columns` + `width` + `left`).
3. **React не ре-рендерится во время драга** — состояние и `localStorage` пишутся на `pointerup`.
4. Клэмпы: `340 … min(720, 75% × (innerWidth − sidebar))`; dirty-порог 3 px; сброс двойным кликом.
5. Курсор и `user-select` живут на `body`, снимаются в `SK()`.

**[замер]** Наш текущий дивидер: WAAPI-анимация 380 мс по трём layout-свойствам,
`render` 200–400 мс на кадр, 4–10 кадров за драг. Тот же драг с выключенным эффектом —
27–107 мс gaps. Эффект (250 искр) после перевода на canvas перестал быть фактором.

## 3. Чат-флоу

**[код]** Веб-чата в asar нет: он грузится с `claude.ai` внутрь `WebContentsView`
(`Vi(r, Bi.CLAUDE_AI_WEB)`), поэтому его внутренности в пакете отсутствуют.
**[наблюдение]** Контентная колонка чата имеет ограниченную ширину и центрируется —
при изменении ширины панели текст не переобтекает построчно.
**[вопрос]** Виртуализация списка сообщений и стратегия стриминга — в бандлах claude.ai,
локально недоступны. Способы закрыть: (а) DevTools на самом `WebContentsView`
(он открывается отдельным окном и цепляется к web-приложению), (б) запуск с `--remote-debugging-port`
и CDP-трейс, (в) публичные чанки `claude.ai/_next/static/...` (нужны URL из HTML).

**Что это значит для нас:** наш чат — резиновая колонка `1fr`, поэтому каждый кадр драга
переобтекает весь транскрипт. Это и есть остаточная причина джанка.

## 4. Артефакты

**[код]** Артефакты/панели — нативные view с `setBounds`; в веб-слое остаются только
заголовки вкладок и рамка.
**[код]** Для встроенных браузерных сценариев используются отдельные `WebContentsView`
с `sandbox:true, contextIsolation:true, nodeIntegration:false`, свои сессии/`partition`,
`webviewTag:false`, `backgroundThrottling:false`.

**[наблюдение]** У нас артефакт — `<iframe>` в правой панели; это уже отдельный
композитор/процесс, поэтому его контент не обязан переобтекать при ресайзе контейнера —
но наша текущая реализация всё равно ресайзит фрейм покадрово.

## 5. Что из этого переносимо в DSH

| Приём Claude | Переносимо? | Комментарий |
|---|---|---|
| Нативные view для панели/чата | нет | наш GUI — одна веб-страница; `<iframe>` артефакта — ближайший аналог |
| Прямая запись ширины, без анимации | **да** | одна CSS-переменная на `pointermove` |
| React-коммит только на `pointerup` | **да** | у нас уже так |
| Клэмпы 340…720/75%, dblclick, стрелки | **да** | копируем как поведение |
| Ограниченная ширина контентной колонки | **да** | убирает переобтекание текста при драге |
| `sandbox`-iframe с отдельной сессией | частично | у нас уже iframe; можно усилить изоляцию |

## 6. Открытые вопросы (и как закрыть)

1. **Виртуализация чата в claude.ai** — DevTools на webview-окне + скриншот/копирование
   (у нас теперь есть CUA и vision). Ожидаемый ответ: используется ли windowed list и как
   обрабатывается стриминг.
2. **Точная ширина контентной колонки** (px/rem) и поведение на узких окнах.
3. **Стриминг**: как обновляется последнее сообщение без ре-рендера всей ветки.
4. **Артефакты**: как решается перезапуск медиа при ресайзе (у нас mp4-плеер).

Каждый пункт закрывается 10–15 минутами работы через CUA (см. бриф S0).