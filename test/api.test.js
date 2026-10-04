const assert = require('assert'); const http = require('http');
const { _internal: I } = require('../extension.js');
const mk = (id, n, extra={}) => ({ id, full_name: n, updated_at: `2026-0${id%9+1}-01`, ssh_url: `git@h:${n}.git`, clone_url: `https://h/${n}.git`, ...extra });
const mine = Array.from({length: 73}, (_, i) => mk(i+1, `me/r${i+1}`));
let lastPost, auth;
const srv = http.createServer((req, res) => {
  auth = req.headers.authorization;
  if (req.url === '/sub/redirect.vsix') { res.writeHead(302, { Location: '/sub/xDevOps/fc/releases/download/v0.3.1/a.vsix' }); return res.end(); }
  if (req.url.startsWith('/sub/xDevOps/fc/releases/download/')) {
    if (auth !== 'Basic ' + Buffer.from('viktor:good').toString('base64')) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(Buffer.from([80, 75, 3, 4]));
  }
  const u = new URL(req.url, 'http://x'); const page = +u.searchParams.get('page') || 1, limit = +u.searchParams.get('limit');
  const pg = arr => arr.slice((page-1)*Math.min(limit,30), page*Math.min(limit,30)); // сервер з межею 30
  const send = (code, obj) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); };
  if (auth !== 'token good') return send(401, { message: 'unauthorized' });
  if (u.pathname === '/sub/api/v1/user') return send(200, { login: 'viktor' });
  if (u.pathname === '/sub/api/v1/user/repos' && req.method === 'GET') return send(200, pg(mine));
  if (u.pathname === '/sub/api/v1/user/orgs') return send(200, pg([{ username: 'team' }]));
  if (u.pathname === '/sub/api/v1/orgs/team/repos' && req.method === 'GET') return send(200, pg([mk(5, 'me/r5'), mk(500, 'team/shared')]));
  if (u.pathname === '/sub/api/v1/repos/xDevOps/fc/releases/latest') return send(200, { tag_name: 'v0.3.1', assets: [{ name: 'a.vsix', browser_download_url: base + '/xDevOps/fc/releases/download/v0.3.1/a.vsix' }] });
  if (u.pathname === '/sub/api/v1/repos/xDevOps/none/releases/latest') return send(404, { message: 'not found' });
  if (u.pathname === '/sub/api/v1/repos/viktor/dup') return send(200, mk(77, 'viktor/dup', { empty: true }));
  if (u.pathname === '/sub/api/v1/repos/search') return send(200, { ok: true, data: [mk(900, 'other/' + u.searchParams.get('q'))] });
  if (req.method === 'POST') { let b=''; req.on('data', c => b += c); req.on('end', () => { lastPost = { path: u.pathname, body: JSON.parse(b) }; if (lastPost.body.name === 'dup') return send(409, { message: 'exists' }); send(201, mk(1000, 'x/' + lastPost.body.name, { empty: true })); }); return; }
  send(404, { message: 'nope' });
});
let base;
srv.listen(0, async () => {
  base = `http://127.0.0.1:${srv.address().port}/sub`;
  const c = new I.ForgejoClient(base, 'good');
  assert.strictEqual((await c.getUser()).login, 'viktor');
  const repos = await c.getAccessibleRepos();
  assert.strictEqual(repos.length, 74, 'pagination + dedupe'); // 73 own + team/shared, r5 deduped
  assert.ok(repos.some(r => r.full_name === 'team/shared'));
  assert.strictEqual((await c.searchRepos('abc'))[0].full_name, 'other/abc');
  const created = await c.createRepo('team', { name: 'новий', private: true });
  assert.strictEqual(lastPost.path, '/sub/api/v1/orgs/team/repos'); assert.strictEqual(lastPost.body.name, 'новий');
  await c.createRepo(undefined, { name: 'a' }); assert.strictEqual(lastPost.path, '/sub/api/v1/user/repos');
  await assert.rejects(c.createRepo(undefined, { name: 'dup' }), e => e.status === 409 && /вже існує/.test(e.message));
  await assert.rejects(new I.ForgejoClient(base, 'bad').getUser(), e => e.status === 401);
  await assert.rejects(new I.ForgejoClient('http://127.0.0.1:1', 't').getUser(), e => /відхилив/.test(e.message));
  const r = mk(1, 'me/x');
  assert.deepStrictEqual(I.repoUrls(r, 'ssh'), ['git@h:me/x.git']);
  assert.deepStrictEqual(I.repoUrls(r, 'https'), ['https://h/me/x.git']);
  assert.deepStrictEqual(I.repoUrls(r, 'ask'), ['git@h:me/x.git', 'https://h/me/x.git']);
  assert.deepStrictEqual(I.repoUrls({ clone_url: 'https://h/a.git', ssh_url: '' }, 'ssh'), ['https://h/a.git']);
  assert.strictEqual(I.sanitizeRepoName('My Project (v2).git'), 'My-Project-v2');
  assert.strictEqual(I.sanitizeRepoName('Наряди'), '');
  assert.strictEqual(I.validateRepoName('ok-name_1.2'), undefined);
  assert.ok(I.validateRepoName('bad name')); assert.ok(I.validateRepoName('x.git')); assert.ok(I.validateRepoName(''));
  assert.strictEqual(I.normalizeUrl(' https://g.ua/// '), 'https://g.ua');
  assert.strictEqual((await c.getRepo('viktor', 'dup')).empty, true);
  await assert.rejects(c.getRepo('viktor', 'none'), e => e.status === 404);
  const gitErr = Object.assign(new Error('Failed to execute git'), { stderr: 'Author identity unknown\n\n*** Please tell me who you are.\n\nfatal: no email was given and auto-detection is disabled\n' });
  assert.strictEqual(I.errorMessage(gitErr), 'Failed to execute git: fatal: no email was given and auto-detection is disabled');
  assert.strictEqual(I.errorMessage(new Error('x')), 'x');
  c.user = { login: 'viktor' };
  const rel = await c.getLatestRelease('xDevOps/fc');
  assert.strictEqual(rel.tag_name, 'v0.3.1');
  assert.strictEqual(await c.getLatestRelease('xDevOps/none'), undefined);
  assert.deepStrictEqual([...await c.download(rel.assets[0].browser_download_url)], [80, 75, 3, 4]);
  assert.deepStrictEqual([...await c.download(base + '/redirect.vsix')], [80, 75, 3, 4], 'redirect');
  const bad = new I.ForgejoClient(base, 'bad'); bad.user = { login: 'viktor' };
  await assert.rejects(bad.download(rel.assets[0].browser_download_url), e => e.status === 404);
  assert.ok(I.compareVersions('v0.3.1', '0.3.0') > 0); assert.ok(I.compareVersions('0.10.0', '0.9.9') > 0);
  assert.strictEqual(I.compareVersions('v1.0.0', '1.0'), 0); assert.ok(I.compareVersions('0.2.2', '0.3.0') < 0);
  console.log('ALL TESTS PASSED'); srv.close();
});
