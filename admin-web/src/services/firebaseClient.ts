import {
  initializeApp,
  getApps,
  deleteApp,
  type FirebaseApp,
} from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import {
  TARGET_FIREBASE_PROJECT_ID,
  TARGET_FIRESTORE_DATABASE_ID,
  type FirebaseWebConfigInput,
} from '../types/mdm.ts';

const STORAGE_KEY = 'injaz_mdm_firebase_web_config_v1';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export interface ConfigResolution {
  isConfigured: boolean;
  source: 'env' | 'runtime_storage' | 'unconfigured';
  config: FirebaseWebConfigInput | null;
  validationError: string | null;
  envStatus: {
    VITE_FIREBASE_API_KEY: boolean;
    VITE_FIREBASE_AUTH_DOMAIN: boolean;
    VITE_FIREBASE_PROJECT_ID: boolean;
    VITE_FIREBASE_APP_ID: boolean;
    VITE_FIREBASE_MESSAGING_SENDER_ID: boolean;
    VITE_FIREBASE_STORAGE_BUCKET: boolean;
  };
}

function getEnvValue(key: string): string {
  try {
    const metaEnv = (import.meta as unknown as { env?: Record<string, string> }).env;
    if (metaEnv && typeof metaEnv[key] === 'string') {
      return metaEnv[key].trim();
    }
  } catch {
    // Ignore when running in pure Node test context
  }
  return '';
}

export function resolveFirebaseConfig(): ConfigResolution {
  const envApiKey = getEnvValue('VITE_FIREBASE_API_KEY');
  const envAuthDomain = getEnvValue('VITE_FIREBASE_AUTH_DOMAIN');
  const envProjectId = getEnvValue('VITE_FIREBASE_PROJECT_ID');
  const envStorageBucket = getEnvValue('VITE_FIREBASE_STORAGE_BUCKET');
  const envMessagingSenderId = getEnvValue('VITE_FIREBASE_MESSAGING_SENDER_ID');
  const envAppId = getEnvValue('VITE_FIREBASE_APP_ID');
  const envDatabaseId =
    getEnvValue('VITE_FIREBASE_DATABASE_ID') || TARGET_FIRESTORE_DATABASE_ID;

  const envStatus = {
    VITE_FIREBASE_API_KEY: Boolean(envApiKey),
    VITE_FIREBASE_AUTH_DOMAIN: Boolean(envAuthDomain),
    VITE_FIREBASE_PROJECT_ID: Boolean(envProjectId),
    VITE_FIREBASE_APP_ID: Boolean(envAppId),
    VITE_FIREBASE_MESSAGING_SENDER_ID: Boolean(envMessagingSenderId),
    VITE_FIREBASE_STORAGE_BUCKET: Boolean(envStorageBucket),
  };

  // 1. Check VITE_FIREBASE_* environment variables first
  if (envApiKey && envAuthDomain && envProjectId && envAppId) {
    if (envProjectId !== TARGET_FIREBASE_PROJECT_ID) {
      return {
        isConfigured: false,
        source: 'env',
        config: null,
        validationError: `قيمة VITE_FIREBASE_PROJECT_ID الحالية (${envProjectId}) غير مطابقة للمشروع المستهدف حصريًا (${TARGET_FIREBASE_PROJECT_ID}). تم إيقاف الاتصال لمنع الربط بأي مشروع آخر.`,
        envStatus,
      };
    }
    if (envDatabaseId !== TARGET_FIRESTORE_DATABASE_ID) {
      return {
        isConfigured: false,
        source: 'env',
        config: null,
        validationError: `قاعدة البيانات المحددة (${envDatabaseId}) غير مطابقة للقاعدة المستهدفة (${TARGET_FIRESTORE_DATABASE_ID}).`,
        envStatus,
      };
    }
    return {
      isConfigured: true,
      source: 'env',
      config: {
        apiKey: envApiKey,
        authDomain: envAuthDomain,
        projectId: TARGET_FIREBASE_PROJECT_ID,
        storageBucket:
          envStorageBucket || `${TARGET_FIREBASE_PROJECT_ID}.firebasestorage.app`,
        messagingSenderId: envMessagingSenderId,
        appId: envAppId,
        databaseId: TARGET_FIRESTORE_DATABASE_ID,
      },
      validationError: null,
      envStatus,
    };
  }

  // 2. Check runtime configuration entered by admin via Setup Screen
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<FirebaseWebConfigInput>;
        const apiKey = (parsed.apiKey || '').trim();
        const authDomain = (parsed.authDomain || '').trim();
        const projectId = (parsed.projectId || '').trim();
        const appId = (parsed.appId || '').trim();

        if (apiKey && authDomain && projectId && appId) {
          if (projectId !== TARGET_FIREBASE_PROJECT_ID) {
            return {
              isConfigured: false,
              source: 'runtime_storage',
              config: null,
              validationError: `المشروع المدخل (${projectId}) لا يطابق المشروع المستهدف (${TARGET_FIREBASE_PROJECT_ID}).`,
              envStatus,
            };
          }
          return {
            isConfigured: true,
            source: 'runtime_storage',
            config: {
              apiKey,
              authDomain,
              projectId: TARGET_FIREBASE_PROJECT_ID,
              storageBucket: (
                parsed.storageBucket ||
                `${TARGET_FIREBASE_PROJECT_ID}.firebasestorage.app`
              ).trim(),
              messagingSenderId: (parsed.messagingSenderId || '').trim(),
              appId,
              databaseId: TARGET_FIRESTORE_DATABASE_ID,
            },
            validationError: null,
            envStatus,
          };
        }
      }
    }
  } catch {
    // Ignore storage read errors
  }

  return {
    isConfigured: false,
    source: 'unconfigured',
    config: null,
    validationError: null,
    envStatus,
  };
}

function computeConfigFingerprint(config: FirebaseWebConfigInput): string {
  return JSON.stringify({
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    storageBucket: config.storageBucket || '',
    messagingSenderId: config.messagingSenderId || '',
    appId: config.appId,
    databaseId: config.databaseId || TARGET_FIRESTORE_DATABASE_ID,
  });
}

let cachedServices: {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  fingerprint: string;
} | null = null;

let appInstanceCounter = 0;

/**
 * Safely tears down any cached FirebaseApp instance so updated configuration
 * takes effect immediately without staying bound to stale credentials.
 */
export async function resetFirebaseServices(): Promise<void> {
  const prev = cachedServices;
  cachedServices = null;
  if (prev?.app) {
    try {
      await deleteApp(prev.app);
    } catch {
      // Ignore cleanup errors if already deleted
    }
  }
  const existingApps = getApps();
  for (const app of existingApps) {
    try {
      await deleteApp(app);
    } catch {
      // Ignore
    }
  }
}

export function saveRuntimeFirebaseConfig(input: FirebaseWebConfigInput): {
  ok: boolean;
  error?: string;
} {
  const apiKey = input.apiKey.trim();
  const authDomain = input.authDomain.trim();
  const projectId = input.projectId.trim();
  const appId = input.appId.trim();

  if (!apiKey || !authDomain || !projectId || !appId) {
    return {
      ok: false,
      error: 'يرجى استكمال الحقول الإلزامية: apiKey و authDomain و projectId و appId.',
    };
  }

  if (projectId !== TARGET_FIREBASE_PROJECT_ID) {
    return {
      ok: false,
      error: `يُسمح فقط بالاتصال بمشروع ${TARGET_FIREBASE_PROJECT_ID}. لا يمكن ربط اللوحة بمشروع (${projectId}).`,
    };
  }

  const normalized: FirebaseWebConfigInput = {
    apiKey,
    authDomain,
    projectId: TARGET_FIREBASE_PROJECT_ID,
    storageBucket: (
      input.storageBucket || `${TARGET_FIREBASE_PROJECT_ID}.firebasestorage.app`
    ).trim(),
    messagingSenderId: (input.messagingSenderId || '').trim(),
    appId,
    databaseId: TARGET_FIRESTORE_DATABASE_ID,
  };

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  // Clear cached instance synchronously so next getFirebaseServices() initializes with the new config
  cachedServices = null;
  return { ok: true };
}

export function clearRuntimeFirebaseConfig(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY);
  }
  cachedServices = null;
}

/**
 * Parses a pasted firebaseConfig JavaScript/JSON snippet from Firebase Console.
 */
export function parseFirebaseConfigSnippet(snippet: string): {
  config?: FirebaseWebConfigInput;
  error?: string;
} {
  const text = snippet.trim();
  if (!text) {
    return { error: 'النص المدخل فارغ.' };
  }

  const extractField = (field: string): string => {
    const regex = new RegExp(`["']?${field}["']?\\s*:\\s*["']([^"']+)["']`);
    const match = text.match(regex);
    return match ? match[1].trim() : '';
  };

  const apiKey = extractField('apiKey');
  const authDomain = extractField('authDomain');
  const projectId = extractField('projectId');
  const storageBucket = extractField('storageBucket');
  const messagingSenderId = extractField('messagingSenderId');
  const appId = extractField('appId');

  if (!apiKey || !projectId || !appId) {
    return {
      error:
        'تعذر استخراج الحقول الأساسية (apiKey, projectId, appId) من النص. تأكد من نسخ كائن firebaseConfig من إعدادات تطبيق الويب في Firebase Console.',
    };
  }

  if (projectId !== TARGET_FIREBASE_PROJECT_ID) {
    return {
      error: `معرّف المشروع في الكائن المنسوخ هو "${projectId}" بينما المشروع المستهدف حصريًا هو "${TARGET_FIREBASE_PROJECT_ID}".`,
    };
  }

  return {
    config: {
      apiKey,
      authDomain: authDomain || `${TARGET_FIREBASE_PROJECT_ID}.firebaseapp.com`,
      projectId: TARGET_FIREBASE_PROJECT_ID,
      storageBucket:
        storageBucket || `${TARGET_FIREBASE_PROJECT_ID}.firebasestorage.app`,
      messagingSenderId,
      appId,
      databaseId: TARGET_FIRESTORE_DATABASE_ID,
    },
  };
}

/**
 * Returns Firebase services initialized strictly against the current resolved config.
 * If the config changed since last call, re-initializes a fresh FirebaseApp instance.
 * Never performs dummy reads to test/connection in production.
 */
export function getFirebaseServices(): {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
} | null {
  const resolution = resolveFirebaseConfig();
  if (!resolution.isConfigured || !resolution.config) {
    cachedServices = null;
    return null;
  }

  const { config } = resolution;
  const fingerprint = computeConfigFingerprint(config);

  if (cachedServices && cachedServices.fingerprint === fingerprint) {
    return {
      app: cachedServices.app,
      auth: cachedServices.auth,
      db: cachedServices.db,
    };
  }

  // Config changed or not initialized yet: create a fresh named app instance
  // so we never stay connected to stale credentials.
  if (cachedServices?.app) {
    void deleteApp(cachedServices.app).catch(() => {});
  }

  appInstanceCounter += 1;
  const appName = `injaz-mdm-app-${appInstanceCounter}`;
  const app = initializeApp(
    {
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: TARGET_FIREBASE_PROJECT_ID,
      storageBucket: config.storageBucket,
      messagingSenderId: config.messagingSenderId,
      appId: config.appId,
    },
    appName
  );

  const auth = getAuth(app);
  // Target the (default) Firestore database on vansales-mdm
  const db = getFirestore(app);

  cachedServices = { app, auth, db, fingerprint };
  return { app, auth, db };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const currentUser = cachedServices?.auth.currentUser;

  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentUser?.uid ?? null,
      email: currentUser?.email ?? null,
      emailVerified: currentUser?.emailVerified ?? null,
      isAnonymous: currentUser?.isAnonymous ?? null,
      tenantId: currentUser?.tenantId ?? null,
      providerInfo:
        currentUser?.providerData.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };

  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export function translateFirestoreErrorAr(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  try {
    const parsed = JSON.parse(raw) as Partial<FirestoreErrorInfo>;
    if (parsed.error) {
      if (
        parsed.error.includes('Missing or insufficient permissions') ||
        parsed.error.includes('permission-denied')
      ) {
        return `رفضت قواعد Firestore العملية (${parsed.operationType} على ${parsed.path}): الحساب الحالي لا يملك صلاحية مسؤول مثبتة (Custom Claim admin=true أو وثيقة فعالة في admins/{uid}) أو أن قواعد الإدارة المحدثة لم تُنشر بعد في مشروع vansales-mdm.`;
      }
      return `خطأ في Firestore (${parsed.path}): ${parsed.error}`;
    }
  } catch {
    // Not a JSON error string
  }

  if (
    raw.includes('Missing or insufficient permissions') ||
    raw.includes('permission-denied')
  ) {
    return 'رفضت قواعد Firestore الوصول (permission-denied). تأكد من توثيق البريد، وإضافة وثيقة admins/{uid} (أو admin claim)، ونشر قواعد Firestore المحدثة في مشروع vansales-mdm.';
  }
  if (raw.includes('Quota exceeded')) {
    return 'تم تجاوز حصة القراءة/الكتابة اليومية المجانية في Firestore. ستُعاد التهيئة في اليوم التالي.';
  }
  if (raw.includes('network-request-failed') || raw.includes('offline') || raw.includes('unavailable')) {
    return 'تعذر الاتصال بخدمات Firebase. تحقق من اتصال الإنترنت وإعدادات الشبكة.';
  }

  return raw;
}
