/**
 * db.js —— 基于 IndexedDB 的本地存储
 * 记录结构：
 * {
 *   id, lat, lng, title, note, timestamp(毫秒), createdAt,
 *   images: [{ id, name, type, blob: Blob }]
 * }
 */
const DB = (function () {
  'use strict';

  const DB_NAME = 'photo-map-db';
  const DB_VERSION = 1;
  const STORE = 'records';

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (e) {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });

    return dbPromise;
  }

  function tx(mode) {
    return openDB().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }

  return {
    /** 新增或更新一条记录 */
    put: function (record) {
      return tx('readwrite').then(function (store) {
        return new Promise(function (resolve, reject) {
          const req = store.put(record);
          req.onsuccess = function () { resolve(record); };
          req.onerror = function () { reject(req.error); };
        });
      });
    },

    /** 读取全部记录（按时间倒序） */
    all: function () {
      return tx('readonly').then(function (store) {
        return new Promise(function (resolve, reject) {
          const req = store.getAll();
          req.onsuccess = function () {
            const list = req.result || [];
            list.sort(function (a, b) { return b.timestamp - a.timestamp; });
            resolve(list);
          };
          req.onerror = function () { reject(req.error); };
        });
      });
    },

    /** 删除一条记录 */
    remove: function (id) {
      return tx('readwrite').then(function (store) {
        return new Promise(function (resolve, reject) {
          const req = store.delete(id);
          req.onsuccess = function () { resolve(); };
          req.onerror = function () { reject(req.error); };
        });
      });
    }
  };
})();
