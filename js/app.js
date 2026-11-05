/* global L, DB, topojson */
/**
 * app.js —— 足迹地图主逻辑
 * 纯色陆地/海洋底图（无瓦片、无路线，±360° 世界副本左右环绕）、本地照片导入、时间记录、
 * 行政区划染色（五档变色尺度：国家~镇，可跟随缩放或固定）、地名标注（国家名/省名）、
 * 照片缩略图标记、旅行日志详情视图、分类图例、
 * 备份导入导出、地名搜索、手动坐标、新手教程
 */
(function () {
  'use strict';

  /* ---------------- 状态 ---------------- */
  let map;
  let markerLayer;
  let regionLayer;                 // 行政区划染色层（在标记之下）
  let labelLayer;                  // 国家地名标注层（染色之上、标记之下）
  let provLabelLayer;              // 境内省名标注层
  let records = [];                 // 内存中的全部记录（按时间倒序）
  const markers = new Map();        // recordId -> L.LayerGroup（彩色区域 + 缩略图标记）
  const imageUrls = new Map();      // imageId -> ObjectURL
  let formState = null;             // 表单编辑状态 { lat, lng, id, images, color, category, scale }
  let journalState = null;          // 日志视图状态 { recId, imgIdx }

  /* ---------------- 分类与颜色 ---------------- */
  const PALETTE = ['#e4572e', '#2563eb', '#16a34a', '#d97706', '#9333ea',
    '#db2777', '#0891b2', '#65a30d', '#dc2626', '#475569'];

  function hashStr(s) {
    let h = 0;
    s = String(s || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function recColor(rec) {
    return rec.color || PALETTE[hashStr(rec.categoryName || rec.title || rec.id) % PALETTE.length];
  }

  function recCategory(rec) {
    return (rec.categoryName || '').trim() || '未分类';
  }

  // 旧记录 / 导入记录的字段兜底（不写回数据库，编辑保存时自然落库）
  function normalizeRec(rec) {
    if (typeof rec.categoryName !== 'string') rec.categoryName = '';
    if (!rec.color) rec.color = recColor(rec);
    if (rec.scale !== 'auto' && [1, 2, 3, 4, 5].indexOf(rec.scale) === -1) rec.scale = 'auto';
    if (rec.lng > 180 || rec.lng < -180) rec.lng = wrapLng(rec.lng);   // 归一到主世界
    return rec;
  }

  /* ---------------- 世界环绕（±360° 副本，美俄在接缝处相邻同屏） ---------------- */
  const SHIFTS = [-360, 0, 360];

  // 经度归一到 [-180, 180)
  function wrapLng(lng) {
    return ((lng + 180) % 360 + 360) % 360 - 180;
  }

  // 整体平移 GeoJSON 坐标（渲染世界副本用）
  function shiftGeo(data, dx) {
    if (!dx || !data) return data;
    function shiftCoords(c) {
      if (typeof c[0] === 'number') return [c[0] + dx, c[1]];
      return c.map(shiftCoords);
    }
    if (data.type === 'FeatureCollection') {
      return { type: 'FeatureCollection', features: data.features.map(function (f) { return shiftGeo(f, dx); }) };
    }
    if (data.type === 'Feature') {
      return {
        type: 'Feature',
        properties: data.properties,
        geometry: { type: data.geometry.type, coordinates: shiftCoords(data.geometry.coordinates) }
      };
    }
    return { type: data.type, coordinates: shiftCoords(data.coordinates) };
  }

  // 反经线展开：把环内 ±180° 的经度跳变（如楚科奇 178.6→-180）改写为连续经度（→180+）。
  // 否则 SVG 会画出横贯全图的水平条带；跨出 ±180 的部分由世界副本自然补齐。
  function unwrapGeo(data) {
    function unwrapRing(ring) {
      let shift = 0, prev = null;
      return ring.map(function (c) {
        let lng = c[0] + shift;
        if (prev !== null) {
          while (lng - prev > 180) { lng -= 360; shift -= 360; }
          while (prev - lng > 180) { lng += 360; shift += 360; }
        }
        prev = lng;
        return [lng, c[1]];
      });
    }
    function unwrapCoords(c) {
      if (!c || typeof c[0] === 'number') return c;       // 点坐标
      if (typeof c[0][0] === 'number') return unwrapRing(c); // 环
      return c.map(unwrapCoords);                          // 多环嵌套
    }
    if (!data) return data;
    if (data.type === 'FeatureCollection') {
      return { type: 'FeatureCollection', features: data.features.map(unwrapGeo) };
    }
    if (data.type === 'Feature') {
      const g = data.geometry;
      return {
        type: 'Feature',
        id: data.id,   // 保留 id（国家中文名转换依赖 ISO 数字码）
        properties: data.properties,
        geometry: g ? { type: g.type, coordinates: unwrapCoords(g.coordinates) } : null
      };
    }
    if (data.type === 'Polygon' || data.type === 'MultiPolygon' ||
        data.type === 'LineString' || data.type === 'MultiLineString') {
      return { type: data.type, coordinates: unwrapCoords(data.coordinates) };
    }
    return data;
  }

  /* ---------------- 工具函数 ---------------- */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) +
      (d.getSeconds() ? ':' + pad(d.getSeconds()) : '') + ' ' + WEEKDAYS[d.getDay()];
  }

  function fmtClock(ts) {
    const d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function fmtDateBig(ts) {
    const d = new Date(ts);
    return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · ' + WEEKDAYS[d.getDay()];
  }

  // 转成 <input type="datetime-local"> 需要的值
  function toInputValue(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  function getImageUrl(image) {
    if (!imageUrls.has(image.id)) {
      imageUrls.set(image.id, URL.createObjectURL(image.blob));
    }
    return imageUrls.get(image.id);
  }

  function revokeRecordUrls(record) {
    (record.images || []).forEach(function (im) {
      const u = imageUrls.get(im.id);
      if (u) { URL.revokeObjectURL(u); imageUrls.delete(im.id); }
    });
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(dataurl) {
    const parts = String(dataurl).split(',');
    const meta = parts[0].match(/:(.*?);base64/);
    const mime = meta ? meta[1] : 'image/jpeg';
    const bin = atob(parts[1]);
    const len = bin.length;
    const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function getRecord(id) {
    return records.find(function (r) { return r.id === id; });
  }

  /* ---------------- 地图初始化（纯色陆地 / 海洋，无瓦片无路线） ---------------- */
  function initMap() {
    map = L.map('map', {
      zoomControl: false,
      minZoom: 2,
      zoomSnap: 0,          // 连续缩放：最小档可精确匹配视口宽度
      zoomDelta: .5,
      maxBounds: [[-85, -180], [85, 180]],   // 限制在单幅世界内：任何地点画面中只出现一次
      maxBoundsViscosity: 1.0
    }).setView([28, 15], 2); // 全球视野（宽屏会自动抬升到恰好铺满一屏的最小缩放）

    // 动态最小缩放：保证「世界宽度 ≥ 视口宽度」，配合 ±180° 限界，
    // 任何地点在画面中都只显示一次（不会看到 ±360° 副本重复）
    function applyMinZoom() {
      const w = map.getSize().x || 1024;
      const mz = Math.max(2, Math.log2(w / 256));
      map.setMinZoom(mz);
      if (map.getZoom() < mz) map.setZoom(mz);
    }
    applyMinZoom();
    map.on('resize', applyMinZoom);

    // 缩放按钮移到右下角，避免遮挡左上角搜索面板
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

    regionLayer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);

    // 地名标注层（染色之上、照片标记之下）
    if (!map.getPane('labels')) {
      const p = map.createPane('labels');
      p.style.zIndex = 450;
      p.style.pointerEvents = 'none';
    }
    labelLayer = L.layerGroup().addTo(map);
    provLabelLayer = L.layerGroup().addTo(map);
    renderCountryLabels();
    renderProvLabels();

    // 缩放级别变化 → 切换底图分辨率、重算染色档位与地名标注
    map.on('zoomend', function () {
      renderBaseMap();
      renderBorders();
      renderAdminLines();
      renderRegions();
      renderCountryLabels();
      renderProvLabels();
    });
    // 平移结束 → 省/县级界线按视野刷新（视野过滤、县级随所在省切换）
    map.on('moveend', renderAdminLines);

    // 点击地图任意位置 → 新增记录（经度归一到主世界）
    map.on('click', function (e) {
      clearTempPoint();
      openForm(e.latlng.lat, wrapLng(e.latlng.lng), null);
    });

    // 鼠标经纬度
    const coordsEl = document.getElementById('coords');
    map.on('mousemove', function (e) {
      coordsEl.textContent = '经度 ' + wrapLng(e.latlng.lng).toFixed(4) +
        '，纬度 ' + e.latlng.lat.toFixed(4);
    });
    map.on('mouseout', function () { coordsEl.textContent = '经纬度：--'; });

    // 浏览器定位结果
    map.on('locationfound', function (e) {
      toast('已定位到当前位置（精度约 ' + Math.round(e.accuracy) + ' 米）');
    });
    map.on('locationerror', function () {
      toast('无法获取定位，请允许浏览器使用位置权限');
    });

    window.photoMap = map;   // 调试/测试用：暴露地图实例
  }

  /* ================================================================
   * 底图数据（世界国家边界）+ 行政区划染色
   * 粗视野 → 记录所在「省」整体染色；放大（约 10km 比例尺级别）→ 所在「市」染色；
   * 中国境外退回到「国家」染色。数据按需加载并缓存。
   * ================================================================ */
  const LAND_COLOR = '#cfe0ef';      // 陆地浅色（与深蓝海洋强对比）
  const COAST_COLOR = '#8fb3cf';     // 海岸线描边
  const BORDER_COLOR = '#7d9cba';    // 地区界限（国家间边界线）
  const PROV_BORDER_COLOR = '#93aecb';    // 省级界线（比国界浅细一级）
  const COUNTY_BORDER_COLOR = '#a9c0d8';  // 县级界线（最浅最细，虚线）

  const regionData = {
    landPromise: null,               // 整体陆地多边形 50m（放大后用，海岸线精细）
    landLowPromise: null,            // 整体陆地多边形 110m（低缩放用，高纬度干净）
    countriesPromise: null,          // 世界国家 GeoJSON（Natural Earth，TopoJSON）
    countryBordersHigh: null,        // 国家间边界线 MultiLineString（50m mesh，随 countriesPromise 缓存）
    bordersLowPromise: null,         // 国家间边界线（110m mesh，低缩放用）
    admin1Promise: null,             // 境外省级界线（Natural Earth 50m admin-1，[{feature,bbox}]）
    provCountiesPromises: new Map(), // 省adcode -> 全省县级 GeoJSON Promise（界线图层用）
    chinaProvincesPromise: null,     // 中国省级 GeoJSON（阿里云 DataV）
    cityPromises: new Map(),         // 省adcode -> 市级 GeoJSON Promise
    countyPromises: new Map(),       // 市adcode -> 区县级 GeoJSON Promise
    recCountry: new Map(),           // recId -> 国家区域
    recForeign: new Map(),           // recId -> 境外省/州级区域（Natural Earth admin-1）
    recProvince: new Map(),          // recId -> 省区域
    recCity: new Map(),              // recId -> 市区域
    recCounty: new Map()             // recId -> 县区域
  };

  let regionRenderToken = 0;

  function loadJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // 本地优先、CDN 兜底的资源加载：按顺序尝试，返回第一个成功的结果。
  // 断网或校园网屏蔽境外 CDN 时，仍能从 assets/vendor 拿到底图数据。
  const VENDOR = 'assets/vendor/';
  async function loadFirst(urls) {
    let lastErr = null;
    for (let i = 0; i < urls.length; i++) {
      try {
        return await loadJSON(urls[i]);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('资源加载失败');
  }

  // 构造「本地 → unpkg → jsdelivr」三级地址
  function vendorFirst(local, cdnPath) {
    return [
      VENDOR + local,
      'https://unpkg.com/' + cdnPath,
      'https://cdn.jsdelivr.net/npm/' + cdnPath
    ];
  }

  function inChina(lng, lat) {
    return lng >= 73 && lng <= 136 && lat >= 3 && lat <= 54;
  }

  // 射线法：点是否在环内
  function pointInRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // 点是否在（Multi）Polygon 内（含挖洞处理）
  function pointInGeometry(lng, lat, geom) {
    if (!geom) return false;
    if (geom.type === 'Polygon') {
      const rings = geom.coordinates;
      if (!pointInRing(lng, lat, rings[0])) return false;
      for (let k = 1; k < rings.length; k++) {
        if (pointInRing(lng, lat, rings[k])) return false;
      }
      return true;
    }
    if (geom.type === 'MultiPolygon') {
      const polys = geom.coordinates;
      for (let p = 0; p < polys.length; p++) {
        if (pointInRing(lng, lat, polys[p][0])) {
          let inHole = false;
          for (let k = 1; k < polys[p].length; k++) {
            if (pointInRing(lng, lat, polys[p][k])) { inHole = true; break; }
          }
          if (!inHole) return true;
        }
      }
    }
    return false;
  }

  function findFeature(lng, lat, fc) {
    const feats = (fc && fc.features) || [];
    // 展开后的环可能把跨反经线的陆地放到 ±180 之外，三个经度都试
    const lngs = [lng, lng + 360, lng - 360];
    for (let i = 0; i < feats.length; i++) {
      if (!feats[i].geometry) continue;
      for (let k = 0; k < lngs.length; k++) {
        if (pointInGeometry(lngs[k], lat, feats[i].geometry)) return feats[i];
      }
    }
    return null;
  }

  function ensureLand() {
    if (!regionData.landPromise) {
      regionData.landPromise = (async function () {
        try {
          const topo = await loadFirst(vendorFirst('world-atlas/land-50m.json', 'world-atlas@2/land-50m.json'));
          if (typeof topojson === 'undefined') throw new Error('topojson-client 未加载');
          return unwrapGeo(topojson.feature(topo, topo.objects.land));
        } catch (e) {
          console.error('陆地底图数据加载失败', e);
          return null;
        }
      })();
    }
    return regionData.landPromise;
  }

  // 低精度陆地（110m）：海岸线平滑、细碎岛屿少，低缩放（含北半球高纬度）海陆区分更干净
  function ensureLandLow() {
    if (!regionData.landLowPromise) {
      regionData.landLowPromise = (async function () {
        try {
          const topo = await loadFirst(vendorFirst('world-atlas/land-110m.json', 'world-atlas@2/land-110m.json'));
          if (typeof topojson === 'undefined') throw new Error('topojson-client 未加载');
          return unwrapGeo(topojson.feature(topo, topo.objects.land));
        } catch (e) {
          console.error('低精度陆地数据加载失败', e);
          return null;
        }
      })();
    }
    return regionData.landLowPromise;
  }

  function ensureCountries() {
    if (!regionData.countriesPromise) {
      regionData.countriesPromise = (async function () {
        try {
          const topo = await loadFirst(vendorFirst('world-atlas/countries-50m.json', 'world-atlas@2/countries-50m.json'));
          if (typeof topojson === 'undefined') throw new Error('topojson-client 未加载');
          const geo = unwrapGeo(topojson.feature(topo, topo.objects.countries));
          // 提取国家间共享边界线（不含海岸线），供「地区界限」图层使用
          regionData.countryBordersHigh = unwrapGeo(
            topojson.mesh(topo, topo.objects.countries, function (a, b) { return a !== b; })
          );
          return geo;
        } catch (e) {
          console.error('国家边界数据加载失败', e);
          return null;
        }
      })();
    }
    return regionData.countriesPromise;
  }

  // 低精度国家边界线（110m）：低缩放时轻量渲染地区界限
  function ensureBordersLow() {
    if (!regionData.bordersLowPromise) {
      regionData.bordersLowPromise = (async function () {
        try {
          const topo = await loadFirst(vendorFirst('world-atlas/countries-110m.json', 'world-atlas@2/countries-110m.json'));
          if (typeof topojson === 'undefined') throw new Error('topojson-client 未加载');
          return unwrapGeo(topojson.mesh(topo, topo.objects.countries, function (a, b) { return a !== b; }));
        } catch (e) {
          console.error('低精度边界线数据加载失败', e);
          return null;
        }
      })();
    }
    return regionData.bordersLowPromise;
  }

  function ensureChinaProvinces() {
    if (!regionData.chinaProvincesPromise) {
      regionData.chinaProvincesPromise = (async function () {
        try {
          return await loadFirst([
            VENDOR + 'datav/100000_full.json',
            'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json'
          ]);
        } catch (e) {
          console.error('省级行政区数据加载失败', e);
          toast('省级边界数据加载失败，境内将按国界染色');
          return null;
        }
      })();
    }
    return regionData.chinaProvincesPromise;
  }

  function ensureProvinceCities(adcode) {
    if (!regionData.cityPromises.has(adcode)) {
      regionData.cityPromises.set(adcode,
        loadJSON('https://geo.datav.aliyun.com/areas_v3/bound/' + adcode + '_full.json')
          .catch(function (e) {
            console.error('市级数据加载失败 ' + adcode, e);
            return null;
          })
      );
    }
    return regionData.cityPromises.get(adcode);
  }

  async function resolveCountryRegion(rec) {
    if (regionData.recCountry.has(rec.id)) return regionData.recCountry.get(rec.id);
    let result = null;
    const fc = await ensureCountries();
    if (fc) {
      const f = findFeature(rec.lng, rec.lat, fc);
      if (f) {
        result = { key: 'c:' + ((f.properties && f.properties.name) || f.id), feature: f };
      }
    }
    regionData.recCountry.set(rec.id, result);
    return result;
  }

  async function resolveProvinceRegion(rec) {
    if (!inChina(rec.lng, rec.lat)) return null;
    if (regionData.recProvince.has(rec.id)) return regionData.recProvince.get(rec.id);
    let result = null;
    const fc = await ensureChinaProvinces();
    if (fc) {
      const f = findFeature(rec.lng, rec.lat, fc);
      if (f) {
        result = { key: 'p:' + f.properties.adcode, adcode: f.properties.adcode, feature: f };
      }
    }
    regionData.recProvince.set(rec.id, result);
    return result;
  }

  async function resolveCityRegion(rec, provAdcode) {
    if (regionData.recCity.has(rec.id)) return regionData.recCity.get(rec.id);
    let result = null;
    const fc = await ensureProvinceCities(provAdcode);
    if (fc) {
      const f = findFeature(rec.lng, rec.lat, fc);
      if (f) {
        result = {
          key: 'ct:' + f.properties.adcode,
          adcode: f.properties.adcode,
          level: f.properties.level || 'city',   // 直辖市的市级文件 features 是 level='district'
          feature: f
        };
      }
    }
    regionData.recCity.set(rec.id, result);
    return result;
  }

  function ensureCityCounties(cityAdcode) {
    if (!regionData.countyPromises.has(cityAdcode)) {
      regionData.countyPromises.set(cityAdcode,
        loadJSON('https://geo.datav.aliyun.com/areas_v3/bound/' + cityAdcode + '_full.json')
          .catch(function (e) {
            console.error('区县数据加载失败 ' + cityAdcode, e);
            return null;
          })
      );
    }
    return regionData.countyPromises.get(cityAdcode);
  }

  async function resolveCountyRegion(rec, cityAdcode) {
    if (regionData.recCounty.has(rec.id)) return regionData.recCounty.get(rec.id);
    let result = null;
    const fc = await ensureCityCounties(cityAdcode);
    if (fc) {
      const f = findFeature(rec.lng, rec.lat, fc);
      if (f) {
        result = { key: 'd:' + f.properties.adcode, feature: f };
      }
    }
    regionData.recCounty.set(rec.id, result);
    return result;
  }

  /* ---------------- 变色尺度（面积统一体量分级） ----------------
   * 极限大尺度 = 国家，极限小尺度 = 镇。
   * 档位：1 国家 / 2 省≈15万km² / 3 市≈1.5万km² / 4 县≈2千km² / 5 镇≈250km²
   * 境内 2/3/4 档用真实行政边界；境外无行政数据、以及 5 档全球，
   * 用「等面积圆」补齐同一视觉体量（半径 = sqrt(面积/π)）。
   * ================================================================ */
  const SCALE_CIRCLE_M = { 1: 500000, 2: 219000, 3: 69000, 4: 25000, 5: 9000 };

  function autoScaleByZoom(z) {
    if (z <= 3) return 1;   // 国家
    if (z <= 6) return 2;   // 省 / 州
    if (z <= 8) return 3;   // 市
    if (z <= 10) return 4;  // 县 / 区
    return 5;               // 镇
  }

  function effectiveScale(rec) {
    return (rec.scale === 'auto' || [1, 2, 3, 4, 5].indexOf(rec.scale) === -1)
      ? autoScaleByZoom(map.getZoom())
      : rec.scale;
  }

  // 境内 2/3/4 档解析真实行政边界；1/5 档或境外返回 null（由等面积圆兜底）
  async function resolveAdminRegion(rec, scale) {
    if (scale < 2 || scale > 4 || !inChina(rec.lng, rec.lat)) return null;
    const prov = await resolveProvinceRegion(rec);
    if (!prov) return null;
    if (scale === 2) return prov;
    const city = await resolveCityRegion(rec, prov.adcode);
    if (!city) return prov;
    // 直辖市：市级文件就是区县（level='district'）——市档回退省界，县档直接用
    if (city.level === 'district') return scale === 3 ? prov : city;
    if (scale === 3) return city;
    const county = await resolveCountyRegion(rec, city.adcode);
    return county || city;
  }

  // 境外 2/3/4 档：解析所在国家的一级行政区（省/州）真实边界，与中国省档同效果。
  // 小国无一级行政区时回落国家；仍无则 null（等面积圆兜底）。
  async function resolveForeignRegion(rec) {
    if (regionData.recForeign.has(rec.id)) return regionData.recForeign.get(rec.id);
    let result = null;
    const list = await ensureAdmin1Foreign();
    if (list) {
      const lngs = [rec.lng, rec.lng + 360, rec.lng - 360];
      outer:
      for (const it of list) {
        const b = it.bbox;
        if (!b) continue;
        for (let k = 0; k < lngs.length; k++) {
          const lng = lngs[k];
          if (b[0] <= lng && b[2] >= lng && b[1] <= rec.lat && b[3] >= rec.lat &&
              pointInGeometry(lng, rec.lat, it.feature.geometry)) {
            const pr = it.feature.properties || {};
            result = { key: 'a1:' + (pr.name_en || pr.name || pr.iso_3166_2 || ''), feature: it.feature };
            break outer;
          }
        }
      }
    }
    if (!result) result = await resolveCountryRegion(rec);
    regionData.recForeign.set(rec.id, result);
    return result;
  }

  /* ---------------- 地名标注 ----------------
   * 全球视野（z≤3）只显示面积较大的国家，z≥4 显示全部国家名；
   * z≥7 境内追加省名。国家名用中文（Intl.DisplayNames），副本世界同步显示。
   * ================================================================ */
  let zhRegionNames = null;
  try { zhRegionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' }); } catch (e) {}

  // ISO 3166-1 数字码 → 中文国名（部分浏览器环境 Intl.DisplayNames 缺少 region 数据，内置兜底）
  const COUNTRY_ZH = {
    '004':'阿富汗','008':'阿尔巴尼亚','010':'南极洲','012':'阿尔及利亚','016':'美属萨摩亚','020':'安道尔',
    '024':'安哥拉','028':'安提瓜和巴布达','031':'阿塞拜疆','032':'阿根廷','036':'澳大利亚','040':'奥地利',
    '044':'巴哈马','048':'巴林','050':'孟加拉国','051':'亚美尼亚','052':'巴巴多斯','056':'比利时',
    '060':'百慕大','064':'不丹','068':'玻利维亚','070':'波黑','072':'博茨瓦纳','074':'布韦岛','076':'巴西',
    '084':'伯利兹','086':'英属印度洋领地','090':'所罗门群岛','092':'英属维尔京群岛','096':'文莱',
    '100':'保加利亚','104':'缅甸','108':'布隆迪','112':'白俄罗斯','116':'柬埔寨','120':'喀麦隆','124':'加拿大',
    '132':'佛得角','136':'开曼群岛','140':'中非','144':'斯里兰卡','148':'乍得','152':'智利','156':'中国',
    '158':'台湾','162':'圣诞岛','166':'科科斯群岛','170':'哥伦比亚','174':'科摩罗','175':'马约特',
    '178':'刚果（布）','180':'刚果（金）','184':'库克群岛','188':'哥斯达黎加','191':'克罗地亚','192':'古巴',
    '196':'塞浦路斯','203':'捷克','204':'贝宁','208':'丹麦','212':'多米尼克','214':'多米尼加','218':'厄瓜多尔',
    '222':'萨尔瓦多','226':'赤道几内亚','231':'埃塞俄比亚','232':'厄立特里亚','233':'爱沙尼亚','234':'法罗群岛',
    '238':'福克兰群岛','239':'南乔治亚群岛','242':'斐济','246':'芬兰','248':'奥兰群岛','250':'法国',
    '254':'法属圭亚那','258':'法属波利尼西亚','260':'法属南部领地','262':'吉布提','266':'加蓬','268':'格鲁吉亚',
    '270':'冈比亚','275':'巴勒斯坦','276':'德国','288':'加纳','292':'直布罗陀','296':'基里巴斯','300':'希腊',
    '304':'格陵兰','308':'格林纳达','312':'瓜德罗普','316':'关岛','320':'危地马拉','324':'几内亚','328':'圭亚那',
    '332':'海地','334':'赫德岛','336':'梵蒂冈','340':'洪都拉斯','344':'中国香港','348':'匈牙利','352':'冰岛',
    '356':'印度','360':'印度尼西亚','364':'伊朗','368':'伊拉克','372':'爱尔兰','376':'以色列','380':'意大利',
    '384':'科特迪瓦','388':'牙买加','392':'日本','398':'哈萨克斯坦','400':'约旦','404':'肯尼亚','408':'朝鲜',
    '410':'韩国','414':'科威特','417':'吉尔吉斯斯坦','418':'老挝','422':'黎巴嫩','426':'莱索托','428':'拉脱维亚',
    '430':'利比里亚','434':'利比亚','438':'列支敦士登','440':'立陶宛','442':'卢森堡','446':'中国澳门',
    '450':'马达加斯加','454':'马拉维','458':'马来西亚','462':'马尔代夫','466':'马里','470':'马耳他',
    '474':'马提尼克','478':'毛里塔尼亚','480':'毛里求斯','484':'墨西哥','492':'摩纳哥','496':'蒙古',
    '498':'摩尔多瓦','499':'黑山','500':'蒙特塞拉特','504':'摩洛哥','508':'莫桑比克','512':'阿曼',
    '516':'纳米比亚','520':'瑙鲁','524':'尼泊尔','528':'荷兰','531':'荷属加勒比区','533':'阿鲁巴',
    '534':'荷属圣马丁','540':'新喀里多尼亚','548':'瓦努阿图','554':'新西兰','558':'尼加拉瓜','562':'尼日尔',
    '566':'尼日利亚','570':'纽埃','574':'诺福克岛','578':'挪威','580':'北马里亚纳群岛','581':'美国本土外小岛屿',
    '583':'密克罗尼西亚','584':'马绍尔群岛','585':'帕劳','586':'巴基斯坦','591':'巴拿马','598':'巴布亚新几内亚',
    '600':'巴拉圭','604':'秘鲁','608':'菲律宾','612':'皮特凯恩','616':'波兰','620':'葡萄牙','624':'几内亚比绍',
    '626':'东帝汶','630':'波多黎各','634':'卡塔尔','638':'留尼汪','642':'罗马尼亚','643':'俄罗斯','646':'卢旺达',
    '652':'圣巴泰勒米','654':'圣赫勒拿','659':'圣基茨和尼维斯','660':'安圭拉','662':'圣卢西亚',
    '663':'法属圣马丁','666':'圣皮埃尔和密克隆','670':'圣文森特和格林纳丁斯','674':'圣马力诺',
    '678':'圣多美和普林西比','682':'沙特阿拉伯','686':'塞内加尔','688':'塞尔维亚','690':'塞舌尔',
    '694':'塞拉利昂','702':'新加坡','703':'斯洛伐克','704':'越南','705':'斯洛文尼亚','706':'索马里',
    '710':'南非','716':'津巴布韦','724':'西班牙','728':'南苏丹','729':'苏丹','732':'西撒哈拉','740':'苏里南',
    '744':'斯瓦尔巴群岛','748':'斯威士兰','752':'瑞典','756':'瑞士','760':'叙利亚','762':'塔吉克斯坦',
    '764':'泰国','768':'多哥','776':'托克劳','780':'汤加','784':'阿联酋','788':'突尼斯','792':'土耳其',
    '795':'土库曼斯坦','796':'特克斯和凯科斯群岛','798':'图瓦卢','800':'乌干达','804':'乌克兰',
    '807':'北马其顿','818':'埃及','826':'英国','831':'根西岛','832':'泽西岛','833':'马恩岛','834':'坦桑尼亚',
    '840':'美国','850':'美属维尔京群岛','854':'布基纳法索','858':'乌拉圭','860':'乌兹别克斯坦',
    '862':'委内瑞拉','876':'瓦利斯和富图纳','882':'萨摩亚','887':'也门','894':'赞比亚'
  };

  function countryNameOf(f) {
    if (f.id != null) {
      const key = ('00' + String(f.id)).slice(-3);   // 数字/短码统一补齐为 3 位
      if (COUNTRY_ZH[key]) return COUNTRY_ZH[key];
      if (zhRegionNames) {
        try {
          const n = zhRegionNames.of(String(f.id));
          if (n && n !== String(f.id)) return n;
        } catch (e) {}
      }
    }
    return (f.properties && f.properties.name) || '';
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 取最大环（主岛/本土）顶点均值作为标注点，附 bbox 面积（度²）用于低缩放过滤
  function labelPoint(geom) {
    let best = null;
    if (geom && geom.type === 'Polygon') best = geom.coordinates[0];
    else if (geom && geom.type === 'MultiPolygon') {
      geom.coordinates.forEach(function (poly) {
        if (!best || poly[0].length > best.length) best = poly[0];
      });
    }
    if (!best || best.length < 4) return null;
    let sx = 0, sy = 0, minx = 180, maxx = -180, miny = 90, maxy = -90;
    best.forEach(function (c) {
      sx += c[0]; sy += c[1];
      if (c[0] < minx) minx = c[0];
      if (c[0] > maxx) maxx = c[0];
      if (c[1] < miny) miny = c[1];
      if (c[1] > maxy) maxy = c[1];
    });
    return { pt: [sx / best.length, sy / best.length], area: (maxx - minx) * (maxy - miny) };
  }

  function addLabel(layer, lat, lng, text, cls) {
    L.marker([lat, lng], {
      pane: 'labels',
      interactive: false,
      icon: L.divIcon({
        className: 'geo-label-wrap',
        html: '<span class="geo-label ' + cls + '">' + escHtml(text) + '</span>',
        iconSize: null
      })
    }).addTo(layer);
  }

  let countryLabelState = null;    // null | 'few' | 'all'
  let countryLabelToken = 0;
  async function renderCountryLabels() {
    if (!map) return;
    const mode = map.getZoom() <= 3 ? 'few' : 'all';
    if (countryLabelState === mode) return;
    const token = ++countryLabelToken;
    const fc = await ensureCountries();
    if (!fc || token !== countryLabelToken) return;
    countryLabelState = mode;
    labelLayer.clearLayers();
    fc.features.forEach(function (f) {
      const lp = labelPoint(f.geometry);
      if (!lp || (mode === 'few' && lp.area < 40)) return;
      const name = countryNameOf(f);
      if (!name) return;
      SHIFTS.forEach(function (dx) {
        addLabel(labelLayer, lp.pt[1], lp.pt[0] + dx, name, 'geo-label-country');
      });
    });
  }

  let provLabelShown = false;
  async function renderProvLabels() {
    if (!map) return;
    const show = map.getZoom() >= 7;
    if (provLabelShown === show) return;
    provLabelShown = show;
    provLabelLayer.clearLayers();
    if (!show) return;
    const fc = await ensureChinaProvinces();
    if (!fc || map.getZoom() < 7) return;
    fc.features.forEach(function (f) {
      const pr = f.properties || {};
      const pt = pr.centroid || pr.center;
      if (!pt || !pr.name) return;
      addLabel(provLabelLayer, pt[1], pt[0], pr.name, 'geo-label-prov');
    });
  }

  let baseLayer = null;            // 底图图层组（随缩放在 110m / 50m 间切换）
  let baseRes = null;              // 当前底图分辨率 'low' | 'high'
  let baseToken = 0;

  // 底图（整体陆地多边形，浅色填充 / 深蓝海洋背景）+ 首次染色
  // 陆地放入独立低层 pane，避免异步加载后 DOM 顺序盖住染色区域；
  // 渲染 ±360° 世界副本，实现左右无缝环绕（美国与俄罗斯相邻同屏）。
  // 分辨率自适应：z≤3（全球视野，含北半球高纬度）用 110m 数据，海岸线平滑无碎屑；
  // z≥4 切换 50m 数据并保留海岸线描边，地区界限清晰。
  async function renderBaseMap() {
    if (!map) return;
    const want = map.getZoom() <= 3 ? 'low' : 'high';
    if (baseRes === want) return;
    const token = ++baseToken;
    const land = await (want === 'low' ? ensureLandLow() : ensureLand());
    if (!land || token !== baseToken) return;
    baseRes = want;
    if (baseLayer) map.removeLayer(baseLayer);
    if (!map.getPane('basemap')) {
      const p = map.createPane('basemap');
      p.style.zIndex = 250;              // tilePane(200) 之上、overlayPane(400) 之下
      p.style.pointerEvents = 'none';
    }
    baseLayer = L.layerGroup().addTo(map);
    SHIFTS.forEach(function (dx) {
      L.geoJSON(shiftGeo(land, dx), {
        pane: 'basemap',
        style: want === 'low'
          ? { color: LAND_COLOR, weight: 1, fillColor: LAND_COLOR, fillOpacity: 1, interactive: false }   // 低缩放：同色描边掩盖缝隙，视觉干净
          : { color: COAST_COLOR, weight: 1, fillColor: LAND_COLOR, fillOpacity: 1, interactive: false },  // 放大：海岸线描边
        interactive: false,
        attribution: '底图 © Natural Earth · 行政区划 © 阿里云 DataV'
      }).addTo(baseLayer);
    });
  }

  function initBaseMap() {
    renderBaseMap();
    renderBorders();
    renderAdminLines();
    renderRegions();
  }

  /* ---------------- 地区界限图层（国家间边界线，独立于海岸线） ---------------- */
  function ensureBordersPane() {
    if (!map.getPane('borders')) {
      const p = map.createPane('borders');
      p.style.zIndex = 300;              // 底图(250)之上、染色(400)之下
      p.style.pointerEvents = 'none';
    }
  }
  let borderLayer = null, borderRes = null, borderToken = 0;
  async function renderBorders() {
    if (!map) return;
    const want = map.getZoom() <= 3 ? 'low' : 'high';
    if (borderRes === want) return;
    const token = ++borderToken;
    let lines = null;
    if (want === 'low') {
      lines = await ensureBordersLow();
      if (!lines) lines = regionData.countryBordersHigh;   // 110m 失败时回退 50m（若已缓存）
    } else {
      await ensureCountries();                              // 加载并缓存 50m 边界线
      lines = regionData.countryBordersHigh;
    }
    if (!lines || token !== borderToken) return;
    borderRes = want;
    if (borderLayer) map.removeLayer(borderLayer);
    ensureBordersPane();
    borderLayer = L.layerGroup().addTo(map);
    SHIFTS.forEach(function (dx) {
      L.geoJSON(shiftGeo(lines, dx), {
        pane: 'borders',
        style: { color: BORDER_COLOR, weight: 1, opacity: .9, fill: false },
        interactive: false
      }).addTo(borderLayer);
    });
  }

  /* ---------------- 省/县级界线（至少省级、至多县级） ----------------
   * z4-8 在国界之上追加省级界线：境内用 DataV 省界；境外用 Natural Earth
   * 50m admin-1（按视野过滤，三个世界副本任一命中即保留）。
   * z≥9 再追加县级界线：境内按视野中心所在省加载全省区县并缓存；
   * 境外无县级行政数据，止步于省级。至多县级，不再向乡镇下钻。
   * ================================================================== */
  let provBorderLayer = null, countyBorderLayer = null, adminToken = 0;

  // 几何包围盒 [minLng, minLat, maxLng, maxLat]
  function bboxOfGeometry(geom) {
    let minX = 180, minY = 90, maxX = -180, maxY = -90, found = false;
    (function walk(c) {
      if (!c) return;
      if (typeof c[0] === 'number') {
        found = true;
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
        return;
      }
      for (let i = 0; i < c.length; i++) walk(c[i]);
    })(geom && geom.coordinates);
    return found ? [minX, minY, maxX, maxY] : null;
  }

  // 要素是否落在当前视野（考虑三个世界副本：要素在任一副本命中即保留）
  function bboxHitCopies(bbox, bounds) {
    if (!bbox) return true;
    const s = bounds.getSouth(), n = bounds.getNorth();
    for (let i = 0; i < SHIFTS.length; i++) {
      const dx = SHIFTS[i];
      const w = bounds.getWest() - dx, e = bounds.getEast() - dx;
      if (bbox[0] <= e && bbox[2] >= w && bbox[1] <= n && bbox[3] >= s) return true;
    }
    return false;
  }

  // 境外省级界线（Natural Earth 50m admin-1）：预 unwrap 并计算包围盒
  function ensureAdmin1Foreign() {
    if (!regionData.admin1Promise) {
      regionData.admin1Promise = (async function () {
        const urls = [
          // jsDelivr 在国内可达性优于 raw.githubusercontent，放第一位
          'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_50m_admin_1_states_provinces.geojson',
          'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces.geojson'
        ];
        for (const url of urls) {
          try {
            const fc = await loadJSON(url);
            const list = [];
            for (const f of (fc.features || [])) {
              const pr = f.properties || {};
              const admin = String(pr.admin || '').toLowerCase();
              if (admin === 'china' || pr.geonunit === 'CHN') continue;  // 境内用 DataV 省界，避免重复
              if (pr.type === 'Water') continue;                         // 水面要素不画界线
              const g = unwrapGeo(f);
              list.push({ feature: g, bbox: bboxOfGeometry(g.geometry) });
            }
            return list;
          } catch (e) { /* 尝试下一个数据源 */ }
        }
        console.error('境外省级界线数据加载失败');
        return null;
      })();
    }
    return regionData.admin1Promise;
  }

  // 全省县级界线：省级 _full（地市）逐市取区县合并；直辖市省级文件即区县级
  function ensureProvinceCounties(provAdcode) {
    if (!regionData.provCountiesPromises.has(provAdcode)) {
      regionData.provCountiesPromises.set(provAdcode, (async function () {
        const cities = await ensureProvinceCities(provAdcode);
        if (!cities || !cities.features || !cities.features.length) return null;
        if (cities.features.some(function (f) {
          return f.properties && f.properties.level === 'district';
        })) return unwrapGeo(cities);
        const parts = await Promise.all(cities.features.map(function (f) {
          return ensureCityCounties(f.properties.adcode).catch(function () { return null; });
        }));
        const feats = [];
        parts.forEach(function (p) { if (p && p.features) feats.push.apply(feats, p.features); });
        return feats.length ? unwrapGeo({ type: 'FeatureCollection', features: feats }) : null;
      })());
    }
    return regionData.provCountiesPromises.get(provAdcode);
  }

  async function renderAdminLines() {
    if (!map) return;
    const token = ++adminToken;
    const zoom = map.getZoom();

    // 缩出省级档（z<4）：两级界线全部撤除
    if (zoom < 4) {
      if (provBorderLayer) { map.removeLayer(provBorderLayer); provBorderLayer = null; }
      if (countyBorderLayer) { map.removeLayer(countyBorderLayer); countyBorderLayer = null; }
      return;
    }

    // —— 省级界线（z≥4）：加载期间保留旧图层，就绪后整体替换 ——
    const bounds = map.getBounds();
    const china = await ensureChinaProvinces();
    const foreign = await ensureAdmin1Foreign();
    if (token !== adminToken) return;
    if (provBorderLayer) { map.removeLayer(provBorderLayer); provBorderLayer = null; }
    const provFeats = [];
    ((china && china.features) || []).forEach(function (f) { if (f.geometry) provFeats.push(f); });
    (foreign || []).forEach(function (it) {
      if (bboxHitCopies(it.bbox, bounds)) provFeats.push(it.feature);
    });
    if (provFeats.length) {
      ensureBordersPane();
      provBorderLayer = L.layerGroup().addTo(map);
      const provFc = { type: 'FeatureCollection', features: provFeats };
      SHIFTS.forEach(function (dx) {
        L.geoJSON(shiftGeo(provFc, dx), {
          pane: 'borders',
          style: { color: PROV_BORDER_COLOR, weight: .8, opacity: .8, fill: false },
          interactive: false
        }).addTo(provBorderLayer);
      });
    }

    // —— 县级界线（z≥9，境内）：缩出县档立即撤除 ——
    if (zoom < 9) {
      if (countyBorderLayer) { map.removeLayer(countyBorderLayer); countyBorderLayer = null; }
      return;
    }
    const c = map.getCenter();
    const lng = wrapLng(c.lng), lat = c.lat;
    let countyFc = null;
    if (inChina(lng, lat)) {
      const provFcAll = china || await ensureChinaProvinces();
      const prov = provFcAll ? findFeature(lng, lat, provFcAll) : null;
      if (prov) countyFc = await ensureProvinceCounties(prov.properties.adcode);
    }
    if (token !== adminToken) return;
    if (countyBorderLayer) { map.removeLayer(countyBorderLayer); countyBorderLayer = null; }
    if (countyFc) {
      ensureBordersPane();
      countyBorderLayer = L.layerGroup().addTo(map);
      SHIFTS.forEach(function (dx) {
        L.geoJSON(shiftGeo(countyFc, dx), {
          pane: 'borders',
          style: { color: COUNTY_BORDER_COLOR, weight: .6, opacity: .7, dashArray: '2 3', fill: false },
          interactive: false
        }).addTo(countyBorderLayer);
      });
    }
  }

  // 渲染染色区域：每条记录按自己的「变色尺度」解析（跟随缩放的记录按当前缩放换算档位）。
  // 多记录落在同一区域时取最新记录（records 按时间倒序在前）的颜色。
  async function renderRegions() {
    if (!map) return;
    const token = ++regionRenderToken;
    regionLayer.clearLayers();
    if (!records.length) return;

    const zoom = map.getZoom();
    const painted = [];
    for (const rec of records) {
      const scale = effectiveScale(rec);
      let region = null;
      try {
        if (scale === 1) {
          region = await resolveCountryRegion(rec);
        } else if (scale <= 4) {
          if (inChina(rec.lng, rec.lat)) {
            region = await resolveAdminRegion(rec, scale);   // 境内：省/市/县真实行政边界
          } else {
            region = await resolveForeignRegion(rec);        // 境外：省/州真实边界（与中国同效果）
          }
        }
      } catch (e) { region = null; }
      if (region && region.feature) {
        painted.push({
          key: 's' + scale + ':' + region.key,
          feature: region.feature,
          color: recColor(rec)
        });
      } else {
        // 境外 / 无边界数据（如海上）：等面积圆，保证全球变色体量统一
        painted.push({
          key: 'cir:' + rec.id,
          circleM: SCALE_CIRCLE_M[scale],
          lat: rec.lat, lng: rec.lng,
          color: recColor(rec)
        });
      }
    }

    if (token !== regionRenderToken) return; // 期间缩放已变化，放弃过期渲染
    const seen = new Set();
    painted.forEach(function (r) {
      if (seen.has(r.key)) return;
      seen.add(r.key);
      const style = {
        color: r.color,
        weight: 1.5,
        opacity: .9,
        fillColor: r.color,
        fillOpacity: .5,
        interactive: false
      };
      // 每个区域同步渲染 ±360° 世界副本，环绕浏览时染色不消失
      SHIFTS.forEach(function (dx) {
        if (r.circleM) {
          L.circle([r.lat, r.lng + dx], Object.assign({ radius: r.circleM }, style)).addTo(regionLayer);
        } else {
          L.geoJSON(shiftedFeature(r.feature, r.key, dx), { style: style }).addTo(regionLayer);
        }
      });
    });
  }

  const shiftCache = new Map();    // 染色区域世界副本缓存（key:dx -> 平移后的 feature）
  function shiftedFeature(feature, key, dx) {
    if (!dx) return feature;
    const k = key + ':' + dx;
    if (!shiftCache.has(k)) shiftCache.set(k, shiftGeo(feature, dx));
    return shiftCache.get(k);
  }

  /* ---------------- 标记：彩色区域 + 照片缩略图 ---------------- */
  function addMarker(record) {
    const color = recColor(record);
    const group = L.layerGroup();

    // 照片缩略图标记（右上角角标显示照片总数；无图则显示分类色圆点）
    const count = (record.images || []).length;
    let icon;
    if (count) {
      icon = L.divIcon({
        className: 'photo-pin',
        html: '<div class="photo-pin-frame" style="border-color:' + color + '">' +
          '<img src="' + getImageUrl(record.images[0]) + '" alt=""></div>' +
          '<span class="pin-count" style="background:' + color + '">' + count + '</span>',
        iconSize: [46, 46],
        iconAnchor: [23, 23]
      });
    } else {
      icon = L.divIcon({
        className: 'photo-pin',
        html: '<div class="photo-pin-dot" style="background:' + color + '">📍</div>',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
    }

    // 每个标记同步渲染 ±360° 世界副本
    SHIFTS.forEach(function (dx) {
      // 彩色光圈（提示精确位置，行政区划已整体染色）
      const area = L.circleMarker([record.lat, record.lng + dx], {
        radius: 20,
        stroke: true,
        color: color,
        weight: 1.5,
        opacity: .5,
        fillColor: color,
        fillOpacity: .18
      });
      area.on('click', function (e) {
        L.DomEvent.stopPropagation(e.originalEvent);
        openJournal(record.id);
      });
      group.addLayer(area);

      const m = L.marker([record.lat, record.lng + dx], { icon: icon, riseOnHover: true });
      m.bindTooltip(record.title || '未命名记录', { direction: 'top', offset: [0, -26] });
      m.on('click', function () { openJournal(record.id); });
      group.addLayer(m);
    });

    group.addTo(markerLayer);
    markers.set(record.id, group);
  }

  function removeMarker(id) {
    const group = markers.get(id);
    if (group) {
      markerLayer.removeLayer(group);
      markers.delete(id);
    }
  }

  function flyToRecord(record, open) {
    map.flyTo([record.lat, record.lng], Math.max(map.getZoom(), 12), { duration: .8 });
    if (open) {
      setTimeout(function () { openJournal(record.id, 0); }, 850);
    }
  }

  /* ================================================================
   * 旅行日志详情视图（点击缩略图 / 侧边栏记录打开）
   * ================================================================ */
  const journal = document.getElementById('journal');
  const jpImg = document.getElementById('jp-img');
  const jpPrev = document.getElementById('jp-prev');
  const jpNext = document.getElementById('jp-next');
  const jpCount = document.getElementById('jp-count');
  const jpEmpty = document.getElementById('jp-empty');
  const jpStrip = document.getElementById('jp-strip');

  function openJournal(recId, imgIdx) {
    const rec = getRecord(recId);
    if (!rec) return;
    journalState = { recId: recId, imgIdx: 0 };

    const color = recColor(rec);

    document.getElementById('ji-cat-dot').style.background = color;
    document.getElementById('ji-cat-name').textContent = recCategory(rec);
    document.getElementById('ji-date').textContent = fmtDateBig(rec.timestamp);
    document.getElementById('ji-title').textContent = rec.title || '未命名记录';
    document.getElementById('ji-meta').textContent =
      '⏱ ' + fmtClock(rec.timestamp) + '　📍 纬度 ' + rec.lat.toFixed(5) +
      '，经度 ' + rec.lng.toFixed(5);

    const noteEl = document.getElementById('ji-note');
    noteEl.textContent = rec.note || '（这一次旅行还没有写下故事……）';
    noteEl.classList.toggle('ji-note-empty', !rec.note);

    // 按时间线上一篇 / 下一篇
    const idx = records.findIndex(function (r) { return r.id === recId; });
    const prevBtn = document.getElementById('ji-prev-rec');
    const nextBtn = document.getElementById('ji-next-rec');
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx < 0 || idx >= records.length - 1;
    prevBtn.onclick = function () { if (idx > 0) openJournal(records[idx - 1].id, 0); };
    nextBtn.onclick = function () {
      if (idx >= 0 && idx < records.length - 1) openJournal(records[idx + 1].id, 0);
    };

    document.getElementById('ji-edit').onclick = function () {
      closeJournal();
      openForm(rec.lat, rec.lng, rec);
    };
    document.getElementById('ji-del').onclick = function () { deleteRecord(rec.id); };

    renderJournalPhotos(rec, color, typeof imgIdx === 'number' ? imgIdx : 0);
    journal.classList.remove('hidden');
  }

  function renderJournalPhotos(rec, color, idx) {
    const imgs = rec.images || [];
    const has = imgs.length > 0;
    const multi = has && imgs.length > 1;
    if (idx >= imgs.length) idx = 0;
    if (journalState) journalState.imgIdx = idx;

    jpImg.classList.toggle('hidden', !has);
    jpEmpty.classList.toggle('hidden', has);
    jpPrev.classList.toggle('hidden', !multi);
    jpNext.classList.toggle('hidden', !multi);
    jpCount.classList.toggle('hidden', !multi);
    jpStrip.classList.toggle('hidden', !has);

    if (has) {
      jpImg.src = getImageUrl(imgs[idx]);
      jpCount.textContent = (idx + 1) + ' / ' + imgs.length;
      jpPrev.onclick = function () {
        renderJournalPhotos(rec, color, (idx - 1 + imgs.length) % imgs.length);
      };
      jpNext.onclick = function () {
        renderJournalPhotos(rec, color, (idx + 1) % imgs.length);
      };
    }

    // 底部缩略图条
    jpStrip.innerHTML = '';
    imgs.forEach(function (im, i) {
      const t = document.createElement('img');
      t.src = getImageUrl(im);
      t.className = 'jp-thumb' + (i === idx ? ' active' : '');
      t.style.borderColor = color;
      t.onclick = function () { renderJournalPhotos(rec, color, i); };
      jpStrip.appendChild(t);
    });
  }

  function closeJournal() {
    journal.classList.add('hidden');
    journalState = null;
  }

  journal.addEventListener('click', function (e) {
    if (e.target === journal) closeJournal();
  });
  document.getElementById('journal-close').addEventListener('click', closeJournal);

  /* ---------------- 侧边栏列表 ---------------- */
  function renderList() {
    const listEl = document.getElementById('record-list');
    listEl.innerHTML = '';

    if (!records.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '🗺<br>还没有任何记录<br>点击地图开始标记你的足迹';
      listEl.appendChild(empty);
      return;
    }

    records.forEach(function (rec) {
      const color = recColor(rec);
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'rec-item';
      item.style.borderLeft = '3px solid ' + color;

      const thumb = document.createElement('div');
      thumb.className = 'rec-thumb' + (rec.images && rec.images.length ? '' : ' no-img');
      if (rec.images && rec.images.length) {
        const im = document.createElement('img');
        im.style.width = '100%';
        im.style.height = '100%';
        im.style.objectFit = 'cover';
        im.style.borderRadius = '8px';
        im.src = getImageUrl(rec.images[0]);
        thumb.appendChild(im);
      } else {
        thumb.textContent = '📍';
      }

      const meta = document.createElement('div');
      meta.className = 'rec-meta';

      const title = document.createElement('div');
      title.className = 'rec-title';
      const dot = document.createElement('span');
      dot.className = 'rec-title-dot';
      dot.style.background = color;
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = rec.title || '未命名记录';
      title.appendChild(dot);
      title.appendChild(t);

      const time = document.createElement('div');
      time.className = 'rec-time';
      time.textContent = '🕑 ' + fmtTime(rec.timestamp) + ' · ';
      const cat = document.createElement('span');
      cat.style.color = color;
      cat.textContent = recCategory(rec);
      time.appendChild(cat);

      const note = document.createElement('div');
      note.className = 'rec-note';
      note.textContent = rec.note || '纬度 ' + rec.lat.toFixed(3) + '，经度 ' + rec.lng.toFixed(3);

      meta.appendChild(title);
      meta.appendChild(time);
      meta.appendChild(note);
      item.appendChild(thumb);
      item.appendChild(meta);

      item.onclick = function () {
        flyToRecord(rec, true);
        document.getElementById('sidebar').classList.remove('open');
      };

      listEl.appendChild(item);
    });
  }

  /* ================================================================
   * 分类图例（左下角，可折叠，点击跳转到该分类最新一条记录）
   * ================================================================ */
  const legendEl = document.getElementById('legend');
  const legendList = document.getElementById('legend-list');
  let legendOpen = window.innerWidth > 760;

  function updateLegend() {
    legendEl.classList.toggle('collapsed', !legendOpen);
    document.getElementById('legend-caret').textContent = legendOpen ? '▾' : '▸';
  }

  function renderLegend() {
    legendList.innerHTML = '';
    const groups = new Map();
    records.forEach(function (rec) {
      const name = recCategory(rec);
      if (!groups.has(name)) {
        groups.set(name, { color: recColor(rec), count: 0, rec: rec });
      }
      groups.get(name).count++;
    });

    if (!groups.size) {
      const empty = document.createElement('div');
      empty.className = 'legend-empty';
      empty.textContent = '暂无分类，先去添加记录吧';
      legendList.appendChild(empty);
      return;
    }

    groups.forEach(function (g, name) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'legend-item';

      const dot = document.createElement('span');
      dot.className = 'legend-dot';
      dot.style.background = g.color;

      const label = document.createElement('span');
      label.className = 'legend-name';
      label.textContent = name;

      const count = document.createElement('span');
      count.className = 'legend-count';
      count.textContent = g.count;

      btn.appendChild(dot);
      btn.appendChild(label);
      btn.appendChild(count);
      btn.title = '查看该分类的记录';
      btn.onclick = function () {
        flyToRecord(g.rec, true);
        if (window.innerWidth <= 760) {
          legendOpen = false;
          updateLegend();
        }
      };
      legendList.appendChild(btn);
    });
  }

  document.getElementById('legend-toggle').addEventListener('click', function () {
    legendOpen = !legendOpen;
    updateLegend();
  });

  function refreshUI() {
    renderList();
    renderLegend();
    renderRegions();
  }

  /* ---------------- 新增 / 编辑表单 ---------------- */
  const modal = document.getElementById('modal');
  const fTitle = document.getElementById('f-title');
  const fTime = document.getElementById('f-time');
  const fNote = document.getElementById('f-note');
  const fColor = document.getElementById('f-color');
  const fCategory = document.getElementById('f-category');
  const paletteEl = document.getElementById('palette');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('f-images');
  const previewList = document.getElementById('preview-list');

  function renderPalette() {
    paletteEl.innerHTML = '';
    PALETTE.forEach(function (c) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'palette-swatch' +
        (formState && formState.color && formState.color.toLowerCase() === c ? ' active' : '');
      b.style.background = c;
      b.title = c;
      b.onclick = function () {
        formState.color = c;
        fColor.value = c;
        renderPalette();
      };
      paletteEl.appendChild(b);
    });
  }

  fColor.addEventListener('input', function () {
    if (formState) {
      formState.color = fColor.value;
      renderPalette();
    }
  });

  /* ---------------- 变色尺度选择 ---------------- */
  const scaleRow = document.getElementById('scale-buttons');

  function renderScaleButtons() {
    if (!formState) return;
    Array.prototype.forEach.call(scaleRow.querySelectorAll('button'), function (b) {
      b.classList.toggle('active', String(formState.scale) === b.getAttribute('data-scale'));
    });
  }

  scaleRow.addEventListener('click', function (e) {
    const b = e.target.closest('button');
    if (!b || !formState) return;
    const v = b.getAttribute('data-scale');
    formState.scale = v === 'auto' ? 'auto' : parseInt(v, 10);
    renderScaleButtons();
  });

  function renderCategorySuggestions() {
    const dl = document.getElementById('cat-suggestions');
    dl.innerHTML = '';
    const names = new Set();
    records.forEach(function (r) {
      const n = (r.categoryName || '').trim();
      if (n) names.add(n);
    });
    names.forEach(function (n) {
      const o = document.createElement('option');
      o.value = n;
      dl.appendChild(o);
    });
  }

  function openForm(lat, lng, rec) {
    formState = {
      lat: lat,
      lng: lng,
      id: rec ? rec.id : null,
      images: rec ? rec.images.slice() : [],
      color: rec ? recColor(rec) : PALETTE[0],
      category: rec ? (rec.categoryName || '') : '',
      scale: rec ? (rec.scale || 'auto') : 'auto'
    };

    document.getElementById('modal-title').textContent = rec ? '编辑记录' : '新增记录';
    document.getElementById('form-coords').textContent =
      '纬度 ' + lat.toFixed(5) + '，经度 ' + lng.toFixed(5);

    fTitle.value = rec ? (rec.title || '') : '';
    fTime.value = toInputValue(rec ? rec.timestamp : Date.now());
    fNote.value = rec ? (rec.note || '') : '';
    fColor.value = formState.color;
    fCategory.value = formState.category;

    document.getElementById('btn-delete').classList.toggle('hidden', !rec);

    renderPalette();
    renderScaleButtons();
    renderCategorySuggestions();
    renderPreviews();
    modal.classList.remove('hidden');
    setTimeout(function () { fTitle.focus(); }, 50);
  }

  function closeForm() {
    modal.classList.add('hidden');
    formState = null;
  }

  function renderPreviews() {
    previewList.innerHTML = '';
    formState.images.forEach(function (image, i) {
      const wrap = document.createElement('div');
      wrap.className = 'preview-item';

      const im = document.createElement('img');
      im.src = getImageUrl(image);
      im.title = image.name || '';

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'preview-remove';
      rm.textContent = '✕';
      rm.title = '移除';
      rm.onclick = function () {
        formState.images.splice(i, 1);
        renderPreviews();
      };

      wrap.appendChild(im);
      wrap.appendChild(rm);
      previewList.appendChild(wrap);
    });
  }

  function addFiles(fileList) {
    const files = Array.prototype.slice.call(fileList).filter(function (f) {
      return f.type.indexOf('image/') === 0;
    });
    if (!files.length) {
      toast('请选择图片文件');
      return;
    }
    files.forEach(function (file) {
      formState.images.push({
        id: uid(),
        name: file.name,
        type: file.type,
        blob: file
      });
    });
    renderPreviews();
  }

  dropzone.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });
  dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  document.getElementById('btn-now').addEventListener('click', function () {
    fTime.value = toInputValue(Date.now());
  });

  document.getElementById('record-form').addEventListener('submit', function (e) {
    e.preventDefault();
    saveForm();
  });

  document.getElementById('btn-cancel').addEventListener('click', closeForm);
  document.getElementById('modal-close').addEventListener('click', closeForm);
  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeForm();
  });
  document.addEventListener('keydown', function (e) {
    if (tourActive) return;
    if (e.key === 'Escape') {
      if (!modal.classList.contains('hidden')) closeForm();
      else if (journalState) closeJournal();
    } else if (journalState && !journal.classList.contains('hidden')) {
      // 日志视图中 ← / → 切换照片
      if (e.key === 'ArrowLeft' && !jpPrev.classList.contains('hidden')) jpPrev.click();
      else if (e.key === 'ArrowRight' && !jpNext.classList.contains('hidden')) jpNext.click();
    }
  });

  document.getElementById('btn-delete').addEventListener('click', function () {
    if (formState && formState.id) {
      closeForm();
      deleteRecord(formState.id);
    }
  });

  async function saveForm() {
    const ts = fTime.value ? new Date(fTime.value).getTime() : Date.now();
    const now = Date.now();

    const record = normalizeRec({
      id: formState.id || uid(),
      lat: formState.lat,
      lng: formState.lng,
      title: fTitle.value.trim(),
      note: fNote.value.trim(),
      timestamp: isNaN(ts) ? now : ts,
      color: formState.color,
      categoryName: fCategory.value.trim(),
      scale: formState.scale,
      images: formState.images.slice(),
      createdAt: formState.id
        ? (getRecord(formState.id) || {}).createdAt || now
        : now,
      updatedAt: now               // 云端同步合并时的冲突裁决依据
    });

    try {
      await DB.put(record);
      if (window.Account) window.Account.pushSoon();
      const existing = formState.id ? getRecord(formState.id) : null;
      if (existing) {
        const i = records.findIndex(function (r) { return r.id === record.id; });
        if (i >= 0) records[i] = record;
      } else {
        records.push(record);
      }
      records.sort(function (a, b) { return b.timestamp - a.timestamp; });

      // 重建标记（颜色 / 缩略图可能变化）
      removeMarker(record.id);
      addMarker(record);
      refreshUI();
      closeForm();

      if (!existing) {
        flyToRecord(record, true);
        toast('记录已保存');
      } else {
        toast('记录已更新');
      }
    } catch (err) {
      console.error(err);
      toast('保存失败：' + (err.message || err));
    }
  }

  async function deleteRecord(id) {
    const rec = getRecord(id);
    if (!rec) return;
    if (!confirm('确定删除「' + (rec.title || '未命名记录') + '」吗？此操作不可恢复。')) return;

    try {
      await DB.remove(id);
      if (window.Account) {
        window.Account.noteDelete(id);   // 删除墓碑：跨设备同步删除操作
        window.Account.pushSoon();
      }
      removeMarker(id);
      revokeRecordUrls(rec);
      records = records.filter(function (r) { return r.id !== id; });
      if (journalState && journalState.recId === id) closeJournal();
      refreshUI();
      toast('已删除');
    } catch (err) {
      console.error(err);
      toast('删除失败：' + (err.message || err));
    }
  }

  /* ---------------- 备份导出 / 导入 ---------------- */
  async function exportBackup() {
    if (!records.length) { toast('暂无记录可导出'); return; }

    toast('正在生成备份……');
    const payload = {
      app: 'photo-map',
      version: 2,
      exportedAt: new Date().toISOString(),
      records: []
    };

    for (const rec of records) {
      const images = await Promise.all(rec.images.map(async function (im) {
        return {
          id: im.id,
          name: im.name,
          type: im.type,
          dataUrl: await blobToDataURL(im.blob)
        };
      }));
      payload.records.push({
        id: rec.id,
        lat: rec.lat,
        lng: rec.lng,
        title: rec.title,
        note: rec.note,
        timestamp: rec.timestamp,
        createdAt: rec.createdAt,
        color: recColor(rec),
        categoryName: rec.categoryName || '',
        scale: rec.scale || 'auto',
        images: images
      });
    }

    const d = new Date();
    const name = 'photo-map-backup-' + d.getFullYear() + pad(d.getMonth() + 1) +
      pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';

    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('备份已导出（' + records.length + ' 条记录）');
  }

  async function importBackup(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || data.app !== 'photo-map' || !Array.isArray(data.records)) {
        toast('文件格式不正确');
        return;
      }

      let count = 0;
      for (const r of data.records) {
        if (typeof r.lat !== 'number' || typeof r.lng !== 'number') continue;
        const record = normalizeRec({
          id: r.id || uid(),
          lat: r.lat,
          lng: r.lng,
          title: r.title || '',
          note: r.note || '',
          timestamp: typeof r.timestamp === 'number' ? r.timestamp : Date.now(),
          createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
          color: typeof r.color === 'string' ? r.color : '',
          categoryName: typeof r.categoryName === 'string' ? r.categoryName : '',
          scale: r.scale,
          images: (r.images || []).map(function (im) {
            return {
              id: im.id || uid(),
              name: im.name || '',
              type: im.type || '',
              blob: dataURLToBlob(im.dataUrl)
            };
          })
        });
        await DB.put(record);
        count++;
      }

      toast('成功导入 ' + count + ' 条记录，正在刷新……');
      setTimeout(function () { location.reload(); }, 1200);
    } catch (err) {
      console.error(err);
      toast('导入失败：' + (err.message || err));
    }
  }

  document.getElementById('btn-export').addEventListener('click', exportBackup);
  document.getElementById('btn-import').addEventListener('click', function () {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', function (e) {
    const file = e.target.files[0];
    if (file) importBackup(file);
    e.target.value = '';
  });

  /* ---------------- 定位 ---------------- */
  document.getElementById('btn-locate').addEventListener('click', function () {
    toast('正在获取位置……');
    map.locate({ setView: true, maxZoom: 14, timeout: 10000 });
  });

  /* ---------------- 移动端侧边栏开关 ---------------- */
  document.getElementById('sidebar-toggle').addEventListener('click', function () {
    document.getElementById('sidebar').classList.toggle('open');
  });

  /* ================================================================
   * 临时定位点（搜索结果 / 手动坐标 → 蓝色脉冲标记，可直接建记录）
   * ================================================================ */
  const tempIcon = L.divIcon({
    className: 'temp-pin',
    html: '<div class="temp-dot"></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });
  let tempMarker = null;

  function clearTempPoint() {
    if (tempMarker) {
      map.removeLayer(tempMarker);
      tempMarker = null;
    }
  }

  function buildTempPopup(lat, lng, name) {
    const card = document.createElement('div');
    card.className = 'tp-card';

    const title = document.createElement('div');
    title.className = 'tp-name';
    title.textContent = name || '目标位置';
    card.appendChild(title);

    const coords = document.createElement('div');
    coords.className = 'tp-coords';
    coords.textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
    card.appendChild(coords);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '＋ 在此添加记录';
    btn.onclick = function () {
      clearTempPoint();
      openForm(lat, lng, null);
    };
    card.appendChild(btn);
    return card;
  }

  function showTempPoint(lat, lng, name, zoom) {
    clearTempPoint();
    tempMarker = L.marker([lat, lng], { icon: tempIcon });
    tempMarker.bindPopup(buildTempPopup(lat, lng, name), { minWidth: 210 });
    tempMarker.addTo(map);
    map.flyTo([lat, lng], typeof zoom === 'number' ? zoom : Math.max(map.getZoom(), 13), { duration: .7 });
    setTimeout(function () { if (tempMarker) tempMarker.openPopup(); }, 750);
  }

  /* ================================================================
   * 地名搜索（Nominatim / OpenStreetMap，覆盖全球，免费）
   * ================================================================ */
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');
  const searchResults = document.getElementById('search-results');
  let searchAborts = [];
  let searchTimer = null;
  let searchSession = 0;
  let nominatimState = 0;             // 0=未尝试 1=可用 -1=当前网络不可用（失败后不再尝试）

  function typeEmoji(type) {
    if (/city|administrative|town|village/.test(type)) return '🏙';
    if (/mountain|peak|volcano/.test(type)) return '⛰';
    if (/water|river|lake|sea|ocean|bay/.test(type)) return '🌊';
    if (/forest|park|garden/.test(type)) return '🌳';
    if (/airport/.test(type)) return '✈';
    if (/station|railway/.test(type)) return '🚉';
    if (/tourism|museum|monument|attraction|castle/.test(type)) return '🏛';
    return '📍';
  }

  function renderSearchStatus(text) {
    searchResults.innerHTML = '';
    const s = document.createElement('div');
    s.className = 'sr-status';
    s.textContent = text;
    searchResults.appendChild(s);
  }

  // 国家代码 → 国旗 emoji
  function flagEmoji(cc) {
    if (!cc || cc.length !== 2) return '🌍';
    try {
      return String.fromCodePoint.apply(null,
        cc.toUpperCase().split('').map(function (c) { return 0x1F1E6 + c.charCodeAt(0) - 65; }));
    } catch (e) { return '🌍'; }
  }

  // 带超时的 AbortController
  function withTimeout(ms) {
    const c = new AbortController();
    const t = setTimeout(function () { try { c.abort(); } catch (e) {} }, ms);
    return { signal: c.signal, clear: function () { clearTimeout(t); } };
  }

  function groupLabel(text) {
    const div = document.createElement('div');
    div.className = 'sr-group-label';
    div.textContent = text;
    return div;
  }

  // 构造一条可点击的搜索结果
  function makeResultItem(o) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sr-item';

    const emoji = document.createElement('span');
    emoji.className = 'sr-emoji';
    emoji.textContent = o.emoji;

    const text = document.createElement('span');
    text.className = 'sr-text';
    const n = document.createElement('div');
    n.className = 'sr-name';
    n.textContent = o.name;
    const d = document.createElement('div');
    d.className = 'sr-detail';
    d.textContent = o.detail || '';
    text.appendChild(n);
    text.appendChild(d);

    const plus = document.createElement('span');
    plus.className = 'sr-plus';
    plus.textContent = '＋';
    plus.title = '直接在此添加记录';

    btn.appendChild(emoji);
    btn.appendChild(text);
    btn.appendChild(plus);

    // 点击结果：飞过去并在精确位置放临时标记
    btn.addEventListener('click', function () {
      searchResults.innerHTML = '';
      showTempPoint(o.lat, o.lng, o.name);
    });
    // ＋：直接打开记录表单
    plus.addEventListener('click', function (e) {
      e.stopPropagation();
      searchResults.innerHTML = '';
      clearTempPoint();
      openForm(o.lat, o.lng, null);
    });

    return btn;
  }

  function runSearch(query) {
    const q = query.trim();
    if (!q) { searchResults.innerHTML = ''; return; }

    searchAborts.forEach(function (c) { try { c.abort(); } catch (e) {} });
    searchAborts = [];

    const session = ++searchSession;
    let gotAny = false;
    renderSearchStatus('正在搜索……');

    function paintGroup(label, items) {
      if (session !== searchSession) return;
      if (!gotAny) { searchResults.innerHTML = ''; gotAny = true; }
      searchResults.appendChild(groupLabel(label));
      items.forEach(function (el) { searchResults.appendChild(el); });
    }

    // 引擎一：Open-Meteo —— 全球城市 / 地区（免费、无需密钥、速度快）
    const om = withTimeout(8000);
    searchAborts.push(om);
    fetch('https://geocoding-api.open-meteo.com/v1/search' +
      '?count=8&language=zh&format=json&name=' + encodeURIComponent(q),
      { signal: om.signal })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        om.clear();
        const arr = (data && data.results) || [];
        if (!arr.length) return;
        paintGroup('🌍 城市 / 地区', arr.map(function (item) {
          return makeResultItem({
            lat: item.latitude,
            lng: item.longitude,
            name: item.name,
            detail: [item.admin1, item.country].filter(Boolean).join('，'),
            emoji: flagEmoji(item.country_code)
          });
        }));
      })
      .catch(function () {});

    // 引擎二：Nominatim —— 精确地点 / 景点 / 街道（网络不通则 6 秒后静默放弃，且本会话不再重试）
    if (nominatimState !== -1) {
      const nm = withTimeout(6000);
      searchAborts.push(nm);
      fetch('https://nominatim.openstreetmap.org/search' +
        '?format=jsonv2&limit=6&accept-language=zh-CN&q=' + encodeURIComponent(q),
        { signal: nm.signal, headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          nm.clear();
          nominatimState = 1;
          if (!Array.isArray(data) || !data.length) return;
          paintGroup('📍 精确地点 · 景点 / 街道', data.map(function (item) {
            const parts = (item.display_name || '').split(',').map(function (s) { return s.trim(); });
            return makeResultItem({
              lat: parseFloat(item.lat),
              lng: parseFloat(item.lon),
              name: item.name || parts[0] || q,
              detail: parts.slice(1, 4).join('，'),
              emoji: typeEmoji(item.type || item.class || '')
            });
          }));
        })
        .catch(function () { nominatimState = -1; });
    }

    // 两个引擎都没有结果时给出提示
    setTimeout(function () {
      if (session !== searchSession) return;
      if (!gotAny) renderSearchStatus('未找到「' + q + '」，试试更短或更常用的名称');
    }, 7000);
  }

  searchInput.addEventListener('input', function () {
    searchClear.hidden = !searchInput.value;
    clearTimeout(searchTimer);
    const q = searchInput.value;
    if (!q.trim()) { searchResults.innerHTML = ''; return; }
    searchTimer = setTimeout(function () { runSearch(q); }, 700);
  });

  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimer);
      runSearch(searchInput.value);
    }
  });

  searchClear.addEventListener('click', function () {
    searchInput.value = '';
    searchClear.hidden = true;
    searchResults.innerHTML = '';
    searchInput.focus();
  });

  /* ================================================================
   * 手动输入经纬度
   * ================================================================ */
  const coordToggle = document.getElementById('coord-toggle');
  const coordPanel = document.getElementById('coord-panel');
  const coordLat = document.getElementById('coord-lat');
  const coordLng = document.getElementById('coord-lng');

  coordToggle.addEventListener('click', function () {
    coordPanel.classList.toggle('hidden');
  });

  // 解析小数或 DMS（如 39°54'15.1"N / 116 24 26 E）
  function parseCoord(str) {
    if (str == null) return NaN;
    let s = String(str).trim().replace(/，/g, ',');
    if (!s) return NaN;

    // 允许把 "39.9, 116.4" 整段粘进纬度框
    const m = s.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (m) {
      // 无法确定当前是哪个框，交给调用场景：默认不处理，这里仅返回第一个
      s = m[1];
    }

    const dms = s.match(/(-?\d+(?:\.\d+)?)\s*(?:°|度)?\s*(\d+(?:\.\d+)?)?\s*(?:['′分])?\s*(\d+(?:\.\d+)?)?\s*(?:["″秒])?\s*([NSEWnsew])?/);
    if (dms && /°|度|['′分]|["″秒]|[NSEW]/i.test(s)) {
      const deg = parseFloat(dms[1]) || 0;
      const min = parseFloat(dms[2]) || 0;
      const sec = parseFloat(dms[3]) || 0;
      let val = Math.abs(deg) + min / 60 + sec / 3600;
      if (deg < 0) val = -val;
      if (dms[4] && /[SWsw]/.test(dms[4])) val = -Math.abs(val);
      return val;
    }

    const num = parseFloat(s.replace(/[^\d.\-]/g, ''));
    return num;
  }

  function readManualCoords() {
    let latRaw = coordLat.value.trim();
    let lngRaw = coordLng.value.trim();

    // 任一个框中粘了 "lat,lng" 就自动拆开
    const splitPair = function (v) {
      const parts = v.split(/[,\s]+/);
      return parts.length === 2 && parts.every(function (p) { return p && !isNaN(parseFloat(p)); })
        ? parts : null;
    };
    let pair = splitPair(latRaw);
    if (pair) { latRaw = pair[0]; lngRaw = pair[1]; }
    pair = splitPair(lngRaw);
    if (pair && !coordLat.value.trim()) { latRaw = pair[0]; lngRaw = pair[1]; }

    const lat = parseCoord(latRaw);
    const lng = parseCoord(lngRaw);

    const latBad = isNaN(lat) || lat < -90 || lat > 90;
    const lngBad = isNaN(lng) || lng < -180 || lng > 180;
    coordLat.classList.toggle('invalid', latBad);
    coordLng.classList.toggle('invalid', lngBad);

    if (latBad && lngBad) { toast('请输入有效的纬度和经度'); return null; }
    if (latBad) { toast('纬度需在 -90 ~ 90 之间'); return null; }
    if (lngBad) { toast('经度需在 -180 ~ 180 之间'); return null; }

    return { lat: lat, lng: lng };
  }

  document.getElementById('coord-go').addEventListener('click', function () {
    const c = readManualCoords();
    if (c) showTempPoint(c.lat, c.lng, null, 13);
  });

  document.getElementById('coord-add').addEventListener('click', function () {
    const c = readManualCoords();
    if (c) {
      clearTempPoint();
      openForm(c.lat, c.lng, null);
    }
  });

  /* ================================================================
   * 新手引导教程（聚光灯式分步讲解，首次自动播放，可随时重播）
   * ================================================================ */
  const tour = document.getElementById('tour');
  const tourSpot = document.getElementById('tour-spot');
  const tourPop = document.getElementById('tour-pop');
  const tourEmoji = document.getElementById('tour-emoji');
  const tourTitle = document.getElementById('tour-title');
  const tourContent = document.getElementById('tour-content');
  const tourProgress = document.getElementById('tour-progress');
  const tourPrev = document.getElementById('tour-prev');
  const tourNext = document.getElementById('tour-next');
  const tourSkip = document.getElementById('tour-skip');
  let tourIndex = 0;
  let tourActive = false;
  let tourOpenedModal = false;

  const tourSteps = [
    {
      center: true, emoji: '👋', title: '欢迎使用足迹地图',
      content: '这个小工具可以帮你把<b>照片、时间和地点</b>永久绑定在一起，标记在覆盖全球的地图上，还能用<b>颜色分类</b>整理成一本旅行日志。<br>数据全部保存在你的电脑上，不上传任何服务器。<br>接下来用 1 分钟了解每一项功能 👇'
    },
    {
      target: '#search-panel', emoji: '🔍', title: '搜索全球任意地点',
      content: '在左上角输入地名，支持<b>中文、英文和当地语言</b>：北京、东京塔、Eiffel Tower、Sahara……<br>输入后稍等会出现候选列表，点击结果地图就会飞过去。',
      enter: function () { closeForm(); closeJournal(); }
    },
    {
      target: '#coord-panel', emoji: '🎯', title: '手动输入经纬度',
      content: '如果你已经知道精确坐标（例如 GPS 设备、谷歌地图查到的坐标），点开「手动输入经纬度」：<br>填入<b>纬度（-90~90）</b>和<b>经度（-180~180）</b>，点「前往」查看，或点「在此添加记录」直接建档。',
      enter: function () { coordPanel.classList.remove('hidden'); },
      exit: function () { coordPanel.classList.add('hidden'); }
    },
    {
      target: '#map', emoji: '🗺', title: '最常用：点击地图添加',
      content: '地图上<b>浅蓝是陆地、深蓝是海洋</b>，没有道路等杂线。<br>放大到任何地方（<b>包括海洋和两极</b>），<b>单击鼠标</b>就会弹出记录窗口。<br>保存后标记会自动染色：<b>越缩小涂整个国家 / 省，越放大涂市 / 区县</b>；也可以在表单里把变色尺度固定为「国家 ~ 镇」五档之一。',
      enter: function () { coordPanel.classList.add('hidden'); }
    },
    {
      target: '#dropzone', emoji: '📷', title: '如何导入本地图片',
      content: '在虚线框上：<br><b>① 点击</b>虚线框，在弹出的窗口中选择本地图片（按住 Ctrl/Cmd 可一次选多张）；<br><b>② 或直接拖拽</b>图片文件到虚线框里。',
      enter: function () {
        if (modal.classList.contains('hidden')) {
          const c = map.getCenter();
          openForm(c.lat, c.lng, null);
          tourOpenedModal = true;
        }
      }
    },
    {
      target: '#f-time', emoji: '🕑', title: '时间自动记录',
      content: '时间框会<b>自动填入当前时间</b>（精确到秒）。如果你是在补记以前的旅行，可以直接修改，或点「现在」恢复成当前时间。<br>保存后的记录按时间倒序排列。'
    },
    {
      target: '#f-category-row', emoji: '🎨', title: '分类与自定义颜色',
      content: '给记录选一个<b>分类名称</b>（如美食、自然、城市）并挑一个喜欢的<b>颜色</b>，也可以用右侧色块自定义任意颜色。<br>相同颜色的记录归为一类，在地图上显示为对应的<b>彩色区域</b>。<br>下方的<b>变色尺度</b>可选「跟随缩放」，或固定为国家 / 省 / 市 / 县 / 镇某一档。',
      enter: function () {
        if (modal.classList.contains('hidden')) {
          const c = map.getCenter();
          openForm(c.lat, c.lng, null);
          tourOpenedModal = true;
        }
      }
    },
    {
      target: '#record-list', emoji: '📖', title: '旅行日志 · 记录列表',
      content: '所有足迹都在这里，左侧色条对应分类颜色。<b>点击任意一条</b>，地图会飞到对应位置并打开<b>旅行日志视图</b>：大图翻看照片、阅读你写下的故事，还能按时间上一篇 / 下一篇翻阅。',
      enter: function () {
        if (tourOpenedModal) { closeForm(); tourOpenedModal = false; }
      }
    },
    {
      target: '#legend', emoji: '🏷', title: '分类图例',
      content: '左下角是<b>分类图例</b>：每个分类一行，色块 + 名称 + 记录数量。<br>点击任意分类，地图会飞到该分类最近的记录；点标题可折叠图例。'
    },
    {
      target: '#btn-locate', emoji: '🧭', title: '定位 · 备份',
      content: '<b>📍定位</b>：一键跳到你当前的 GPS 位置；<br><b>⬇导出</b>：把全部记录（含照片、分类、颜色）存成备份文件；<br><b>⬆导入</b>：从备份文件恢复。清理浏览器数据前记得先导出。'
    },
    {
      center: true, emoji: '🎉', title: '教程完成！',
      content: '现在你已经掌握全部功能了。<br>点击地图任意位置记录第一段足迹，用<b>颜色</b>为每段旅程分类，翻一翻你的<b>旅行日志</b>吧！<br>（随时可以点左上角的 <b>❓教程</b> 重新查看）'
    }
  ];

  function positionTour() {
    if (!tourActive) return;
    const step = tourSteps[tourIndex];

    tour.classList.toggle('center-mode', !!step.center);

    if (step.center) {
      tourPop.style.left = '50%';
      tourPop.style.top = '50%';
      tourPop.style.transform = 'translate(-50%, -50%)';
      return;
    }

    const el = document.querySelector(step.target);
    if (!el) { // 目标找不到时降级为居中
      tour.classList.add('center-mode');
      tourPop.style.left = '50%';
      tourPop.style.top = '50%';
      tourPop.style.transform = 'translate(-50%, -50%)';
      return;
    }

    const r = el.getBoundingClientRect();
    const pad = 9;
    tourPop.style.transform = 'none';

    tourSpot.style.left = (r.left - pad) + 'px';
    tourSpot.style.top = (r.top - pad) + 'px';
    tourSpot.style.width = (r.width + pad * 2) + 'px';
    tourSpot.style.height = (r.height + pad * 2) + 'px';

    // 弹窗优先放在下方，空间不够放上方；水平与聚光框左对齐并夹取在视口内
    const popW = Math.min(350, window.innerWidth - 32);
    let left = r.left;
    left = Math.max(16, Math.min(left, window.innerWidth - popW - 16));

    const below = r.bottom + 14 + 210 < window.innerHeight;
    let top;
    if (below) {
      top = r.bottom + 14;
    } else if (r.top - 14 - 210 > 0) {
      top = r.top - 14 - 190;
    } else {
      top = Math.max(16, Math.min(r.bottom + 14, window.innerHeight - 220));
    }

    tourPop.style.width = popW + 'px';
    tourPop.style.left = left + 'px';
    tourPop.style.top = top + 'px';
  }

  function renderTourStep() {
    const step = tourSteps[tourIndex];
    tourEmoji.textContent = step.emoji;
    tourTitle.textContent = step.title;
    tourContent.innerHTML = step.content;
    tourProgress.textContent = (tourIndex + 1) + ' / ' + tourSteps.length;
    tourPrev.classList.toggle('hidden', tourIndex === 0);
    tourNext.textContent = tourIndex === tourSteps.length - 1 ? '开始记录 ✨' : '下一步';
    positionTour();
  }

  function gotoTourStep(next) {
    const cur = tourSteps[tourIndex];
    if (cur && cur.exit) cur.exit();
    tourIndex = next;
    const target = tourSteps[tourIndex];
    if (target && target.enter) target.enter();
    renderTourStep();
  }

  function endTour() {
    const cur = tourSteps[tourIndex];
    if (cur && cur.exit) cur.exit();
    if (tourOpenedModal) { closeForm(); tourOpenedModal = false; }
    coordPanel.classList.add('hidden');
    tourActive = false;
    tour.classList.add('hidden');
    try { localStorage.setItem('photo-map-tour-v1-done', '1'); } catch (e) {}
  }

  function startTour() {
    if (tourActive) return;
    tourActive = true;
    tourIndex = 0;
    tourOpenedModal = false;
    tour.classList.remove('hidden');
    const first = tourSteps[0];
    if (first && first.enter) first.enter();
    renderTourStep();
  }

  tourNext.addEventListener('click', function () {
    if (tourIndex === tourSteps.length - 1) {
      endTour();
    } else {
      gotoTourStep(tourIndex + 1);
    }
  });
  tourPrev.addEventListener('click', function () {
    if (tourIndex > 0) gotoTourStep(tourIndex - 1);
  });
  tourSkip.addEventListener('click', endTour);

  let tourRepositionTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(tourRepositionTimer);
    tourRepositionTimer = setTimeout(positionTour, 80);
  });
  window.addEventListener('scroll', positionTour, true);

  document.getElementById('btn-tour').addEventListener('click', startTour);

  /* ---------------- 启动 ---------------- */
  // 全量重载（账户系统云端合并后调用）：从 IndexedDB 重新加载并重绘
  async function reloadAll() {
    records = (await DB.all()).map(normalizeRec);
    if (markerLayer) markerLayer.clearLayers();
    records.forEach(addMarker);
    renderRegions();
    refreshUI();
  }

  async function boot() {
    updateLegend();
    initMap();
    initBaseMap();
    // 账户系统（account.js）：登录态检测 + 微信云端数据合并同步
    if (window.Account) {
      window.Account.init({ toast: toast, onChange: reloadAll });
    }
    try {
      records = (await DB.all()).map(normalizeRec);
      records.forEach(addMarker);
      refreshUI();
      if (records.length) {
        toast('已加载 ' + records.length + ' 条记录');
      }
    } catch (err) {
      console.error(err);
      toast('本地数据加载失败：' + (err.message || err));
    }

    // 首次使用自动播放新手教程
    let tourDone = false;
    try { tourDone = localStorage.getItem('photo-map-tour-v1-done') === '1'; } catch (e) {}
    if (!tourDone) {
      setTimeout(startTour, 700);
    }
  }

  boot();
})();
