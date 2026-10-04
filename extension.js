'use strict';

const vscode = require('vscode');
const http = require('http');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');

const SECRET_PREFIX = 'forgejo.token:';
const PAGE_SIZE = 50;
const MAX_PAGES = 40;
const CACHE_TTL_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;
const SKIPPED_VERSION_KEY = 'forgejo.skippedVersion';
const UPDATE_FIRST_CHECK_MS = 15 * 1000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const CERT_ERRORS = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function config() {
  return vscode.workspace.getConfiguration('forgejo');
}

function normalizeUrl(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

class ForgejoError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Права токена Forgejo/Gitea, потрібні розширенню:
// repository: write — список, пошук, створення репозиторіїв і git push/pull через HTTPS;
// user: write — GET /user (вхід), а POST /user/repos (новий особистий репозиторій) вимагає саме write:user;
// organization: write — список організацій і створення репозиторію в організації (для перегляду досить read).
const TOKEN_SCOPES_HELP =
  'Під час створення токена:\n'
  + '• Доступ до репозиторіїв і організацій: «Усі» (публічні, приватні та обмежені), інакше приватних репозиторіїв не буде видно;\n'
  + '• repository — читання й запис (список, клонування, push через HTTPS);\n'
  + '• user — читання й запис (вхід і створення особистих репозиторіїв);\n'
  + '• organization — читання й запис (репозиторії організацій; якщо створювати в організаціях не потрібно, досить читання);\n'
  + '• решта (issue, package, notification, admin тощо) — без доступу.';

function describeHttpError(status, json) {
  const detail = json && json.message ? `: ${json.message}` : '';
  switch (status) {
    case 401: return 'Токен недійсний або прострочений';
    case 403: return `Недостатньо прав токена${detail}. Потрібні права: repository, user і organization — читання й запис; `
      + 'створіть новий токен і виконайте «Forgejo: Вийти», потім «Forgejo: Увійти»';
    case 404: return `Не знайдено (перевірте адресу сервера)${detail}`;
    case 409: return 'Репозиторій з такою назвою вже існує';
    default: return `Помилка сервера HTTP ${status}${detail}`;
  }
}

// GitError з розширення Git має загальний message («Failed to execute git»), а причина — у stderr
function errorMessage(err) {
  if (!err) {
    return 'невідома помилка';
  }
  if (err.stderr) {
    const lines = String(err.stderr).split('\n').map(line => line.trim()).filter(Boolean);
    const important = lines.filter(line => /^(fatal|error|remote|ERROR):/.test(line));
    const detail = (important.length > 0 ? important : lines.slice(-3)).join(' ');
    if (detail) {
      return `${err.message}: ${detail}`;
    }
  }
  return err.message || String(err);
}

// Запуск git напряму (для того, чого немає в API розширення Git). Повертає stdout або кидає помилку зі stderr.
function runGit(gitPath, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(gitPath, args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(new Error(`git ${args[0]}`), { stderr, exitCode: err.code }));
      } else {
        resolve(String(stdout).trim());
      }
    });
  });
}

function describeNetworkError(err) {
  if (CERT_ERRORS.has(err.code)) {
    return `Сертифікат сервера не довірений (${err.code}). Встановіть кореневий сертифікат у системне сховище та перезапустіть VS Code.`;
  }
  switch (err.code) {
    case 'ENOTFOUND': return 'Сервер не знайдено (перевірте адресу в налаштуванні forgejo.url)';
    case 'ECONNREFUSED': return 'Сервер відхилив з\'єднання';
    case 'ECONNRESET': return 'З\'єднання розірвано';
    default: return err.message;
  }
}

class ForgejoClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.user = undefined;
  }

  request(method, apiPath, body) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(`${this.baseUrl}/api/v1${apiPath}`);
      } catch {
        reject(new ForgejoError(`Некоректна адреса сервера: ${this.baseUrl}`));
        return;
      }
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
      const headers = { Accept: 'application/json', Authorization: `token ${this.token}` };
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = data.length;
      }
      const lib = url.protocol === 'http:' ? http : https;
      const req = lib.request(url, { method, headers, timeout: REQUEST_TIMEOUT_MS }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new ForgejoError(describeHttpError(res.statusCode, json), res.statusCode));
          }
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('Сервер не відповідає (таймаут)'), { code: 'ETIMEDOUT' })));
      req.on('error', err => reject(new ForgejoError(describeNetworkError(err))));
      if (data) {
        req.write(data);
      }
      req.end();
    });
  }

  // Сервер може мати меншу межу на сторінку, ніж PAGE_SIZE, тож читаємо до порожньої сторінки
  async getAll(apiPath, extract = res => res) {
    const sep = apiPath.includes('?') ? '&' : '?';
    const all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = extract(await this.request('GET', `${apiPath}${sep}page=${page}&limit=${PAGE_SIZE}`)) || [];
      if (items.length === 0) {
        break;
      }
      all.push(...items);
    }
    return all;
  }

  getUser() {
    return this.request('GET', '/user');
  }

  getOrgs() {
    return this.getAll('/user/orgs');
  }

  async getAccessibleRepos() {
    const [own, orgs] = await Promise.all([this.getAll('/user/repos'), this.getOrgs()]);
    const orgRepos = await Promise.all(
      orgs.map(org => this.getAll(`/orgs/${encodeURIComponent(org.username)}/repos`).catch(() => []))
    );
    const byId = new Map();
    for (const repo of [...own, ...orgRepos.flat()]) {
      byId.set(repo.id, repo);
    }
    return [...byId.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  async searchRepos(query) {
    const res = await this.request('GET', `/repos/search?q=${encodeURIComponent(query)}&limit=${PAGE_SIZE}`);
    return (res && res.data) || [];
  }

  // Останній опублікований реліз (без чернеток і пре-релізів); undefined, якщо релізів немає
  getLatestRelease(fullName) {
    const [owner, name] = fullName.split('/');
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/latest`)
      .catch(err => {
        if (err.status === 404) {
          return undefined;
        }
        throw err;
      });
  }

  // Файл релізу (/releases/download/…) — не API, тож Basic-автентифікація логін + токен, як у git.
  // Переадресація на інший хост — без автентифікації.
  download(fileUrl, redirects = 5) {
    return new Promise((resolve, reject) => {
      const url = new URL(fileUrl);
      const headers = {};
      if (url.origin === new URL(this.baseUrl).origin) {
        headers.Authorization = 'Basic ' + Buffer.from(`${this.user.login}:${this.token}`).toString('base64');
      }
      const lib = url.protocol === 'http:' ? http : https;
      const req = lib.get(url, { headers, timeout: REQUEST_TIMEOUT_MS * 3 }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(this.download(new URL(res.headers.location, url).toString(), redirects - 1));
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(Buffer.concat(chunks));
          } else {
            reject(new ForgejoError(describeHttpError(res.statusCode), res.statusCode));
          }
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('Сервер не відповідає (таймаут)'), { code: 'ETIMEDOUT' })));
      req.on('error', err => reject(new ForgejoError(describeNetworkError(err))));
    });
  }

  getRepo(owner, name) {
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  }

  createRepo(org, body) {
    const apiPath = org ? `/orgs/${encodeURIComponent(org)}/repos` : '/user/repos';
    return this.request('POST', apiPath, body);
  }
}

// Порівняння версій вигляду 1.2.3 (необов'язковий префікс «v»): > 0, якщо a новіша за b
function compareVersions(a, b) {
  const parse = v => String(v).replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) {
      return (pa[i] || 0) - (pb[i] || 0);
    }
  }
  return 0;
}

function repoIcon(repo) {
  if (repo.private) {
    return 'lock';
  }
  return repo.fork ? 'repo-forked' : 'repo';
}

function repoUrls(repo, protocol) {
  const ssh = repo.ssh_url || repo.clone_url;
  const httpsUrl = repo.clone_url || repo.ssh_url;
  switch (protocol) {
    case 'https': return [httpsUrl];
    case 'ask': return ssh === httpsUrl ? [ssh] : [ssh, httpsUrl];
    default: return [ssh];
  }
}

// Назва з довільного рядка (наприклад, імені папки) у допустиму назву репозиторію
function sanitizeRepoName(name) {
  return (name || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/\.git$/i, '');
}

function validateRepoName(name) {
  if (!name) {
    return 'Вкажіть назву';
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return 'Допустимі лише латинські літери, цифри, «-», «_» та «.»';
  }
  if (name === '.' || name === '..' || /\.git$/i.test(name)) {
    return 'Недопустима назва';
  }
  return undefined;
}

class Forgejo {
  constructor(context, git) {
    this.context = context;
    this.git = git;
    this.client = undefined;
    this.repoCache = undefined;
    this.updatePromptOpen = false;
  }

  get baseUrl() {
    return normalizeUrl(config().get('url'));
  }

  reset() {
    this.client = undefined;
    this.repoCache = undefined;
  }

  // interactive = false: лише збережені налаштування, без жодних діалогів
  async getClient(interactive) {
    let baseUrl = this.baseUrl;
    if (!baseUrl) {
      if (!interactive) {
        return undefined;
      }
      baseUrl = await this.promptUrl();
      if (!baseUrl) {
        return undefined;
      }
      await config().update('url', baseUrl, vscode.ConfigurationTarget.Global);
    }

    if (this.client && this.client.baseUrl === baseUrl) {
      return this.client;
    }

    const secretKey = SECRET_PREFIX + baseUrl;
    let token = await this.context.secrets.get(secretKey);
    const isNewToken = !token;
    if (!token) {
      if (!interactive) {
        return undefined;
      }
      token = await this.promptToken(baseUrl);
      if (!token) {
        return undefined;
      }
    }

    const client = new ForgejoClient(baseUrl, token);
    try {
      client.user = await client.getUser();
    } catch (err) {
      if (err.status === 401) {
        await this.context.secrets.delete(secretKey);
        if (interactive) {
          vscode.window.showErrorMessage(`Forgejo: ${err.message}. Виконайте «Forgejo: Увійти» з новим токеном.`);
        }
        return undefined;
      }
      throw err;
    }

    if (isNewToken) {
      await this.context.secrets.store(secretKey, token);
      vscode.window.showInformationMessage(`Forgejo: ви увійшли як ${client.user.login}`);
    }
    this.client = client;
    return client;
  }

  async promptUrl() {
    const value = await vscode.window.showInputBox({
      title: 'Forgejo: адреса сервера',
      prompt: 'Адреса вашого сервера Forgejo',
      placeHolder: 'https://git.example.ua',
      ignoreFocusOut: true,
      validateInput: text => (/^https?:\/\/[^/\s]+/i.test(text.trim()) ? undefined : 'Вкажіть адресу, що починається з https://'),
    });
    return value ? normalizeUrl(value) : undefined;
  }

  async promptToken(baseUrl) {
    const enter = 'Ввести токен';
    const create = 'Створити токен у браузері';
    const choice = await vscode.window.showInformationMessage(
      `Для роботи з ${baseUrl} потрібен токен доступу Forgejo.`,
      {
        modal: true,
        detail: 'Створіть його в Forgejo: Налаштування → Застосунки → Створити новий токен.\n\n'
          + TOKEN_SCOPES_HELP + '\n\n'
          + 'Токен зберігається в захищеному сховищі системи (Keychain / Credential Manager).',
      },
      enter,
      create
    );
    if (!choice) {
      return undefined;
    }
    if (choice === create) {
      await vscode.env.openExternal(vscode.Uri.parse(`${baseUrl}/user/settings/applications`));
    }
    const token = await vscode.window.showInputBox({
      title: 'Forgejo: токен доступу',
      prompt: `Вставте токен доступу для ${baseUrl} (права: repository, user, organization — читання й запис)`,
      password: true,
      ignoreFocusOut: true,
    });
    return token ? token.trim() : undefined;
  }

  async getRepos(client, force = false) {
    const now = Date.now();
    if (!force && this.repoCache && this.repoCache.baseUrl === client.baseUrl && now - this.repoCache.at < CACHE_TTL_MS) {
      return this.repoCache.repos;
    }
    const repos = await client.getAccessibleRepos();
    this.repoCache = { baseUrl: client.baseUrl, at: now, repos };
    return repos;
  }

  async chooseUrl(repo) {
    const urls = repoUrls(repo, config().get('cloneProtocol'));
    if (urls.length === 1) {
      return urls[0];
    }
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'SSH', description: urls[0], url: urls[0] },
        { label: 'HTTPS', description: urls[1], url: urls[1] },
      ],
      { placeHolder: 'Протокол підключення' }
    );
    return picked && picked.url;
  }

  // --- Провайдер для «Git: Clone» та «Publish Branch» ---

  toRemoteSource(repo) {
    return {
      name: repo.full_name,
      description: repo.description || undefined,
      icon: repoIcon(repo),
      url: repoUrls(repo, config().get('cloneProtocol')),
    };
  }

  async getRemoteSources(query) {
    const client = await this.getClient(false);
    if (!client) {
      throw new Error('спочатку виконайте команду «Forgejo: Увійти»');
    }
    const repos = await this.getRepos(client);
    if (!query) {
      return repos.map(repo => this.toRemoteSource(repo));
    }

    const q = query.toLowerCase();
    const local = repos.filter(repo =>
      repo.full_name.toLowerCase().includes(q) || (repo.description || '').toLowerCase().includes(q));
    // Пошук на сервері додає публічні репозиторії інших користувачів
    const remote = await client.searchRepos(query).catch(() => []);
    const seen = new Set(local.map(repo => repo.id));
    const merged = [...local, ...remote.filter(repo => !seen.has(repo.id))];
    return merged.map(repo => this.toRemoteSource(repo));
  }

  getCredentials(host) {
    const baseUrl = this.baseUrl;
    if (!baseUrl) {
      return undefined;
    }
    let serverHost;
    try {
      serverHost = new URL(baseUrl).host.toLowerCase();
    } catch {
      return undefined;
    }
    if (host.authority.replace(/^.*@/, '').toLowerCase() !== serverHost) {
      return undefined;
    }
    return this.getClient(false).then(client => client && { username: client.user.login, password: client.token });
  }

  // --- Створення репозиторію ---

  async createRepositoryInteractive(options) {
    const spec = await this.promptNewRepository(options);
    return spec && this.createRepository(spec);
  }

  // Діалоги без створення: повертає { client, org, body } або undefined, якщо скасовано
  async promptNewRepository({ suggestedName, askInit }) {
    const client = await this.getClient(true);
    if (!client) {
      return undefined;
    }

    const orgs = await client.getOrgs().catch(() => []);
    let org;
    if (orgs.length > 0) {
      const owner = await vscode.window.showQuickPick(
        [
          { label: `$(account) ${client.user.login}`, description: 'особистий акаунт', org: undefined },
          ...orgs.map(o => ({ label: `$(organization) ${o.username}`, description: o.full_name || 'організація', org: o.username })),
        ],
        { title: 'Новий репозиторій Forgejo (1/4)', placeHolder: 'Власник репозиторію' }
      );
      if (!owner) {
        return undefined;
      }
      org = owner.org;
    }

    const name = await vscode.window.showInputBox({
      title: 'Новий репозиторій Forgejo (2/4)',
      prompt: 'Назва репозиторію',
      value: sanitizeRepoName(suggestedName),
      ignoreFocusOut: true,
      validateInput: validateRepoName,
    });
    if (!name) {
      return undefined;
    }

    const description = await vscode.window.showInputBox({
      title: 'Новий репозиторій Forgejo (3/4)',
      prompt: 'Опис (необов\'язково, Enter — пропустити)',
      ignoreFocusOut: true,
    });
    if (description === undefined) {
      return undefined;
    }

    const privateItem = { label: '$(lock) Приватний', private: true };
    const publicItem = { label: '$(globe) Публічний', private: false };
    const visibility = await vscode.window.showQuickPick(
      config().get('defaultPrivate') ? [privateItem, publicItem] : [publicItem, privateItem],
      { title: 'Новий репозиторій Forgejo (4/4)', placeHolder: 'Видимість' }
    );
    if (!visibility) {
      return undefined;
    }

    let autoInit = false;
    if (askInit) {
      const init = await vscode.window.showQuickPick(
        [
          { label: 'Порожній', detail: 'Для підключення вже існуючого локального проєкту', autoInit: false },
          { label: 'З README', detail: 'Можна одразу клонувати й працювати', autoInit: true },
        ],
        { title: 'Новий репозиторій Forgejo', placeHolder: 'Початковий вміст' }
      );
      if (!init) {
        return undefined;
      }
      autoInit = init.autoInit;
    }

    const body = { name, description, private: visibility.private, auto_init: autoInit };
    if (autoInit) {
      body.readme = 'Default';
    }
    return { client, org, body };
  }

  async createRepository({ client, org, body }) {
    const repo = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Forgejo: створення ${org || client.user.login}/${body.name}…` },
      () => client.createRepo(org, body)
    );
    this.repoCache = undefined;
    return repo;
  }

  async connectAndPush(repository, repo) {
    const url = await this.chooseUrl(repo);
    if (!url) {
      vscode.window.showWarningMessage(`Forgejo: репозиторій ${repo.full_name} створено, але не підключено.`);
      return false;
    }
    await repository.addRemote('origin', url);

    const head = repository.state.HEAD;
    if (!head || !head.name || !head.commit) {
      vscode.window.showInformationMessage(
        `Forgejo: ${repo.full_name} підключено як origin. Зробіть перший коміт і виконайте Push.`
      );
      return true;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Forgejo: відправлення гілки ${head.name}…` },
      () => repository.push('origin', head.name, true)
    );
    return true;
  }

  // Виклик з «Publish Branch» розширення Git
  async publishRepository(repository) {
    try {
      await this.publishFolder(repository.rootUri, repository);
    } catch (err) {
      vscode.window.showErrorMessage(`Forgejo: ${errorMessage(err)}`);
    }
  }

  // Публікація папки: repository — наявний git-репозиторій без remote або undefined (тоді git init).
  // Якщо комітів ще немає — вибір файлів і перший коміт. Усі перевірки — до створення репозиторію на сервері.
  async publishFolder(folderUri, repository) {
    const spec = await this.promptNewRepository({ suggestedName: path.basename(folderUri.fsPath), askInit: false });
    if (!spec) {
      return;
    }
    const needCommit = !repository || !(repository.state.HEAD && repository.state.HEAD.commit);
    let ignored = [];
    if (needCommit) {
      ignored = await this.pickIgnoredEntries(folderUri);
      if (!ignored || !(await this.ensureGitIdentity(spec.client, folderUri.fsPath))) {
        return;
      }
    }

    const repo = await this.createOrReuseRepository(spec);
    if (!repo) {
      return;
    }

    if (needCommit) {
      repository = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Forgejo: створення першого коміту…' },
        async () => {
          if (ignored.length > 0) {
            await vscode.workspace.fs.writeFile(
              vscode.Uri.joinPath(folderUri, '.gitignore'),
              Buffer.from(ignored.map(name => `/${name}\n`).join(''), 'utf8')
            );
          }
          if (!repository) {
            const defaultBranch = vscode.workspace.getConfiguration('git').get('defaultBranchName') || 'main';
            repository = await this.git.init(folderUri, { defaultBranch });
            if (!repository) {
              throw new Error(`не вдалося ініціалізувати git-репозиторій у ${folderUri.fsPath}`);
            }
          }
          await repository.commit('Initial commit', { all: true });
          return repository;
        }
      );
    }
    if (await this.connectAndPush(repository, repo)) {
      this.showCreated(repo, `Forgejo: проєкт опубліковано в ${repo.full_name}`);
    }
  }

  // Якщо репозиторій з такою назвою вже є і він порожній (наприклад, лишився після невдалої спроби) — запропонувати його
  async createOrReuseRepository(spec) {
    try {
      return await this.createRepository(spec);
    } catch (err) {
      if (err.status !== 409) {
        throw err;
      }
      const owner = spec.org || spec.client.user.login;
      const existing = await spec.client.getRepo(owner, spec.body.name).catch(() => undefined);
      if (!existing || !existing.empty) {
        throw new Error(`репозиторій ${owner}/${spec.body.name} вже існує і не порожній — оберіть іншу назву`);
      }
      const use = 'Використати його';
      const choice = await vscode.window.showWarningMessage(
        `Репозиторій ${existing.full_name} вже існує на сервері і порожній.`,
        { modal: true, detail: 'Можливо, він лишився після попередньої невдалої спроби. Опублікувати проєкт у нього?' },
        use
      );
      return choice === use ? existing : undefined;
    }
  }

  // Без user.name / user.email git не робить коміт («Author identity unknown»).
  // Пропонуємо значення з профілю Forgejo і записуємо в глобальні налаштування git.
  async ensureGitIdentity(client, cwd) {
    const gitPath = this.git.git.path;
    const get = key => runGit(gitPath, ['config', '--get', key], cwd).catch(() => '');
    const [name, email] = await Promise.all([get('user.name'), get('user.email')]);
    if (name && email) {
      return true;
    }
    const setup = 'Налаштувати';
    const choice = await vscode.window.showWarningMessage(
      'Git не знає вашого імені та email для комітів.',
      { modal: true, detail: 'Їх буде записано в глобальні налаштування git (git config --global user.name / user.email) і використано для всіх комітів на цьому комп\'ютері.' },
      setup
    );
    if (choice !== setup) {
      return false;
    }
    const newName = name || await vscode.window.showInputBox({
      title: 'Git: ім\'я автора комітів',
      value: client.user.full_name || client.user.login,
      ignoreFocusOut: true,
      validateInput: text => (text.trim() ? undefined : 'Вкажіть ім\'я'),
    });
    if (!newName) {
      return false;
    }
    const newEmail = email || await vscode.window.showInputBox({
      title: 'Git: email автора комітів',
      value: client.user.email || '',
      ignoreFocusOut: true,
      validateInput: text => (/^[^\s@]+@[^\s@]+$/.test(text.trim()) ? undefined : 'Вкажіть email'),
    });
    if (!newEmail) {
      return false;
    }
    if (!name) {
      await runGit(gitPath, ['config', '--global', 'user.name', newName.trim()], cwd);
    }
    if (!email) {
      await runGit(gitPath, ['config', '--global', 'user.email', newEmail.trim()], cwd);
    }
    return true;
  }

  async showCreated(repo, message, extraActions = []) {
    const browser = 'Відкрити в браузері';
    const choice = await vscode.window.showInformationMessage(message, ...extraActions, browser);
    if (choice === browser) {
      vscode.env.openExternal(vscode.Uri.parse(repo.html_url));
    }
    return choice;
  }

  // --- Команди ---

  async cmdSignIn() {
    const wasSignedIn = Boolean(this.client);
    const client = await this.getClient(true);
    if (client && wasSignedIn) {
      vscode.window.showInformationMessage(`Forgejo: ви вже увійшли як ${client.user.login} (${client.baseUrl})`);
    }
  }

  async cmdSignOut() {
    const baseUrl = this.baseUrl;
    if (baseUrl) {
      await this.context.secrets.delete(SECRET_PREFIX + baseUrl);
    }
    this.reset();
    vscode.window.showInformationMessage('Forgejo: токен видалено.');
  }

  async cmdClone() {
    const client = await this.getClient(true);
    if (!client) {
      return;
    }
    const repos = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Forgejo: завантаження репозиторіїв…' },
      () => this.getRepos(client, true)
    );
    const picked = await vscode.window.showQuickPick(
      repos.map(repo => ({ label: `$(${repoIcon(repo)}) ${repo.full_name}`, description: repo.description, repo })),
      { placeHolder: 'Репозиторій для клонування', matchOnDescription: true }
    );
    if (!picked) {
      return;
    }
    const url = await this.chooseUrl(picked.repo);
    if (url) {
      await vscode.commands.executeCommand('git.clone', url);
    }
  }

  async cmdCreateRepository() {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const repo = await this.createRepositoryInteractive({
      suggestedName: folder ? folder.name : '',
      askInit: true,
    });
    if (!repo) {
      return;
    }

    const clone = 'Клонувати';
    const connect = 'Підключити поточний проєкт';
    // Підключати має сенс лише порожній репозиторій до локального git-репозиторію без remote
    const unconnected = !repo.empty || !this.git ? [] : this.git.repositories.filter(r => r.state.remotes.length === 0);
    const actions = unconnected.length > 0 ? [connect, clone] : [clone];

    const choice = await this.showCreated(repo, `Forgejo: репозиторій ${repo.full_name} створено`, actions);
    if (choice === clone) {
      const url = await this.chooseUrl(repo);
      if (url) {
        await vscode.commands.executeCommand('git.clone', url);
      }
    } else if (choice === connect) {
      let repository = unconnected[0];
      if (unconnected.length > 1) {
        const picked = await vscode.window.showQuickPick(
          unconnected.map(r => ({ label: path.basename(r.rootUri.fsPath), description: r.rootUri.fsPath, repository: r })),
          { placeHolder: 'Який локальний репозиторій підключити' }
        );
        if (!picked) {
          return;
        }
        repository = picked.repository;
      }
      if (await this.connectAndPush(repository, repo)) {
        vscode.window.showInformationMessage(`Forgejo: ${path.basename(repository.rootUri.fsPath)} підключено до ${repo.full_name}`);
      }
    }
  }

  // Кнопка «Publish to Forgejo» у порожній панелі Source Control і команда «Forgejo: Опублікувати у Forgejo»
  async cmdPublish() {
    if (!this.git) {
      throw new Error('вбудоване розширення Git вимкнено або git не встановлено');
    }
    const folders = vscode.workspace.workspaceFolders || [];
    let folder = folders[0];
    if (!folder) {
      throw new Error('спочатку відкрийте папку проєкту');
    }
    if (folders.length > 1) {
      const picked = await vscode.window.showQuickPick(
        folders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f })),
        { placeHolder: 'Яку папку опублікувати у Forgejo' }
      );
      if (!picked) {
        return;
      }
      folder = picked.folder;
    }

    const existing = this.git.getRepository(folder.uri);
    if (existing && existing.state.remotes.length > 0) {
      vscode.window.showInformationMessage(`Forgejo: ${folder.name} вже має віддалений репозиторій.`);
      return;
    }
    await this.publishFolder(existing ? existing.rootUri : folder.uri, existing || undefined);
  }

  // --- Оновлення розширення з релізів Forgejo (forgejo.updates.repository) ---

  // interactive = true: команда «Перевірити оновлення» — з діалогами входу й повідомленням «остання версія»
  async checkForUpdates(interactive) {
    const repoName = (config().get('updates.repository') || '').trim();
    if (!repoName || (!interactive && !config().get('updates.check'))) {
      if (interactive) {
        vscode.window.showWarningMessage('Forgejo: не вказано репозиторій оновлень (налаштування forgejo.updates.repository).');
      }
      return;
    }
    const client = await this.getClient(interactive);
    if (!client) {
      return;
    }
    const current = this.context.extension.packageJSON.version;
    const release = await client.getLatestRelease(repoName);
    const asset = release && (release.assets || []).find(a => /\.vsix$/i.test(a.name));
    if (!release || !asset || compareVersions(release.tag_name, current) <= 0) {
      if (interactive) {
        vscode.window.showInformationMessage(`Forgejo: у вас остання версія розширення (${current}).`);
      }
      return;
    }
    const version = release.tag_name.replace(/^v/i, '');
    if (!interactive && this.context.globalState.get(SKIPPED_VERSION_KEY) === version) {
      return;
    }
    if (this.updatePromptOpen) {
      return;
    }

    this.updatePromptOpen = true;
    let choice;
    try {
      const update = 'Оновити';
      const notes = 'Що нового';
      const skip = 'Пропустити цю версію';
      do {
        choice = await vscode.window.showInformationMessage(
          `Forgejo Connector: доступна версія ${version} (у вас ${current}).`,
          update, notes, skip
        );
        if (choice === notes) {
          await vscode.window.showInformationMessage(
            `Forgejo Connector ${version}`,
            { modal: true, detail: (release.body || '').trim() || 'Опису змін немає.' }
          );
        }
      } while (choice === notes);
      if (choice === skip) {
        await this.context.globalState.update(SKIPPED_VERSION_KEY, version);
        return;
      }
      if (choice !== update) {
        return;
      }
    } finally {
      this.updatePromptOpen = false;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Forgejo Connector: встановлення версії ${version}…` },
      async () => {
        const data = await client.download(asset.browser_download_url);
        const dir = this.context.globalStorageUri;
        await vscode.workspace.fs.createDirectory(dir);
        const file = vscode.Uri.joinPath(dir, asset.name);
        await vscode.workspace.fs.writeFile(file, data);
        await vscode.commands.executeCommand('workbench.extensions.installExtension', file);
        await vscode.workspace.fs.delete(file).then(undefined, () => undefined);
      }
    );
    const reload = 'Перезавантажити вікно';
    if (await vscode.window.showInformationMessage(
      `Forgejo Connector ${version} встановлено. Перезавантажте вікно, щоб застосувати оновлення.`, reload
    ) === reload) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  // Як у GitHub: якщо .gitignore немає, дати зняти позначку з файлів і папок, які не потрібно комітити.
  // Повертає список імен для .gitignore ([] — комітити все) або undefined, якщо скасовано.
  async pickIgnoredEntries(folderUri) {
    const entries = await vscode.workspace.fs.readDirectory(folderUri);
    if (entries.some(([name]) => name === '.gitignore')) {
      return [];
    }
    const items = entries
      .filter(([name]) => name !== '.git')
      .sort(([a, aType], [b, bType]) =>
        (bType & vscode.FileType.Directory) - (aType & vscode.FileType.Directory) || a.localeCompare(b))
      .map(([name, type]) => ({
        label: `$(${type & vscode.FileType.Directory ? 'folder' : 'file'}) ${name}`,
        name,
        picked: true,
      }));
    if (items.length === 0) {
      return [];
    }
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'Що додати в репозиторій',
      placeHolder: 'Зніміть позначку з того, що не треба комітити (буде додано в .gitignore)',
      ignoreFocusOut: true,
    });
    if (!picked) {
      return undefined;
    }
    const keep = new Set(picked.map(item => item.name));
    return items.filter(item => !keep.has(item.name)).map(item => item.name);
  }
}

function withErrors(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      vscode.window.showErrorMessage(`Forgejo: ${errorMessage(err)}`);
    }
  };
}

async function getGitApi() {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) {
    return undefined;
  }
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    return exports.getAPI(1);
  } catch {
    // Git вимкнено (git.enabled = false) або не встановлено
    return undefined;
  }
}

async function activate(context) {
  const git = await getGitApi();
  const forgejo = new Forgejo(context, git);

  context.subscriptions.push(
    vscode.commands.registerCommand('forgejo.signIn', withErrors(() => forgejo.cmdSignIn())),
    vscode.commands.registerCommand('forgejo.signOut', withErrors(() => forgejo.cmdSignOut())),
    vscode.commands.registerCommand('forgejo.clone', withErrors(() => forgejo.cmdClone())),
    vscode.commands.registerCommand('forgejo.createRepository', withErrors(() => forgejo.cmdCreateRepository())),
    vscode.commands.registerCommand('forgejo.publish', withErrors(() => forgejo.cmdPublish())),
    vscode.commands.registerCommand('forgejo.checkForUpdates', withErrors(() => forgejo.checkForUpdates(true))),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('forgejo.url')) {
        forgejo.reset();
      }
    })
  );

  // Автоматична перевірка — тихо: без діалогів входу й без повідомлень про помилки
  const autoCheck = () => forgejo.checkForUpdates(false).catch(err => console.warn('Forgejo: перевірка оновлень:', err));
  const firstCheck = setTimeout(autoCheck, UPDATE_FIRST_CHECK_MS);
  const periodicCheck = setInterval(autoCheck, UPDATE_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => { clearTimeout(firstCheck); clearInterval(periodicCheck); } });

  if (git) {
    context.subscriptions.push(
      git.registerRemoteSourceProvider({
        name: 'Forgejo',
        icon: 'repo',
        supportsQuery: true,
        placeholder: 'Назва репозиторію (введіть для пошуку)',
        getRemoteSources: query => forgejo.getRemoteSources(query),
        publishRepository: repository => forgejo.publishRepository(repository),
      }),
      git.registerCredentialsProvider({
        getCredentials: host => forgejo.getCredentials(host),
      })
    );
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  // для тестів
  _internal: { ForgejoClient, errorMessage, compareVersions, repoUrls, sanitizeRepoName, validateRepoName, normalizeUrl },
};
