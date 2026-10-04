# Forgejo Connector (розширення VS Code)

Інтеграція Forgejo/Gitea з вбудованим Git у VS Code, за зразком GitHub. Спілкування з користувачем — українською.

## Структура

- `extension.js` — весь код (чистий JavaScript, CommonJS, без збірки й залежностей).
- `package.json` — маніфест: команди `forgejo.signIn|signOut|clone|createRepository|publish`, `viewsWelcome` для `scm`
  (кнопка «Publish to Forgejo» у порожній панелі Source Control, умови `when` як у GitHub), налаштування
  `forgejo.url`, `forgejo.cloneProtocol` (`ssh`|`https`|`ask`, за замовчуванням `ssh`), `forgejo.defaultPrivate`.
- `release.py` + `.forgejo/workflows/release.yml` — реліз за тегом `v<версія>` (мітка раннера `forgejo-vscode-ci`):
  тести → `.vsix` → реліз Forgejo; опис — повідомлення анотованого тега. Checkout і сертифікати — як у xBot.
- `deploy/runner/` — стек раннера `forgejo-vscode-ci` (організація xDevOps, без Docker хоста в завданнях);
  розгортання й реєстрація — `docs/release.md`. Образ завдань — спільний `ci-docker` з xInfra (python3 + nodejs).
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
- Самооновлення: `checkForUpdates` — `GET /repos/{forgejo.updates.repository}/releases/latest`, `.vsix` з
  `browser_download_url` (web-маршрут → Basic логін:токен, не `Authorization: token`) → файл у `os.tmpdir()` →
  `workbench.extensions.installExtension` з `Uri.file` (**лише file:** — `globalStorageUri` у VS Code 1.140 має схему
  `vscode-userdata:`, і встановлення падає з «No Servers»; на цьому спіткнулась 0.3.0),
  потім пропозиція `reloadWindow`. Авто — через 15 с і кожні 6 год, тихо (`getClient(false)`); «Пропустити» → globalState.
- Створення: `POST /user/repos` або `/orgs/{org}/repos` (`name`, `description`, `private`, `auto_init`, `readme`).

## Стан (2026-10-04)

- Встановлено 0.3.2 (вручну). Сервер користувача: `https://git.ac.lan` (SSH: `ssh://git@git.ac.lan:2222/...`), логін `v.sytnyk`.
- Перевірено вручну на реальному сервері: вхід; Publish to Forgejo через SSH (сам цей проєкт опубліковано в
  організацію `xDevOps/forgejo-vscode`, з повтором після збою — ensureGitIdentity + «Використати наявний порожній»).
- Перевірено також: список репозиторіїв у Git: Clone; клон через HTTPS (xAuto/xBot) — сертифікат git приймає, пароль не питався.
  На Mac у git `credential.helper osxkeychain` — git може зберегти наш токен у Keychain (після «Вийти» він там лишається).
- Ще не перевірено: «Forgejo: Створити репозиторій», Publish Branch для наявного репозиторію, push через HTTPS, Windows.
- 0.3.0: перший реліз через CI пройшов (2026-10-04: тег → завдання 55, Checkout/Test/Release ✅, `.vsix` у релізі;
  `forgejo.token` вистачає для створення релізу). 0.3.0→0.3.1 через UI не встановилось («No Servers», див. вище; помилку ще й ховав автоматичний режим) — виправлено
  в 0.3.2 (встановлено вручну); перевірка самооновлення 0.3.2→0.3.3 (реліз без змін коду).
- Раннер `forgejo-vscode-ci` розгорнуто й зареєстровано (2026-10-04, `engine.ac.lan-forgejo-vscode`, runner v13.2.0);
  образ ci-docker перезібрано з python3/nodejs (xInfra `aeba682`). Серверні кроки виконує користувач — агенту запис
  на сервер (`ssh engine` зі змінами) і читання `.env` заборонені правилами дозволів; оболонка сервера — zsh.
- Сам проєкт тепер у git (`origin` → xDevOps/forgejo-vscode, гілка `main`); `.gitignore`: `/.vscode`, `*.vsix`.
- Користувач працює і на Mac, і на Windows — розширення має працювати на обох.
- Публікація в Marketplace не планувалась (`publisher: "local"`).

## Після змін

1. `sh test/run.sh`
2. Підняти `version` у `package.json`, закомітити.
3. Випуск: `git tag -a v<версія> -m "що нового"` → `git push --follow-tags` → CI створює реліз, у користувачів
   розширення саме запропонує оновитися. Локальна збірка для перевірки — `python3 build_vsix.py`.
4. Для налагодження без встановлення: відкрити папку й натиснути F5 (Extension Development Host).
