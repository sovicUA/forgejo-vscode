# Forgejo Connector (розширення VS Code)

Інтеграція Forgejo/Gitea з вбудованим Git у VS Code, за зразком GitHub. Спілкування з користувачем — українською.

## Структура

- `extension.js` — весь код (чистий JavaScript, CommonJS, без збірки й залежностей).
- `package.json` — маніфест: команди `forgejo.signIn|signOut|clone|createRepository|publish`, `viewsWelcome` для `scm`
  (кнопка «Publish to Forgejo» у порожній панелі Source Control, умови `when` як у GitHub), налаштування
  `forgejo.url`, `forgejo.cloneProtocol` (`ssh`|`https`|`ask`, за замовчуванням `ssh`), `forgejo.defaultPrivate`.
- `build_vsix.py` — пакує `forgejo-connector-<версія>.vsix` без Node/vsce: `python3 build_vsix.py`.
- `test/` — тести API-клієнта проти фейкового HTTP-сервера Forgejo, мок модуля `vscode`: `sh test/run.sh`
  (якщо `node` немає, використовується Node, вбудований у VS Code через `ELECTRON_RUN_AS_NODE=1`).

На Mac користувача Node.js не встановлено — не додавати npm-залежностей, TypeScript чи кроків збірки без узгодження.

## Як влаштовано

- Реєструється через API вбудованого розширення Git (`vscode.git`, `getAPI(1)`):
  - `registerRemoteSourceProvider` з `getRemoteSources` (пункт «Clone from Forgejo» у Git: Clone, `supportsQuery`)
    та `publishRepository` (пункт «Publish to Forgejo» у Publish Branch для репозиторію без remote);
  - `registerCredentialsProvider` — для HTTPS віддає git логін + токен, якщо хост збігається з `forgejo.url`.
- Помилки з `getRemoteSources` git-base показує як пункт «Error: …» у списку; тому там без діалогів
  (`getClient(false)`), а вхід — командою «Forgejo: Увійти».
- Потрібні права токена — константа `TOKEN_SCOPES_HELP` (діалог входу) і таблиця в README: repository/user/organization —
  читання й запис (POST /user/repos вимагає write:user), доступ «Усі» репозиторії.
- Токен — `context.secrets`, ключ `forgejo.token:<baseUrl>`; перевіряється через `GET /api/v1/user`, 401 → токен видаляється.
- HTTP — через модулі `http`/`https` (а не `fetch`), щоб діяли системні сертифікати, які VS Code підмішує
  (`http.systemCertificates`). Користувач має внутрішній кореневий сертифікат.
- Список репозиторіїв: `/user/repos` + `/user/orgs` → `/orgs/{org}/repos`, без дублів, сортування за `updated_at`,
  кеш 2 хв; пагінація до порожньої сторінки (сервер може мати меншу межу за `limit=50`). Пошук: `/repos/search?q=`.
- Публікація — `publishFolder` (і кнопка/команда `forgejo.publish`, і `publishRepository` з Publish Branch): діалоги →
  якщо комітів немає: вибір файлів у .gitignore + `ensureGitIdentity` (user.name/email; інакше коміт падає
  «Author identity unknown», пропонує значення з профілю Forgejo → `git config --global`) — усе ДО створення на сервері →
  `createOrReuseRepository` (409 + порожній наявний репозиторій → запропонувати використати) → `git.init`
  (гілка з `git.defaultBranchName`) → `commit('Initial commit', {all: true})` → `connectAndPush`.
- Помилки git: `GitError.message` загальний («Failed to execute git») — `errorMessage()` додає рядки fatal/error зі `stderr`.
- Створення: `POST /user/repos` або `/orgs/{org}/repos` (`name`, `description`, `private`, `auto_init`, `readme`).

## Стан (2026-10-04)

- Версія 0.1.0 встановлена користувачем. Сервер користувача: `https://git.ac.lan`, логін `v.sytnyk`; вхід з 0.2.1 працює.
  Перша спроба Publish to Forgejo (папка самого проєкту) впала на коміті: у git на Mac не задані user.name/email.
  Виправлено в 0.2.2 (ще не перевірено).
- Автотести проходять. **Проти реального сервера Forgejo користувача ще не перевірялось** (адреса й токен невідомі),
  діалоги в UI вручну не прогонялись. Наступний крок — разом з користувачем пройти: вхід → Git: Clone → створення
  репозиторію → Publish Branch, через SSH і HTTPS; виправити те, що виявиться.
- Користувач працює і на Mac, і на Windows — розширення має працювати на обох.
- Публікація в Marketplace не планувалась (`publisher: "local"`).

## Після змін

1. `sh test/run.sh`
2. Підняти `version` у `package.json`, `python3 build_vsix.py`
3. Перевстановити: Extensions → `…` → Install from VSIX, потім Developer: Reload Window.
   Для налагодження без перевстановлення: відкрити папку й натиснути F5 (Extension Development Host).
