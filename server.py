#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
足迹地图后端服务：账户登录（用户名 + 密码）+ 云端数据同步
================================================
零依赖实现，仅需 Python 3.8+（标准库），数据存储为同目录 SQLite 文件 footprints.db。
同时承担静态网站托管（本目录 index.html / js / css），前后端同源，会话 Cookie 无跨域问题。

== 自定义账户 ==
  POST /api/register {username, password}  注册（用户名全局唯一，自动登录）
  POST /api/login    {username, password}  登录
  密码使用 PBKDF2-HMAC-SHA256（12 万次迭代 + 随机盐）哈希存储，不保存明文。
  会话为 HMAC-SHA256 签名 Cookie（30 天有效），账户名经 base64url 编码后放入令牌。

== 微信登录（可选，配置 AppID 后自动启用）==
1. 到 https://open.weixin.qq.com （微信开放平台）注册「网站应用」，审核通过后获得
   AppID / AppSecret（需企业主体资质；个人开发者可先在本地跑通流程，回调域配置后再上线）。
2. 在开放平台「网站应用 -> 授权回调域」填写你的域名（微信要求已备案域名，生产环境须 HTTPS）。
3. 首次运行本脚本会自动生成 config.json，填入：
     {
       "wx_appid": "wx……",                  // 网站应用 AppID
       "wx_secret": "……",                   // 网站应用 AppSecret
       "base_url": "https://your.domain",   // 网站对外访问地址（登录后跳回）
       "port": 8137,                        // 服务端口
       "session_secret": "请改成任意长随机字符串"  // 会话签名密钥
     }
4. 运行：python server.py   →  访问 http://127.0.0.1:8137/
   未配置 appid 时登录接口会返回未配置提示，前端按钮会给出引导文案。

== 登录流程（微信网站应用标准 OAuth2）==
  浏览器 -> /api/wx/login -> 302 跳转微信扫码页（PC: qrconnect / 微信内: oauth2/authorize）
  用户扫码确认 -> 微信 302 到 /api/wx/callback?code&state
  服务端用 code 调 /sns/oauth2/access_token 换 access_token，再调 /sns/userinfo 取昵称头像
  -> 写入 users 表 -> 签名会话 Cookie（HMAC-SHA256，30 天有效）-> 302 回网站首页
  前端启动时 GET /api/me 识别登录态，自动触发云端数据合并同步。

== 云端数据同步 API ==
  GET  /api/me      当前登录用户 {login, user{openid,nickname,headimgurl}, syncedAt}
  GET  /api/sync    拉取云端记录 {records:[...]}
  POST /api/sync    整包上传记录 {records:[...]}（合并由前端完成，服务端只存最新快照）
  POST /api/logout  退出登录（清除会话）
记录含照片（base64 dataUrl），整包快照式存储，上限 64MB。
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT, 'footprints.db')
CONFIG_PATH = os.path.join(ROOT, 'config.json')

DEFAULT_CONFIG = {
    'wx_appid': '',
    'wx_secret': '',
    'base_url': 'http://127.0.0.1:8137',
    'port': 8137,
    'session_secret': '',
    'max_body_mb': 64
}

SESSION_TTL = 30 * 24 * 3600       # 会话有效期 30 天
STATE_TTL = 600                    # OAuth state 防伪有效期 10 分钟
SESSION_COOKIE = 'pm_session'


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                cfg.update(json.load(f) or {})
        except Exception as e:
            print('[config] 读取 config.json 失败，使用默认配置：', e)
    else:
        # 首次运行生成模板，secret 自动填随机串
        cfg['session_secret'] = secrets.token_hex(32)
        try:
            with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
            print('[config] 已生成模板 config.json，请填入微信 AppID/AppSecret 后重启')
        except Exception as e:
            print('[config] 写入 config.json 失败：', e)
    if not cfg.get('session_secret'):
        cfg['session_secret'] = secrets.token_hex(32)
    return cfg


CONFIG = load_config()


# ---------------------------------------------------------------- SQLite
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute('PRAGMA journal_mode=WAL')
    return conn


def init_db():
    with db() as conn:
        conn.execute('''CREATE TABLE IF NOT EXISTS users(
            openid TEXT PRIMARY KEY,
            nickname TEXT DEFAULT '',
            headimgurl TEXT DEFAULT '',
            created_at INTEGER
        )''')
        conn.execute('''CREATE TABLE IF NOT EXISTS accounts(
            username TEXT PRIMARY KEY,
            pass_salt TEXT NOT NULL,
            pass_hash TEXT NOT NULL,
            created_at INTEGER
        )''')
        conn.execute('''CREATE TABLE IF NOT EXISTS cloud_data(
            openid TEXT PRIMARY KEY,
            records TEXT NOT NULL,
            updated_at INTEGER
        )''')


# ---------------------------------------------------------------- 会话
def _sign(payload: str) -> str:
    key = CONFIG['session_secret'].encode()
    return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()


def _b64(ident: str) -> str:
    # 账户名可能含中文等非 ASCII 字符，base64url 编码后放入 Cookie（去填充）
    return base64.urlsafe_b64encode(ident.encode('utf-8')).decode('ascii').rstrip('=')


def _unb64(tok: str):
    try:
        pad = '=' * (-len(tok) % 4)
        return base64.urlsafe_b64decode((tok + pad).encode('ascii')).decode('utf-8')
    except Exception:
        return None


def make_session(ident: str) -> str:
    payload = _b64(ident) + '|' + str(int(time.time()) + SESSION_TTL)
    raw = payload + '|' + _sign(payload)
    return raw  # 账户b64|exp|sig


def parse_session(token: str):
    if not token or token.count('|') != 2:
        return None
    ident_b64, exp, sig = token.split('|')
    if not re.fullmatch(r'[0-9a-zA-Z_-]+', ident_b64 or ''):
        return None
    try:
        if int(exp) < time.time():
            return None
    except ValueError:
        return None
    if not hmac.compare_digest(sig, _sign(ident_b64 + '|' + exp)):
        return None
    return _unb64(ident_b64)


# ---------------------------------------------------------------- 账户（用户名 + 密码）
PBKDF2_ITERS = 120000
USERNAME_RE = re.compile(r'^[\u4e00-\u9fa5A-Za-z0-9_-]{2,24}$')


def hash_password(password: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'),
                               bytes.fromhex(salt_hex), PBKDF2_ITERS).hex()


def session_cookie(ident: str) -> str:
    return '%s=%s; Max-Age=%d; Path=/; HttpOnly; SameSite=Lax' % (
        SESSION_COOKIE, make_session(ident), SESSION_TTL)


# ---------------------------------------------------------------- 微信 API
def wx_api(url, params):
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(url + '?' + qs,
                                 headers={'User-Agent': 'photo-map-server/1.0'})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    return data


def wx_error_msg(data):
    return data.get('errmsg') or ('errcode=' + str(data.get('errcode')))


# ---------------------------------------------------------------- HTTP
MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
}

SAFE_PATH = re.compile(r'^[\w\-. /]+$')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'PhotoMapServer/1.0'

    # ---------- 基础工具 ----------
    def log_message(self, fmt, *args):
        print('[http]', self.address_string(), fmt % args)

    def send_json(self, obj, status=200, cookies=()):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for c in cookies:
            self.send_header('Set-Cookie', c)
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location, cookies=()):
        self.send_response(302)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        for c in cookies:
            self.send_header('Set-Cookie', c)
        self.end_headers()

    def read_body(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = 0
        limit = int(CONFIG.get('max_body_mb', 64)) * 1024 * 1024
        if n <= 0 or n > limit:
            return None
        return self.rfile.read(n)

    def cookies(self):
        out = {}
        raw = self.headers.get('Cookie') or ''
        for part in raw.split(';'):
            if '=' in part:
                k, v = part.split('=', 1)
                out[k.strip()] = v.strip()
        return out

    def current_openid(self):
        return parse_session(self.cookies().get(SESSION_COOKIE, ''))

    def site_origin(self):
        # 优先用配置的对外地址，其次 Referer（本地调试无配置时也能跳回）
        base = (CONFIG.get('base_url') or '').rstrip('/')
        if base and base not in ('http://127.0.0.1:%d' % CONFIG.get('port', 8137),):
            return base
        ref = self.headers.get('Referer')
        if ref:
            p = urllib.parse.urlparse(ref)
            if p.scheme and p.netloc:
                return p.scheme + '://' + p.netloc
        return base or ('http://127.0.0.1:%d' % CONFIG.get('port', 8137))

    # ---------- 路由 ----------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path == '/api/wx/status':
                return self.send_json({'enabled': bool(CONFIG.get('wx_appid')), 'login': False})
            if path == '/api/wx/login':
                return self.wx_login()
            if path == '/api/wx/callback':
                return self.wx_callback(parsed)
            if path == '/api/me':
                return self.api_me()
            if path == '/api/sync':
                return self.api_sync_get()
            return self.serve_static(path)
        except Exception as e:
            print('[error] GET', path, repr(e))
            return self.send_json({'error': str(e)}, status=500)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path == '/api/register':
                return self.api_register()
            if path == '/api/login':
                return self.api_login()
            if path == '/api/logout':
                return self.api_logout()
            if path == '/api/sync':
                return self.api_sync_post()
            return self.send_json({'error': 'not found'}, status=404)
        except Exception as e:
            print('[error] POST', path, repr(e))
            return self.send_json({'error': str(e)}, status=500)

    # ---------- 静态站点 ----------
    def serve_static(self, path):
        if path == '/':
            path = '/index.html'
        rel = path.lstrip('/')
        if not SAFE_PATH.match(rel) or '..' in rel:
            return self.send_json({'error': 'bad path'}, status=400)
        full = os.path.normpath(os.path.join(ROOT, rel))
        if not full.startswith(ROOT) or not os.path.isfile(full):
            return self.send_json({'error': 'not found'}, status=404)
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, 'application/octet-stream')
        with open(full, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(body)

    # ---------- 微信登录 ----------
    def wx_login(self):
        appid = CONFIG.get('wx_appid')
        if not appid:
            return self.redirect('/?login=disabled')
        state = secrets.token_urlsafe(16)
        redirect_uri = self.site_origin() + '/api/wx/callback'
        ua = (self.headers.get('User-Agent') or '').lower()
        state_cookie = 'pm_state=%s; Max-Age=%d; Path=/; HttpOnly; SameSite=Lax' % (state, STATE_TTL)
        if 'micromessenger' in ua:   # 微信内置浏览器：网页授权（自动/手动确认，取昵称头像）
            url = ('https://open.weixin.qq.com/connect/oauth2/authorize?'
                   + urllib.parse.urlencode({
                       'appid': appid, 'redirect_uri': redirect_uri,
                       'response_type': 'code', 'scope': 'snsapi_userinfo',
                       'state': state}) + '#wechat_redirect')
        else:                        # 桌面/普通浏览器：扫码登录
            url = ('https://open.weixin.qq.com/connect/qrconnect?'
                   + urllib.parse.urlencode({
                       'appid': appid, 'redirect_uri': redirect_uri,
                       'response_type': 'code', 'scope': 'snsapi_login',
                       'state': state}) + '#wechat_redirect')
        return self.redirect(url, cookies=(state_cookie,))

    def wx_callback(self, parsed):
        qs = urllib.parse.parse_qs(parsed.query)
        code = (qs.get('code') or [''])[0]
        state = (qs.get('state') or [''])[0]
        origin = self.site_origin()
        if not CONFIG.get('wx_appid'):
            return self.redirect(origin + '/?login=disabled')
        cookie_state = self.cookies().get('pm_state', '')
        if not code or not state or state != cookie_state:
            return self.redirect(origin + '/?login=state')
        # 1) code 换 access_token
        tok = wx_api('https://api.weixin.qq.com/sns/oauth2/access_token', {
            'appid': CONFIG['wx_appid'], 'secret': CONFIG['wx_secret'],
            'code': code, 'grant_type': 'authorization_code'})
        if 'access_token' not in tok:
            print('[wx] access_token 失败：', tok)
            return self.redirect(origin + '/?login=wxerr')
        # 2) 拉取用户信息（openid 不变则与 scope 无关；UnionID 未启用时以 openid 为账号主键）
        userinfo = wx_api('https://api.weixin.qq.com/sns/userinfo', {
            'access_token': tok['access_token'], 'openid': tok['openid'], 'lang': 'zh_CN'})
        nickname = userinfo.get('nickname') or '微信用户'
        headimg = userinfo.get('headimgurl') or ''
        openid = tok['openid']
        now = int(time.time())
        with db() as conn:
            conn.execute('''INSERT INTO users(openid, nickname, headimgurl, created_at)
                            VALUES(?,?,?,?)
                            ON CONFLICT(openid) DO UPDATE SET nickname=excluded.nickname,
                                headimgurl=excluded.headimgurl''',
                         (openid, nickname, headimg, now))
        sess = make_session(openid)
        cookie = '%s=%s; Max-Age=%d; Path=/; HttpOnly; SameSite=Lax' % (SESSION_COOKIE, sess, SESSION_TTL)
        clear_state = 'pm_state=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax'
        return self.redirect(origin + '/?login=1', cookies=(cookie, clear_state))

    # ---------- 会话 / 同步 ----------
    def api_register(self):
        body = self.read_body()
        if body is None:
            return self.send_json({'error': 'bad body'}, status=400)
        try:
            data = json.loads(body.decode('utf-8'))
            username = (data.get('username') or '').strip()
            password = data.get('password') or ''
        except Exception:
            return self.send_json({'error': 'bad json'}, status=400)
        if not USERNAME_RE.fullmatch(username):
            return self.send_json({'error': '用户名需 2-24 位，仅限中文、字母、数字、下划线或中划线'}, status=400)
        if not (6 <= len(password) <= 64):
            return self.send_json({'error': '密码长度需为 6-64 位'}, status=400)
        now = int(time.time())
        with db() as conn:
            dup = conn.execute('SELECT 1 FROM accounts WHERE username=? OR LOWER(username)=LOWER(?)',
                               (username, username)).fetchone()
            if dup:
                return self.send_json({'error': '该用户名已被注册'}, status=409)
            salt = secrets.token_hex(16)
            conn.execute('INSERT INTO accounts(username, pass_salt, pass_hash, created_at) VALUES(?,?,?,?)',
                         (username, salt, hash_password(password, salt), now))
        return self.send_json(
            {'ok': True, 'user': {'openid': username, 'nickname': username, 'headimgurl': ''}},
            cookies=(session_cookie(username),))

    def api_login(self):
        body = self.read_body()
        if body is None:
            return self.send_json({'error': 'bad body'}, status=400)
        try:
            data = json.loads(body.decode('utf-8'))
            username = (data.get('username') or '').strip()
            password = data.get('password') or ''
        except Exception:
            return self.send_json({'error': 'bad json'}, status=400)
        with db() as conn:
            row = conn.execute('SELECT username, pass_salt, pass_hash FROM accounts WHERE LOWER(username)=LOWER(?)',
                               (username,)).fetchone()
        if not row or not hmac.compare_digest(hash_password(password, row[1]), row[2]):
            return self.send_json({'error': '用户名或密码错误'}, status=401)
        return self.send_json(
            {'ok': True, 'user': {'openid': row[0], 'nickname': row[0], 'headimgurl': ''}},
            cookies=(session_cookie(row[0]),))

    def api_me(self):
        ident = self.current_openid()
        if not ident:
            return self.send_json({'login': False})
        with db() as conn:
            acc = conn.execute('SELECT username FROM accounts WHERE username=?', (ident,)).fetchone()
            if acc:   # 自定义账户
                user = {'openid': acc[0], 'nickname': acc[0], 'headimgurl': ''}
            else:     # 微信账户（可选）
                row = conn.execute('SELECT openid, nickname, headimgurl FROM users WHERE openid=?',
                                   (ident,)).fetchone()
                if not row:
                    return self.send_json({'login': False})
                user = {'openid': row[0], 'nickname': row[1], 'headimgurl': row[2]}
            upd = conn.execute('SELECT updated_at FROM cloud_data WHERE openid=?',
                               (ident,)).fetchone()
        return self.send_json({
            'login': True,
            'user': user,
            'syncedAt': (upd[0] if upd else 0)
        })

    def api_logout(self):
        cookie = '%s=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax' % SESSION_COOKIE
        return self.send_json({'ok': True}, cookies=(cookie,))

    def api_sync_get(self):
        openid = self.current_openid()
        if not openid:
            return self.send_json({'error': 'unauthorized'}, status=401)
        with db() as conn:
            row = conn.execute('SELECT records, updated_at FROM cloud_data WHERE openid=?',
                               (openid,)).fetchone()
        if not row:
            return self.send_json({'records': [], 'deletedIds': [], 'updatedAt': 0})
        try:
            data = json.loads(row[0])
        except Exception:
            data = {}
        if isinstance(data, list):          # 兼容旧格式（纯记录数组）
            data = {'records': data, 'deletedIds': []}
        data.setdefault('records', [])
        data.setdefault('deletedIds', [])
        data['updatedAt'] = row[1]
        return self.send_json(data)

    def api_sync_post(self):
        openid = self.current_openid()
        if not openid:
            return self.send_json({'error': 'unauthorized'}, status=401)
        body = self.read_body()
        if body is None:
            return self.send_json({'error': 'payload too large or empty'}, status=413)
        try:
            data = json.loads(body.decode('utf-8'))
            records = data['records']
            if not isinstance(records, list):
                raise ValueError('records must be list')
            if not isinstance(data.get('deletedIds', []), list):
                raise ValueError('deletedIds must be list')
        except Exception as e:
            return self.send_json({'error': 'bad json: ' + str(e)}, status=400)
        now = int(time.time())
        with db() as conn:
            conn.execute('''INSERT INTO cloud_data(openid, records, updated_at)
                            VALUES(?,?,?)
                            ON CONFLICT(openid) DO UPDATE SET records=excluded.records,
                                updated_at=excluded.updated_at''',
                         (openid, json.dumps(data, ensure_ascii=False), now))
        return self.send_json({'ok': True, 'updatedAt': now, 'count': len(records)})


def main():
    init_db()
    port = int(CONFIG.get('port', 8137))
    server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    print('=' * 60)
    print('足迹地图服务已启动: http://127.0.0.1:%d/' % port)
    print('账户登录: 已启用（注册 /api/register，登录 /api/login）')
    print('微信登录: %s（可选）' % ('已配置 (AppID=%s...)' % CONFIG['wx_appid'][:6]
                                  if CONFIG.get('wx_appid') else '未配置'))
    print('云端数据库: %s' % DB_PATH)
    print('=' * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n服务已停止')


if __name__ == '__main__':
    main()
