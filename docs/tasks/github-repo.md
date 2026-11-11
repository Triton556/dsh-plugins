# Задача: Git-репозиторий для нашей сборки DSH

Записано 2026-11-11 по просьбе Данила: «создадим репозиторий под dsh нашу сборку и
обновлять будем туда всё».

## Что уже известно

- `git` есть: `C:\Program Files\Git\cmd\git.exe`, `user.name = Danil`, `user.email = volodin.software@gmail.com`.
- `gh` есть и **авторизован**: аккаунт **Triton556**, токен со scope `repo` — значит создание
  репозитория и push можно делать напрямую (`gh repo create … --push`).
- Workspace: `C:\Users\Danil\Documents\deepseek-harness\default-workspace`, под git **не находится**.

## Что предлагается хранить в репозитории

| путь | что это | включать |
|---|---|---|
| `dsh-computer-use/` | наш плагин CUA (20 тулов, движок, CDP, тесты) | да |
| `artifact-panes/` | плагин с дивидером (наш клиент/хост) | да |
| `docs/` | планы, отчёты, health-отчёты | да (`docs/health/*.md` — по желанию) |
| `tools/` | скрипты (asar.mjs, health, cua) | частично: без `tools/codex-worker/evidence` и без больших фикстур |
| `artifacts/` | html-артефакты (plan.html) | да, они маленькие |
| `.dsh/` | состояние сессий/вложений | **нет** |
| `dsh-ui-chat-virtual/`, `mac-transfer/`, `trips/`, `*-backup-*` | посторонние/большие каталоги (120 МБ, 55 МБ, бэкапы) | нет |

Обязательный `.gitignore`: `node_modules/`, `.dsh/`, `*.png`/`*.mp4`/`*.gif` в тестовых
папках (или выборочно), `tools/codex-worker/evidence/`, `profile-backup-*`, `plugin-backup-*`,
`mac-transfer/`, `trips/`, `dsh-ui-chat-virtual/`.

## Открытые вопросы (спросить перед созданием)

1. Имя репозитория: `dsh-build` (по умолчанию) / `dsh-desktop-build` / другое.
2. Видимость: **private** (по умолчанию) или public.
3. Нужно ли тащить `docs/health/crash-*.md` (там железо и коды блюскринов) — по умолчанию нет.
4. Секреты: ничего из `.dsh/`, никаких токенов/ключей; перед первым push прогнать поиск
   по `sk-`, `ghp_`, `Bearer`, `token=`.

## План выполнения (после команды «продолжай»)

1. `git init` в workspace, `.gitignore` по списку выше.
2. Проверить `git status` — что попадает, что нет; при необходимости уточнить `.gitignore`.
3. `gh repo create Triton556/<name> --private --source . --remote origin --push`.
4. Убедиться, что push прошёл, и дать ссылку.
5. Дальше — коммиты после каждой значимой правки плагинов (`dsh-computer-use`, `artifact-panes`),
   с осмысленными сообщениями; обновление репозитория — по ходу работы.
## Статус: ВЫПОЛНЕНО 2026-11-11

Репозиторий создан и запушен: **https://github.com/Triton556/dsh-plugins** (public).

- имя: `dsh-plugins`, ветка `main`, 1 коммит `6c50ff8`;
- внутри: `dsh-computer-use/`, `artifact-panes/`, `artifacts/`, `docs/`, `tools/{cua/asar.mjs,health}`, `README.md` (англ., описание плагинов), `.gitignore`, `.gitattributes`;
- 82 файла, 1.13 МБ; секретов не найдено (поиск по `sk-`, `ghp_`, `Bearer`, `token=`);
- исключено: `.dsh/`, `node_modules/`, бэкапы `*.bak*`, `tools/dsh-readmes`, `tools/codex-worker`, дампы, крупные архивы.

Дальше: коммитить сюда каждую значимую правку плагинов.