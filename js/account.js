/**
 * account.js —— GitHub OAuth登录版：对接 Supabase Edge‑Function wander‑api
 * 本地 IndexedDB 为主数据源；GitHub一键授权登录；云端同步走 edge function
 * 保留：双向合并、删除墓碑、防抖推送；退出登录不清空本地记录
 */
window.Account = (function () {
  'use strict';

  // ===== 运行模式开关 =====
  // CLOUD_ENABLED：是否启用 GitHub 登录（需要 Supabase 项目，仅用于身份验证）
  // SYNC_ENABLED ：是否把记录同步到云端。false = 数据只留在本机 IndexedDB，
  //                登录仅用于身份展示，不向任何服务器上传足迹数据。
  const CLOUD_ENABLED = true;
  const SYNC_ENABLED = false;

  // ====================== 👉这里改成你自己的值======================
  const SUPABASE_URL = "https://dxvyfkiachwawwsfhgve.supabase.co";
  const EDGE_API = "https://dxvyfkiachwawwsfhgve.supabase.co/functions/v1/wander-api";
  // 2026-11-05：由旧版 anon JWT 换为新版 Publishable Key。
  // Publishable Key 设计上就是公开的（靠 RLS 保护），可以留在前端；
  // 真正不能进仓库的是 service_role / Secret Key，只存在于服务端 .env。
  const SUPABASE_ANON_KEY = "sb_publishable_UXRP2ODwiC2vPRhV5LPj1A_HWgF-WIY";
  // REDIRECT_URL 已废弃：改用 window.location.origin 动态回跳（见 loginWithGithub）
  // =================================================================
  let supabase = null;
  var user = null;
  var syncing = false;
  var pushTimer = null;
  var hooks = {};
  /* ---------------- 工具：Blob <-> dataURL ---------------- */
  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }
  function dataURLToBlob(dataUrl) {
    try {
      var m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(dataUrl || '');
      if (!m) return null;
      var mime = m[1] || 'application/octet-stream';
      if (!m[2]) return new Blob([decodeURIComponent(m[3])], { type: mime });
      var bin = atob(m[3]);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    } catch (e) { return null; }
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }
  // supabase-js v2 的 session 是异步接口；v1 的 auth.session() 在 v2 已被移除，
  // 旧写法会直接抛 "supabase.auth.session is not a function"，导致同步永远失败。
  async function getAuthToken() {
    const { data } = await supabase.auth.getSession();
    return data && data.session ? data.session.access_token : null;
  }
  // 记录统一形态：images[].blob 必须是 Blob（云端来的只有 dataUrl）
  function toLocalRec(r) {
    var out = {
      id: r.id || uid(),
      lat: r.lat, lng: r.lng,
      title: r.title || '',
      note: r.note || '',
      timestamp: typeof r.timestamp === 'number' ? r.timestamp : Date.now(),
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
      color: typeof r.color === 'string' ? r.color : '',
      categoryName: typeof r.categoryName === 'string' ? r.categoryName : '',
      scale: r.scale === undefined ? 'auto' : r.scale,
      images: []
    };
    (r.images || []).forEach(function (im) {
      out.images.push({
        id: im.id || uid(),
        name: im.name || '',
        type: im.type || '',
        blob: im.blob instanceof Blob ? im.blob : dataURLToBlob(im.dataUrl || im.blob)
      });
    });
    out.images = out.images.filter(function (im) { return im.blob; });
    return out;
  }
  // 记录 → 云端形态（blob 转 dataUrl）
  async function toCloudRec(rec) {
    var images = [];
    for (var i = 0; i < rec.images.length; i++) {
      var im = rec.images[i];
      images.push({
        id: im.id, name: im.name, type: im.type,
        dataUrl: await blobToDataURL(im.blob)
      });
    }
    return {
      id: rec.id, lat: rec.lat, lng: rec.lng,
      title: rec.title, note: rec.note,
      timestamp: rec.timestamp, createdAt: rec.createdAt,
      updatedAt: rec.updatedAt || 0,
      color: rec.color || '', categoryName: rec.categoryName || '',
      scale: rec.scale === undefined ? 'auto' : rec.scale,
      images: images
    };
  }
  function stampOf(r) { return r.updatedAt || r.createdAt || r.timestamp || 0; }
  var DEL_KEY = 'pm-deleted-ids';
  function getDeleted() {
    try { return JSON.parse(localStorage.getItem(DEL_KEY) || '[]') || []; }
    catch (e) { return []; }
  }
  function noteDelete(id) {
    if (!id) return;
    var list = getDeleted();
    if (list.indexOf(id) === -1) {
      list.push(id);
      if (list.length > 500) list = list.slice(-500);
      try { localStorage.setItem(DEL_KEY, JSON.stringify(list)); } catch (e) {}
    }
  }
  // 双向合并云端数据到本地
  async function mergeCloud(cloudRecords, cloudDeleted) {
    var tomb = {};
    getDeleted().forEach(function (id) { tomb[id] = 1; });
    (cloudDeleted || []).forEach(function (id) { tomb[id] = 1; });
    var local = await DB.all();
    var map = new Map();
    local.forEach(function (r) { map.set(r.id, r); });
    for (var k = 0; k < local.length; k++) {
      if (tomb[local[k].id]) { map.delete(local[k].id); await DB.remove(local[k].id); }
    }
    for (var i = 0; i < cloudRecords.length; i++) {
      var cr = toLocalRec(cloudRecords[i]);
      if (tomb[cr.id]) continue;
      var lr = map.get(cr.id);
      if (!lr) { map.set(cr.id, cr); await DB.put(cr); continue; }
      if (stampOf(cr) > stampOf(lr)) { map.set(cr.id, cr); await DB.put(cr); }
    }
    return map.size;
  }
  // 调用 edge‑function 获取云端全部记录 + 删除墓碑
  async function fetchCloudData() {
    const token = await getAuthToken();
    if (!token) throw new Error("未登录");
    const resp = await fetch(EDGE_API, {
      method: "POST",
      // Supabase 网关开启 verify_jwt 后，缺少 Authorization 头会在函数执行前直接 401，
      // 因此令牌既放在 body.token（函数内使用），也要放在请求头（网关校验）。
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        "apikey": SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ token, action: "get_sync_data", payload: {} })
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return await resp.json();
  }
  // 推送本地快照到云端
  async function pushSnapshot() {
    const token = await getAuthToken();
    if (!token) throw new Error("未登录");
    var all = await DB.all();
    var payload = [];
    for (var i = 0; i < all.length; i++) payload.push(await toCloudRec(all[i]));
    const resp = await fetch(EDGE_API, {
      method: "POST",
      // Supabase 网关开启 verify_jwt 后，缺少 Authorization 头会在函数执行前直接 401，
      // 因此令牌既放在 body.token（函数内使用），也要放在请求头（网关校验）。
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        "apikey": SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        token,
        action: "sync_upload",
        payload: { records: payload, deletedIds: getDeleted() }
      })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return payload.length;
  }
  async function pushNow(silent) {
    if (!user || syncing) return false;
    if (!SYNC_ENABLED) {
      if (!silent && hooks.toast) hooks.toast('本地模式：数据只保存在本浏览器，不上传云端');
      return false;
    }
    try {
      var n = await pushSnapshot();
      if (!silent && hooks.toast) hooks.toast('已同步 ' + n + ' 条记录到云端');
      return true;
    } catch (e) {
      console.error('云端推送失败', e);
      if (!silent && hooks.toast) hooks.toast('云端同步失败，本地数据不受影响');
      return false;
    }
  }
  function pushSoon() {
    if (!user || !SYNC_ENABLED) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushNow(true); }, 4000);
  }
  // 登录后首次双向同步（本地模式下跳过，数据不离开本机）
  async function syncOnLogin() {
    if (syncing) return;
    if (!SYNC_ENABLED) {
      if (hooks.toast) hooks.toast('已登录（本地模式，足迹数据不上传云端）');
      return;
    }
    syncing = true;
    try {
      if (hooks.toast) hooks.toast('正在同步云端数据……');
      const cloud = await fetchCloudData();
      var total = await mergeCloud(cloud.records || [], cloud.deletedIds || []);
      await pushSnapshot();
      if (hooks.onChange) await hooks.onChange();
      if (hooks.toast) hooks.toast('已同步 ' + total + ' 条记录（本机 + 云端自动合并）');
    } catch (e) {
      console.error('登录同步失败', e);
      if (hooks.toast) hooks.toast('云端同步失败，本地数据不受影响');
    }
    syncing = false;
  }
  /* ---------------- UI渲染 ---------------- */
  var btn = null, menu = null;
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setUI() {
    if (!btn) return;
    if (user) {
      const displayName = user.user_metadata?.name || user.email || 'GitHub用户';
      btn.innerHTML = '<span class="account-avatar account-avatar-text">' + esc(displayName.charAt(0).toUpperCase()) + '</span>'
        + '<span class="account-name">' + esc(displayName) + '</span> ▾';
      btn.title = '已登录：' + displayName;
    } else {
      btn.innerHTML = '<span class="account-wx-icon">👤</span> 登录 / 注册';
      btn.title = '使用 GitHub 登录（本地模式：足迹数据不上传云端）';
    }
    if (menu) menu.classList.add('hidden');
  }
  function toggleMenu(ev) {
    if (ev) ev.stopPropagation();
    if (!user) { openAccModal(); return; }
    menu.classList.toggle('hidden');
    if (!menu.classList.contains('hidden')) {
      const displayName = user.user_metadata?.name || user.email || 'GitHub用户';
      menu.innerHTML =
        '<div class="account-menu-head">' + esc(displayName) + '</div>' +
        '<button type="button" id="acc-sync-now">⟳ 同步状态</button>' +
        '<button type="button" id="acc-logout">↩ 退出登录</button>';
      document.getElementById('acc-sync-now').onclick = async function () {
        menu.classList.add('hidden');
        await pushNow(false);
      };
      document.getElementById('acc-logout').onclick = doLogout;
    }
  }
  var modal = null;
  function openAccModal() {
    if (!modal) return;
    document.getElementById('acc-err').textContent = '';
    modal.classList.remove('hidden');
  }
  // GitHub一键登录
  async function loginWithGithub() {
    const errEl = document.getElementById('acc-err');
    errEl.textContent = '';
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
          // 回跳到当前站点而不是写死的域名：本地 127.0.0.1、GitHub Pages 子路径、
          // 以及任意自定义域名都能完成登录。
          // 注意 GitHub Pages 部署在 /wander-pins/ 子路径下，所以 origin 之外还要带上 pathname，
          // 否则回调会落到站点根目录 404。所有线上地址都要加进
          // Supabase 控制台 -> Authentication -> URL Configuration -> Redirect URLs 白名单。
          redirectTo: window.location.origin + window.location.pathname.replace(/index\.html?$/, '')
        }
      });
      if (error) {
        errEl.textContent = error.message;
      }
    } catch (e) {
      errEl.textContent = '登录失败，请检查网络';
    }
  }
  function bindAccDom() {
    modal = document.getElementById('account-modal');
    if (!modal) return;
    document.getElementById('acc-x').onclick = function () { modal.classList.add('hidden'); };
    document.getElementById('btn-github-login').onclick = loginWithGithub;
    modal.addEventListener('click', function (ev) {
      if (ev.target === modal) modal.classList.add('hidden');
    });
  }
  async function doLogout() {
    try { await supabase.auth.signOut(); } catch (e) {}
    user = null;
    setUI();
    if (hooks.toast) hooks.toast('已退出登录，本机数据全部保留');
  }
  function bindDom() {
    btn = document.getElementById('btn-account');
    menu = document.getElementById('account-menu');
    if (btn) {
      btn.addEventListener('click', toggleMenu);
    }
    if (menu) {
      document.addEventListener('click', function (ev) {
        if (!menu.classList.contains('hidden') &&
          !menu.contains(ev.target) && ev.target !== btn) {
          menu.classList.add('hidden');
        }
      });
    }
    bindAccDom();
  }
  async function init(h) {
    hooks = h || {};
    if (!CLOUD_ENABLED) {
      // 纯本地模式：不创建 Supabase 客户端，隐藏账户入口
      var accBtn = document.getElementById('btn-account');
      if (accBtn) accBtn.style.display = 'none';
      return;
    }
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    bindDom();
    setUI();
    // 读取已有会话（OAuth跳转回来会自动拿到session）
    const { data } = await supabase.auth.getSession();
    if (data?.session) {
      user = data.session.user;
    } else {
      user = null;
    }
    setUI();
    if (user) syncOnLogin();
  }
  return {
    init: init,
    pushSoon: pushSoon,
    pushNow: pushNow,
    noteDelete: noteDelete,
    getUser: function () { return user; },
    backend: CLOUD_ENABLED
  };
})();
