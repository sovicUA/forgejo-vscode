# Релізи й раннер CI

Реліз розширення робить Forgejo Actions (`.forgejo/workflows/release.yml`) за push тега `v<версія>`: тести →
`forgejo-connector-<версія>.vsix` → реліз Forgejo (`release.py`). Розширення в користувачів перевіряє останній
реліз і пропонує оновитися (README, «Оновлення»).

## Як влаштовано

- Раннер — окремий стек `forgejo-vscode-ci` (`deploy/runner/` → `~/containers/forgejo-vscode-ci.<домен>`),
  зареєстрований для організації `xDevOps`, мітка `forgejo-vscode-ci` — так само, як `xfleet-ci` / `xbot-ci`
  (один раннер на проєкт, `docs/deploy/git.md` у xInfra).
- Образ завдань — спільний `git.<домен>/xdevops/ci-docker` (xInfra, `services/ci-image`; з `python3` і `nodejs`
  з коміту xInfra `aeba682`), локальна копія на сервері (`force_pull: false`).
- **На відміну від xBot / xFleet, Docker сервера в завдання не монтується** (`docker_host: "-"`): релізу він не
  потрібен, тож завдання цього раннера не отримують root на сервері. Монтується лише `/etc/ssl/certs` хоста
  (внутрішній кореневий сертифікат).
- Checkout і створення релізу — автоматичним токеном завдання (`forgejo.token`), без секретів.

## Розгортання (на сервері, вручну)

Команди — з робочої копії на Mac/ПК, `engine` — SSH-аліас сервера, `<домен>` — справжній домен.
Оболонка на сервері — zsh: змінні перед `:` лише як `${I}` (`$I:latest` — модифікатор `:l`, `$I:a…` — `:a`);
підказка `read` — `read -rs "T?Підказка: "` (у zsh `read -p` — читання з копроцесу).

1. Образ CI з `python3` і `nodejs` (xInfra `docs/deploy/ci-image.md`; push у реєстр — там же, для історії):
   ```bash
   scp <xInfra>/services/ci-image/Dockerfile engine:containers/ci-image.<домен>/Dockerfile.new
   ssh engine 'cd ~/containers/ci-image.<домен> && cp Dockerfile Dockerfile.bak-$(date +%Y%m%d-%H%M%S) &&
     mv Dockerfile.new Dockerfile && I=git.<домен>/xdevops/ci-docker &&
     docker build -t "${I}:aeba682d5acc" -t "${I}:latest" . && docker run --rm "${I}:latest" sh -c "python3 --version; node --version"'
   ```
2. Тека стеку, `config.yml`, `.env`:
   ```bash
   ssh engine 'mkdir ~/containers/forgejo-vscode-ci.<домен>'
   scp deploy/runner/compose.yml deploy/runner/config.yml.example engine:containers/forgejo-vscode-ci.<домен>/
   ssh engine 'cd ~/containers/forgejo-vscode-ci.<домен> &&
     sed -e "s#<domain>#<домен>#g" config.yml.example > config.yml &&
     (umask 077; echo "DOCKER_GID=$(getent group docker | cut -d: -f3)" > .env)'
   ```
3. Токен реєстрації: Forgejo → організація `xDevOps` → Налаштування → Дії → Ранери → «Створити новий ранер».
   Реєстрація й запуск (токен вводиться без відображення, в історію не потрапляє):
   ```bash
   ssh -t engine 'cd ~/containers/forgejo-vscode-ci.<домен> && read -rs "T?Токен реєстрації: " && echo &&
     docker compose run --rm runner forgejo-runner register --no-interactive --instance https://git.<домен> \
       --token "$T" --name "$(hostname)-forgejo-vscode" --labels forgejo-vscode-ci:docker://git.<домен>/xdevops/ci-docker:latest &&
     docker compose up -d && docker compose logs --tail 20'
   ```
   Раннер має з'явитися в списку ранерів `xDevOps` як «у мережі».
4. Actions у репозиторії: `xDevOps/forgejo-vscode` → Налаштування → Репозиторій → «Дії» (Actions) увімкнено.

## Випуск версії

```bash
# version у package.json уже піднято й закомічено
git tag -a v0.3.1 -m "Що змінилося (опис релізу й текст «Що нового» в розширенні)"
git push --follow-tags
```
Хід — репозиторій → «Дії». Тег не збігається з `version` → завдання падає, релізу немає. Перезапуск того самого
тега замінює `.vsix` у наявному релізі.

## Нотатки

- Якщо автоматичному токену не дозволено створювати релізи (HTTP 403 на кроці Release) — токен користувача
  з `write:repository` у секрет репозиторію `RELEASE_TOKEN` і `FORGEJO_TOKEN: ${{ secrets.RELEASE_TOKEN }}`
  у workflow.
