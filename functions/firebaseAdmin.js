'use strict';

let adminAppMod;
let adminFirestoreMod;
let adminAuthMod;
let adminStorageMod;

try {
  adminAppMod = require('firebase-admin/app');
  adminFirestoreMod = require('firebase-admin/firestore');
  adminAuthMod = require('firebase-admin/auth');
  adminStorageMod = require('firebase-admin/storage');
} catch (err) {
  if (process.env.NODE_ENV === 'test') {
    // Stubs permitted strictly inside unit test context without installed SDK
    adminAppMod = {
      initializeApp: opts => ({options: opts || {}}),
      getApps: () => [],
      getApp: () => ({options: {}}),
      deleteApp: async () => {},
    };
    adminFirestoreMod = {
      getFirestore: () => ({}),
      FieldValue: {serverTimestamp: () => 'SERVER_TIMESTAMP'},
    };
    adminAuthMod = {
      getAuth: () => ({}),
    };
    adminStorageMod = {
      getStorage: () => ({bucket: () => ({})}),
    };
  } else {
    // In production or normal runtime, fail loud if firebase-admin is missing
    throw new Error(`فشل تحميل مكتبة Firebase Admin SDK: ${err.message}`);
  }
}

const {initializeApp, getApps, getApp, deleteApp} = adminAppMod;
const {getFirestore, FieldValue} = adminFirestoreMod;
const {getAuth} = adminAuthMod;
const {getStorage} = adminStorageMod;

/**
 * Authoritative Synchronous Unified Firebase Admin Initialization.
 * Ensures explicit `projectId` and `storageBucket` are initialized BEFORE any Firestore/Storage/Auth getters are invoked.
 */
function initFirebaseAdmin({
  projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT,
  storageBucket = process.env.STORAGE_BUCKET,
  isCloudRunServer = false,
  isTestMode = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT) || process.env.IS_TEST === 'true',
} = {}) {
  // In production Cloud Run Inspector server mode, explicitly require FIREBASE_PROJECT_ID and STORAGE_BUCKET
  if (isCloudRunServer && !isTestMode) {
    if (!projectId || !String(projectId).trim()) {
      throw new Error('متغيرة البيئة FIREBASE_PROJECT_ID مطلوبة صراحةً لتشغيل خدمة الفحص في بيئة الإنتاج');
    }
    if (!storageBucket || !String(storageBucket).trim()) {
      throw new Error('متغيرة البيئة STORAGE_BUCKET مطلوبة صراحةً لتشغيل خدمة الفحص في بيئة الإنتاج');
    }
  }

  const existingApps = getApps();
  if (existingApps.length === 0) {
    const initConfig = {};
    if (projectId) initConfig.projectId = projectId;
    if (storageBucket) initConfig.storageBucket = storageBucket;
    return initializeApp(initConfig);
  }

  // App already exists: verify configuration compatibility
  const app = existingApps[0];
  const currentOptions = app?.options || {};

  if (projectId && currentOptions.projectId && currentOptions.projectId !== projectId) {
    throw new Error(
      `تعارض في إعدادات Firebase Admin: التطبيق الحالي يستخدم مشروع (${currentOptions.projectId}) بينما المطلوب (${projectId})`
    );
  }

  if (storageBucket && currentOptions.storageBucket && currentOptions.storageBucket !== storageBucket) {
    throw new Error(
      `تعارض في إعدادات Firebase Admin: التطبيق الحالي يستخدم حاوية تخزين (${currentOptions.storageBucket}) بينما المطلوب (${storageBucket})`
    );
  }

  return app;
}

/**
 * Async app reset helper for unit tests.
 */
async function resetAdminAppForTest() {
  const apps = getApps();
  if (apps.length > 0) {
    try {
      if (typeof deleteApp === 'function') {
        await deleteApp(apps[0]);
      }
    } catch {
      // ignore reset errors in test
    }
  }
}

function getAdminDb() {
  initFirebaseAdmin();
  return getFirestore();
}

function getAdminStorageBucket(overrideBucket) {
  initFirebaseAdmin();
  const bucketName = overrideBucket || process.env.STORAGE_BUCKET;
  return bucketName ? getStorage().bucket(bucketName) : getStorage().bucket();
}

function getAdminAuth() {
  initFirebaseAdmin();
  return getAuth();
}

module.exports = {
  initFirebaseAdmin,
  initFirebaseAdminSync: initFirebaseAdmin,
  resetAdminAppForTest,
  getAdminDb,
  getAdminStorageBucket,
  getAdminAuth,
  FieldValue,
  getStorage,
  getFirestore,
  getAuth,
  getApps,
  initializeApp,
  deleteApp,
};
