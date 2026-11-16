#!/usr/bin/env python3
"""Copy one published GitHub release of 小纸间 to the Gitee backup source.

Runs in GitHub Actions after a release is published (see mirror-gitee.yml).
Usage: gitee_mirror.py windows|android <tag>   e.g. windows v1.2.3

Steps: download update.json and the package from the GitHub release, check
size and SHA-256 against update.json, split the Windows package into parts
below Gitee's 100 MB attachment limit, upload them to the Gitee release
"<platform>-v<version>" (resumable: parts already there are kept), publish
<platform>/update.json in the Gitee repository only after every file is in
place, then delete older Gitee releases of the same platform (1 GB quota).
The token comes from the GITEE_TOKEN environment variable and is never printed.
"""
import base64, hashlib, json, os, subprocess, sys, tempfile, time, urllib.parse

GITEE_REPO = 'March7th0307/xiaozhijian-releases'
API = f'https://gitee.com/api/v5/repos/{GITEE_REPO}'
PART = 95 * 1024 * 1024
SOURCES = {
    'windows': ('March7th0307-dot/xiaozhijian-windows-releases', 'xiaozhijian-windows.zip'),
    'android': ('March7th0307-dot/xiaozhijian-releases', 'xiaozhijian-android.apk'),
}
TOKEN = os.environ.get('GITEE_TOKEN', '').strip()


def log(*a): print(*a, flush=True)


def curl(args, retries=4, timeout=600):
    """Run curl, returning stdout bytes. The token is sent via stdin config."""
    for attempt in range(retries):
        cfg = f'form = "access_token={TOKEN}"\n' if '-F' in args or '--form' in args else ''
        p = subprocess.run(['curl', '-sS', '-L', '--max-time', str(timeout), '-K', '-', '-w', '\n%{http_code}', *args],
                           input=cfg.encode(), capture_output=True)
        body, _, code = p.stdout.rpartition(b'\n')
        if p.returncode == 0 and code.decode().isdigit() and int(code) < 500:
            return int(code), body
        log(f'  网络问题，第 {attempt + 1} 次重试（curl {p.returncode}，状态 {code.decode(errors="ignore")}）')
        time.sleep(10 * (attempt + 1))
    sys.exit('多次重试仍然失败')


def api(method, path, fields=None, query=None, files=None, timeout=120):
    q = dict(query or {}); url = API + path
    args = ['-X', method]
    if method in ('GET', 'DELETE'):
        q['access_token'] = TOKEN
    else:
        for k, v in (fields or {}).items(): args += ['-F', f'{k}={v}']
        for k, v in (files or {}).items(): args += ['-F', f'{k}=@{v}']
        if not fields and not files: args += ['-F', 'unused=1']
    if q: url += '?' + urllib.parse.urlencode(q)
    code, body = curl(args + [url], timeout=timeout)
    data = json.loads(body) if body.strip() else None
    return code, data


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''): h.update(chunk)
    return h.hexdigest()


def main():
    platform, tag = sys.argv[1], sys.argv[2]
    if platform not in SOURCES or not tag.startswith('v') or not TOKEN: sys.exit('参数或令牌缺失')
    version = tag[1:]
    gh_repo, asset = SOURCES[platform]
    work = tempfile.mkdtemp()
    base = f'https://github.com/{gh_repo}/releases/download/{tag}/'

    log(f'1/5 从 GitHub 下载 {tag}')
    manifest_path = os.path.join(work, 'update.json')
    code, raw = curl([base + 'update.json'])
    if code != 200: sys.exit(f'读取 update.json 失败（{code}）')
    open(manifest_path, 'wb').write(raw)
    info = json.loads(raw)
    expected = info['version'] if platform == 'windows' else info['versionName']
    if expected != version: sys.exit(f'update.json 版本 {expected} 与标签 {tag} 不一致')
    package = os.path.join(work, asset)
    code, _ = curl(['-o', package, base + asset], timeout=1800)
    if code != 200 or os.path.getsize(package) != info['size'] or sha256(package) != info['sha256']:
        sys.exit('安装包大小或校验值与 update.json 不符')

    log('2/5 准备文件')
    uploads = []
    if platform == 'windows':
        with open(package, 'rb') as f:
            n = 0
            while chunk := f.read(PART):
                n += 1; part = f'{package}.{n:03d}'
                open(part, 'wb').write(chunk); uploads.append(part)
        gitee_manifest = raw  # byte-identical signed manifest
    else:
        uploads.append(package)
        info['url'] = f'https://gitee.com/{GITEE_REPO}/releases/download/android-v{version}/{asset}'
        gitee_manifest = (json.dumps(info, ensure_ascii=False, indent=2) + '\n').encode()

    log('3/5 上传到 Gitee')
    gitee_tag = f'{platform}-v{version}'
    code, rel = api('GET', f'/releases/tags/{gitee_tag}')
    if code != 200 or not rel or not rel.get('id'):
        code, rel = api('POST', '/releases', {'tag_name': gitee_tag, 'name': f'小纸间 {"Windows" if platform == "windows" else "Android"} {version}',
                                              'body': '国内备用下载源，由 GitHub 发布自动同步。', 'target_commitish': 'master', 'prerelease': 'false'})
        if code not in (200, 201): sys.exit(f'创建 Gitee 发行版失败（{code}）：{rel}')
    rid = rel['id']
    code, existing = api('GET', f'/releases/{rid}/attach_files', query={'per_page': 100})
    have = {a['name']: a for a in (existing or [])} if code == 200 else {}
    for path in uploads:
        name = os.path.basename(path)
        if name in have and have[name].get('size') == os.path.getsize(path):
            log(f'  已存在，跳过 {name}'); continue
        if name in have: api('DELETE', f'/releases/{rid}/attach_files/{have[name]["id"]}')
        t = time.time()
        code, res = api('POST', f'/releases/{rid}/attach_files', files={'file': path}, timeout=7200)
        if code not in (200, 201) or not res or res.get('size') != os.path.getsize(path): sys.exit(f'上传 {name} 失败（{code}）：{res}')
        log(f'  已上传 {name}，{os.path.getsize(path) / 1048576:.1f} MB，用时 {time.time() - t:.0f} 秒')

    log('4/5 发布 Gitee 版本信息')
    file_path = f'{platform}/update.json'
    code, cur = api('GET', f'/contents/{file_path}')
    content = base64.b64encode(gitee_manifest).decode()
    if code == 200 and isinstance(cur, dict) and cur.get('sha'):
        code, res = api('PUT', f'/contents/{file_path}', {'content': content, 'sha': cur['sha'], 'message': f'{platform} {version}'})
    else:
        code, res = api('POST', f'/contents/{file_path}', {'content': content, 'message': f'{platform} {version}'})
    if code not in (200, 201): sys.exit(f'更新版本信息失败（{code}）：{res}')

    log('5/5 删除旧版本')
    page = 1
    while True:
        code, rels = api('GET', '/releases', query={'per_page': 100, 'page': page})
        if code != 200 or not rels: break
        for r in rels:
            t = r.get('tag_name', '')
            if t.startswith(f'{platform}-v') and t != gitee_tag:
                api('DELETE', f'/releases/{r["id"]}'); log(f'  已删除 {t}')
        if len(rels) < 100: break
        page += 1
    log(f'完成：{gitee_tag}')


if __name__ == '__main__':
    main()
