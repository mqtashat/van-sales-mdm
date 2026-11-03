'use strict';

const http = require('node:http');
const {resolveApksignerRuntime} = require('./apkInspector');
const {
  initFirebaseAdminSync,
  getAdminAuth,
  getAdminDb,
  getAdminStorageBucket,
  FieldValue,
} = require('./firebaseAdmin');

// CRITICAL: Initialize Firebase Admin FIRST before importing index.js or functions logic
initFirebaseAdminSync({isCloudRunServer: true});

const {_testHelpers} = require('./index');
const {executeServerApkInspection} = _testHelpers;

function mapErrorCodeToHttpStatus(code) {
  switch (code) {
    case 'unauthenticated':
      return 401;
    case 'permission-denied':
      return 403;
    case 'not-found':
      return 404;
    case 'invalid-argument':
      return 400;
    case 'failed-precondition':
      return 412;
    default:
      return 500;
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * Creates the HTTP request handler for the isolated Cloud Run APK Inspector container.
 * - Requires a valid Firebase ID token in `Authorization: Bearer <token>`.
 * - Verifies admin authorization (`verifyAdminAuth`) and runs `executeServerApkInspection`
 *   using the container's bundled OpenJDK + official Android `apksigner.jar`.
 * - Fails closed (`pending_inspection`, `inspected_by_server: false`) if the inspection
 *   runtime is unavailable; never accepts heuristic or unverified packages.
 */
function createInspectorRequestHandler(deps = {}) {
  const verifyIdTokenFn =
    deps.verifyIdTokenFn || (token => getAdminAuth().verifyIdToken(token, true));
  const firestoreDb = deps.firestoreDb || getAdminDb();
  const storageReader =
    deps.storageReader ||
    (async storagePath => {
      const bucketName = process.env.STORAGE_BUCKET;
      if (!bucketName && process.env.NODE_ENV === 'production') {
        throw new Error('متغيرة البيئة STORAGE_BUCKET مطلوبة صراحةً في بيئة الإنتاج');
      }
      const bucket = getAdminStorageBucket(bucketName);
      const file = bucket.file(storagePath);
      const [metadata] = await file.getMetadata();
      const [buffer] = await file.download();
      return {
        buffer,
        generation: metadata.generation,
        size: Number(metadata.size),
        contentType: metadata.contentType,
      };
    });
  const inspectorOptions = deps.inspectorOptions || {};
  const serverTimestampFn = deps.serverTimestampFn || (() => FieldValue.serverTimestamp());

  return async function handleInspectorRequest(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    const urlPath = String(req.url || '/').split('?')[0];

    if (method === 'GET' && (urlPath === '/healthz' || urlPath === '/')) {
      const runtime = resolveApksignerRuntime(inspectorOptions);
      if (!runtime) {
        return sendJson(res, 503, {
          status: 'unavailable',
          apksignerReady: false,
          error:
            'بيئة الفحص الخادمية الرسمية (Java + apksigner.jar) غير متوفرة؛ يبقى الاعتماد والتوزيع متوقفين.',
        });
      }
      return sendJson(res, 200, {
        status: 'ok',
        apksignerReady: true,
        runtimeType: runtime.type,
      });
    }

    if (method !== 'POST' || (urlPath !== '/inspectCompanyApk' && urlPath !== '/')) {
      return sendJson(res, 404, {
        error: {code: 'not-found', message: 'المسار غير موجود في خدمة فحص APK الخادمية'},
      });
    }

    const authHeader = String(req.headers?.['x-firebase-auth'] || req.headers?.authorization || '');
    const match = authHeader.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) {
      return sendJson(res, 401, {
        error: {
          code: 'unauthenticated',
          message: 'مطلوب رمز مصادقة Firebase صالح في ترويسة Authorization أو X-Firebase-Auth',
        },
      });
    }

    const bodyPromise = new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', chunk => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > 64 * 1024) {
          reject(Object.assign(new Error('حجم الطلب يتجاوز الحد المسموح'), {code: 'invalid-argument'}));
          return;
        }
        chunks.push(buf);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

    let decodedToken;
    try {
      decodedToken = await verifyIdTokenFn(match[1]);
    } catch {
      return sendJson(res, 401, {
        error: {
          code: 'unauthenticated',
          message: 'رمز المصادقة غير صالح أو منتهي الصلاحية',
        },
      });
    }

    let rawBody = '';
    try {
      rawBody = await bodyPromise;
    } catch (readErr) {
      return sendJson(res, 400, {
        error: {code: 'invalid-argument', message: readErr.message},
      });
    }

    let parsedBody = {};
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return sendJson(res, 400, {
        error: {code: 'invalid-argument', message: 'صيغة JSON في الطلب غير صالحة'},
      });
    }

    const payload =
      parsedBody && typeof parsedBody.data === 'object' && parsedBody.data !== null
        ? parsedBody.data
        : parsedBody;
    const appId = payload?.appId;

    try {
      const result = await executeServerApkInspection({
        appId,
        auth: {
          uid: decodedToken.uid,
          token: decodedToken,
        },
        firestoreDb,
        storageReader,
        inspectorOptions,
        serverTimestampFn,
      });
      return sendJson(res, 200, {result});
    } catch (err) {
      const code = err.code || 'internal';
      const status = mapErrorCodeToHttpStatus(code);
      return sendJson(res, status, {
        error: {
          code,
          message: err.message || 'فشل الفحص الخادمي لحزمة APK',
        },
      });
    }
  };
}

function startCloudRunServer(port = Number(process.env.PORT || 8080), deps = {}) {
  const handler = createInspectorRequestHandler(deps);
  const server = http.createServer(handler);
  server.listen(port, '0.0.0.0');
  return server;
}

if (require.main === module) {
  startCloudRunServer();
}

module.exports = {
  createInspectorRequestHandler,
  startCloudRunServer,
};
