'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {execFileSync} = require('node:child_process');

/**
 * Normalizes any hex digest string to 64-char lowercase hex without colons.
 */
function normalizeHexDigest(str) {
  return String(str || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

/**
 * Computes SHA-256 lowercase hex of a Buffer or Uint8Array.
 */
function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
}

/**
 * Computes SHA-512 lowercase hex of a Buffer or Uint8Array.
 */
function sha512Hex(buf) {
  return crypto.createHash('sha512').update(buf).digest('hex').toLowerCase();
}

/**
 * Minimal, strict ZIP archive reader using Node.js built-in zlib.
 * Locates End of Central Directory (EOCD), parses Central Directory entries,
 * and extracts/inflates entries to read AndroidManifest.xml and check archive integrity.
 * NOTE: ZIP CRC32 or entry extraction is NEVER used as proof of signature validity;
 * cryptographic signature verification is performed exclusively by official Android `apksigner`.
 */
function parseZipArchive(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const totalLen = buf.length;
  if (totalLen < 22) {
    throw new Error('حجم ملف APK غير صالح أو تالف (أصغر من الحد الأدنى لملف ZIP)');
  }

  let eocdOffset = -1;
  const maxSearch = Math.min(totalLen, 65535 + 22);
  for (let i = totalLen - 22; i >= totalLen - maxSearch; i--) {
    if (
      buf[i] === 0x50 &&
      buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x05 &&
      buf[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('ملف APK تالف: لم يتم العثور على سجل نهاية الأرشيف (EOCD)');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirSize = buf.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  if (centralDirOffset + centralDirSize > eocdOffset) {
    throw new Error('ملف APK تالف: إزاحة الدليل المركزي (Central Directory) غير صالحة');
  }

  const entries = new Map();
  let pos = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > eocdOffset) {
      throw new Error('ملف APK تالف: سجل الدليل المركزي مقطوع');
    }
    const sig = buf.readUInt32LE(pos);
    if (sig !== 0x02014b50) {
      throw new Error('ملف APK تالف: توقيع سجل الدليل المركزي غير صالح');
    }

    const compressionMethod = buf.readUInt16LE(pos + 10);
    const crc32 = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const fileNameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);

    const fileName = buf.subarray(pos + 46, pos + 46 + fileNameLen).toString('utf8');
    entries.set(fileName, {
      fileName,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    pos += 46 + fileNameLen + extraLen + commentLen;
  }

  function extractEntry(fileName) {
    const entry = entries.get(fileName);
    if (!entry) return null;

    const lho = entry.localHeaderOffset;
    if (lho + 30 > centralDirOffset) {
      throw new Error(`ملف APK تالف: إزاحة الملف الداخلي (${fileName}) غير صالحة`);
    }
    if (buf.readUInt32LE(lho) !== 0x04034b50) {
      throw new Error(`ملف APK تالف: ترويسة الملف الداخلي (${fileName}) غير صالحة`);
    }

    const nameLen = buf.readUInt16LE(lho + 26);
    const extraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + nameLen + extraLen;
    const dataEnd = dataStart + entry.compressedSize;

    if (dataEnd > centralDirOffset) {
      throw new Error(`ملف APK تالف: بيانات الملف الداخلي (${fileName}) تتجاوز حدود الأرشيف`);
    }

    const rawData = buf.subarray(dataStart, dataEnd);
    let uncompressed;
    if (entry.compressionMethod === 0) {
      uncompressed = Buffer.from(rawData);
    } else if (entry.compressionMethod === 8) {
      uncompressed = zlib.inflateRawSync(rawData);
    } else {
      throw new Error(`طريقة ضغط غير مدعومة (${entry.compressionMethod}) للملف ${fileName}`);
    }

    if (uncompressed.length !== entry.uncompressedSize) {
      throw new Error(`حجم الملف المفكوك (${fileName}) لا يطابق الحجم المسجل في الأرشيف`);
    }

    const actualCrc = zlib.crc32(uncompressed) >>> 0;
    if (actualCrc !== entry.crc32) {
      throw new Error(`فشل فحص سلامة البيانات (CRC32) للملف الداخلي (${fileName})؛ الملف تالف أو تم العبث به`);
    }

    return uncompressed;
  }

  return {
    buf,
    eocdOffset,
    centralDirOffset,
    centralDirSize,
    entries,
    extractEntry,
  };
}

/**
 * Parses binary Android XML (AXML) to extract exact packageName, versionCode, versionName, and appName.
 * Zero fallbacks or guessing.
 */
function parseBinaryAndroidManifest(manifestBuffer) {
  const buf = Buffer.isBuffer(manifestBuffer) ? manifestBuffer : Buffer.from(manifestBuffer);
  if (buf.length < 8) {
    throw new Error('ملف AndroidManifest.xml فارغ أو تالف');
  }

  const magic = buf.readUInt32LE(0);
  if (magic !== 0x00080003) {
    throw new Error('ملف AndroidManifest.xml ليس بصيغة AXML ثنائية صالحة');
  }

  let offset = 8;
  let stringPool = [];
  let foundManifest = false;
  let packageName = '';
  let versionCode = 0;
  let versionName = '';
  let appName = '';

  while (offset + 8 <= buf.length) {
    const chunkType = buf.readUInt32LE(offset);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkSize <= 0 || offset + chunkSize > buf.length) break;

    if (chunkType === 0x001c0001) {
      stringPool = parseAxmlStringPool(buf, offset);
    } else if (chunkType === 0x00100102) {
      const nameIdx = buf.readInt32LE(offset + 20);
      const attrSize = buf.readUInt16LE(offset + 26);
      const attrCount = buf.readUInt16LE(offset + 28);
      const elemName = nameIdx >= 0 && nameIdx < stringPool.length ? stringPool[nameIdx] : '';

      if (elemName === 'manifest') {
        foundManifest = true;
        for (let i = 0; i < attrCount; i++) {
          const aOffset = offset + 36 + i * attrSize;
          if (aOffset + 20 > buf.length) break;
          const attrNameIdx = buf.readInt32LE(aOffset + 4);
          const rawValIdx = buf.readInt32LE(aOffset + 8);
          const type = buf.readUInt8(aOffset + 15);
          const data = buf.readInt32LE(aOffset + 16);
          const attrName =
            attrNameIdx >= 0 && attrNameIdx < stringPool.length ? stringPool[attrNameIdx] : '';

          if (attrName === 'package') {
            packageName =
              rawValIdx >= 0 && rawValIdx < stringPool.length
                ? stringPool[rawValIdx]
                : type === 3 && data >= 0 && data < stringPool.length
                ? stringPool[data]
                : '';
          } else if (attrName === 'versionCode') {
            versionCode = data;
          } else if (attrName === 'versionName') {
            versionName =
              rawValIdx >= 0 && rawValIdx < stringPool.length
                ? stringPool[rawValIdx]
                : type === 3 && data >= 0 && data < stringPool.length
                ? stringPool[data]
                : '';
          }
        }
      } else if (elemName === 'application') {
        for (let i = 0; i < attrCount; i++) {
          const aOffset = offset + 36 + i * attrSize;
          if (aOffset + 20 > buf.length) break;
          const attrNameIdx = buf.readInt32LE(aOffset + 4);
          const rawValIdx = buf.readInt32LE(aOffset + 8);
          const type = buf.readUInt8(aOffset + 15);
          const data = buf.readInt32LE(aOffset + 16);
          const attrName =
            attrNameIdx >= 0 && attrNameIdx < stringPool.length ? stringPool[attrNameIdx] : '';
          if (attrName === 'label') {
            if (rawValIdx >= 0 && rawValIdx < stringPool.length) {
              appName = stringPool[rawValIdx];
            } else if (type === 3 && data >= 0 && data < stringPool.length) {
              appName = stringPool[data];
            }
          }
        }
      }
    }

    offset += chunkSize;
  }

  if (!foundManifest || !packageName) {
    throw new Error('فشل فحص الحزمة الخادمي: لم يتم العثور على اسم الحزمة (packageName) في AndroidManifest.xml');
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
    throw new Error(`اسم الحزمة المستخرج غير صالح برمجياً: (${packageName})`);
  }
  if (versionCode <= 0) {
    throw new Error('فشل فحص الحزمة الخادمي: رقم الإصدار (versionCode) مفقود أو غير صالح في AndroidManifest.xml');
  }
  if (!versionName) {
    throw new Error('فشل فحص الحزمة الخادمي: اسم الإصدار (versionName) مفقود في AndroidManifest.xml');
  }

  return {
    packageName,
    versionCode,
    versionName,
    appName: appName || packageName.split('.').pop() || packageName,
  };
}

function parseAxmlStringPool(buf, offset) {
  const stringCount = buf.readUInt32LE(offset + 8);
  const flags = buf.readUInt32LE(offset + 16);
  const stringsStart = buf.readUInt32LE(offset + 20);
  const isUtf8 = (flags & (1 << 8)) !== 0;

  const offsets = [];
  for (let i = 0; i < stringCount; i++) {
    offsets.push(buf.readUInt32LE(offset + 28 + i * 4));
  }

  const strings = [];
  const baseOffset = offset + stringsStart;

  for (let i = 0; i < stringCount; i++) {
    const strOffset = baseOffset + offsets[i];
    if (strOffset >= buf.length) {
      strings.push('');
      continue;
    }

    if (isUtf8) {
      let pos = strOffset;
      if ((buf[pos] & 0x80) !== 0) pos += 2;
      else pos += 1;

      let byteLen = buf[pos];
      if ((byteLen & 0x80) !== 0) {
        byteLen = ((byteLen & 0x7f) << 8) | buf[pos + 1];
        pos += 2;
      } else {
        pos += 1;
      }
      strings.push(buf.subarray(pos, pos + byteLen).toString('utf8'));
    } else {
      const charLen = buf.readUInt16LE(strOffset);
      const start = strOffset + 2;
      strings.push(buf.subarray(start, start + charLen * 2).toString('utf16le'));
    }
  }
  return strings;
}

/**
 * Resolves the official Android `apksigner` runtime (either direct `apksigner` binary
 * or `java -jar apksigner.jar` from official Android Build-Tools / `apksig`).
 * Returns null if the official verification runtime is not available.
 */
function resolveApksignerRuntime(options = {}) {
  if (
    options.forceEnvironmentUnavailable === true ||
    process.env.APK_INSPECTOR_FORCE_UNAVAILABLE === 'true'
  ) {
    return null;
  }

  if (typeof options.customRunner === 'function') {
    return {type: 'custom', runner: options.customRunner};
  }

  // 1. Check explicit APKSIGNER_BIN if configured
  const explicitBin = options.apksignerBin || process.env.APKSIGNER_BIN;
  if (explicitBin && fs.existsSync(explicitBin)) {
    return {type: 'binary', command: explicitBin, baseArgs: []};
  }

  // 2. Locate Java binary + bundled or SDK official apksigner.jar
  const javaCandidates = [
    options.javaBin,
    process.env.JAVA_BIN,
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : null,
    '/tmp/android-env/jdk-17/bin/java',
    '/tmp/android-env/jdk-21/bin/java',
    '/usr/bin/java',
    'java',
  ].filter(Boolean);

  const jarCandidates = [
    options.apksignerJar,
    process.env.APKSIGNER_JAR,
    path.join(__dirname, 'bin', 'apksigner.jar'),
    '/tmp/android-env/sdk/build-tools/35.0.0/lib/apksigner.jar',
    '/tmp/android-env/sdk/build-tools/34.0.0/lib/apksigner.jar',
    '/tmp/android-env/build-tools/android-14/lib/apksigner.jar',
  ].filter(Boolean);

  const foundJar = jarCandidates.find(j => {
    try {
      return fs.existsSync(j) && fs.statSync(j).isFile();
    } catch {
      return false;
    }
  });

  if (foundJar) {
    for (const javaCmd of javaCandidates) {
      try {
        if (javaCmd !== 'java' && !fs.existsSync(javaCmd)) continue;
        execFileSync(javaCmd, ['-version'], {stdio: 'ignore', timeout: 5000});
        return {type: 'jar', command: javaCmd, baseArgs: ['-jar', foundJar]};
      } catch {
        // Try next candidate
      }
    }
  }

  // 3. Check `apksigner` in PATH
  try {
    execFileSync('apksigner', ['--version'], {stdio: 'ignore', timeout: 5000});
    return {type: 'binary', command: 'apksigner', baseArgs: []};
  } catch {
    // Not in PATH
  }

  return null;
}

/**
 * Detects whether the APK Signing Block 42 contains ONLY a v3 block (0xf05368c0) without v2 (0x7109871a),
 * so we pass `--min-sdk-version 28` for v3-only packages and `--min-sdk-version 24` otherwise.
 */
function inferApksignerMinSdk(buf, centralDirOffset) {
  if (centralDirOffset >= 24) {
    const magicOffset = centralDirOffset - 16;
    const magic = buf.subarray(magicOffset, centralDirOffset).toString('utf8');
    if (magic === 'APK Sig Block 42') {
      const blockSize = buf.readUInt32LE(centralDirOffset - 24);
      const blockStart = centralDirOffset - blockSize - 8;
      if (blockStart >= 0) {
        let pos = blockStart + 8;
        let hasV2 = false;
        let hasV3 = false;
        while (pos < centralDirOffset - 24) {
          const pairLen = buf.readUInt32LE(pos);
          const pairId = buf.readUInt32LE(pos + 8);
          if (pairLen <= 0 || pos + 8 + pairLen > centralDirOffset - 24) break;
          if (pairId === 0x7109871a) hasV2 = true;
          else if (pairId === 0xf05368c0) hasV3 = true;
          pos += 8 + pairLen;
        }
        if (hasV3 && !hasV2) {
          return '28';
        }
      }
    }
  }
  return '24';
}

/**
 * Parses the stdout of `apksigner verify --verbose --print-certs`.
 */
function parseApksignerVerifyOutput(stdoutText) {
  const text = String(stdoutText || '');
  const verifiesLine = /^Verifies\s*$/m.test(text);
  const v1Verified = /Verified using v1 scheme \(JAR signing\):\s*true/i.test(text);
  const v2Verified = /Verified using v2 scheme \(APK Signature Scheme v2\):\s*true/i.test(text);
  const v3Verified =
    /Verified using v3 scheme \(APK Signature Scheme v3\):\s*true/i.test(text) ||
    /Verified using v3\.1 scheme \(APK Signature Scheme v3\.1\):\s*true/i.test(text);

  const certSha256Match = text.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]{64})/);
  const certDnMatch = text.match(/Signer #1 certificate DN:\s*(.+)/);
  const pubKeySha256Match = text.match(/Signer #1 public key SHA-256 digest:\s*([0-9a-fA-F]{64})/);

  let signatureScheme = null;
  if (v2Verified && v3Verified) {
    signatureScheme = 'v2+v3';
  } else if (v3Verified) {
    signatureScheme = 'v3';
  } else if (v2Verified) {
    signatureScheme = 'v2';
  } else if (v1Verified) {
    signatureScheme = 'v1';
  }

  return {
    verifies: verifiesLine,
    v1Verified,
    v2Verified,
    v3Verified,
    signatureScheme,
    sha256Cert: certSha256Match ? normalizeHexDigest(certSha256Match[1]) : '',
    certificateDn: certDnMatch ? certDnMatch[1].trim() : '',
    publicKeySha256: pubKeySha256Match ? normalizeHexDigest(pubKeySha256Match[1]) : '',
    rawOutput: text,
  };
}

/**
 * Runs official Android `apksigner verify --verbose --print-certs` on a Buffer or file path.
 * Throws an error with `code = 'INSPECTION_ENV_UNAVAILABLE'` if the official runtime is unavailable.
 * Throws a verification error if `apksigner` rejects the APK (`DOES NOT VERIFY`).
 */
function runOfficialApksignerVerify(apkBufferOrPath, options = {}) {
  const runtime = resolveApksignerRuntime(options);
  if (!runtime) {
    const envErr = new Error(
      'بيئة الفحص الخادمية الرسمية (apksigner) غير متوفرة حالياً؛ يبقى التطبيق قيد الفحص (pending_inspection) ويُمنع توزيعه.'
    );
    envErr.code = 'INSPECTION_ENV_UNAVAILABLE';
    throw envErr;
  }

  let tempFilePath = null;
  let targetPath = apkBufferOrPath;
  let minSdk = options.minSdkVersion ? String(options.minSdkVersion) : '24';

  try {
    if (Buffer.isBuffer(apkBufferOrPath) || apkBufferOrPath instanceof Uint8Array) {
      const buf = Buffer.isBuffer(apkBufferOrPath) ? apkBufferOrPath : Buffer.from(apkBufferOrPath);
      if (!options.minSdkVersion) {
        try {
          const zipInfo = parseZipArchive(buf);
          minSdk = inferApksignerMinSdk(buf, zipInfo.centralDirOffset);
        } catch {
          minSdk = '24';
        }
      }
      tempFilePath = path.join(
        os.tmpdir(),
        `injaz_apk_verify_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.apk`
      );
      fs.writeFileSync(tempFilePath, buf, {mode: 0o600});
      targetPath = tempFilePath;
    }

    let stdout = '';
    if (runtime.type === 'custom') {
      stdout = runtime.runner(targetPath, minSdk);
    } else {
      const args = [
        ...runtime.baseArgs,
        'verify',
        '--verbose',
        '--print-certs',
        '--min-sdk-version',
        minSdk,
        targetPath,
      ];
      stdout = execFileSync(runtime.command, args, {
        encoding: 'utf8',
        timeout: 25000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    const parsed = parseApksignerVerifyOutput(stdout);
    if (
      !parsed.verifies ||
      !parsed.signatureScheme ||
      !parsed.sha256Cert ||
      parsed.sha256Cert.length !== 64
    ) {
      throw new Error(
        'فشل التحقق الرسمي من توقيع APK عبر apksigner: مخرجات التحقق غير مكتملة أو لا تحتوي على شهادة صالحة'
      );
    }

    return parsed;
  } catch (err) {
    if (err && err.code === 'INSPECTION_ENV_UNAVAILABLE') {
      throw err;
    }
    const stderrText = err.stderr ? String(err.stderr).trim() : '';
    const stdoutText = err.stdout ? String(err.stdout).trim() : '';
    const detail = stderrText || stdoutText || err.message || 'DOES NOT VERIFY';
    const verifyErr = new Error(
      `فشل التحقق الرسمي من توقيع وسلامة APK عبر أداة Android الرسمية (apksigner): ${detail}`
    );
    verifyErr.code = 'APK_SIGNATURE_INVALID';
    throw verifyErr;
  } finally {
    if (tempFilePath) {
      try {
        fs.rmSync(tempFilePath, {force: true});
      } catch {
        // Ignore cleanup error
      }
    }
  }
}

/**
 * Authoritative Server-Side APK Inspector.
 * 1. Verifies ZIP structure and extracts binary AndroidManifest.xml (AXML) packageName, versionCode, versionName.
 * 2. Verifies cryptographic APK signature (v1, v2, v3) and content integrity exclusively via official Android `apksigner`.
 * 3. Never uses CRC32, MANIFEST.MF entry hashes, or raw X.509 certificate extraction as proof of signature validity.
 * 4. Fails closed with `code = 'INSPECTION_ENV_UNAVAILABLE'` if the official `apksigner` runtime is unavailable.
 */
function inspectApkBuffer(apkBuffer, options = {}) {
  const buf = Buffer.isBuffer(apkBuffer) ? apkBuffer : Buffer.from(apkBuffer);
  const fileSizeBytes = buf.length;
  const sha256Apk = sha256Hex(buf);

  const zipInfo = parseZipArchive(buf);

  // Extract and validate binary AndroidManifest.xml
  const manifestBytes = zipInfo.extractEntry('AndroidManifest.xml');
  if (!manifestBytes) {
    throw new Error('ملف APK المرفوع لا يحتوي على ملف AndroidManifest.xml');
  }
  const manifestInfo = parseBinaryAndroidManifest(manifestBytes);

  // Verify every entry in the ZIP can be extracted with valid CRC32
  for (const [entryName] of zipInfo.entries.entries()) {
    if (!entryName.endsWith('/')) {
      zipInfo.extractEntry(entryName);
    }
  }

  // Official Android `apksigner` cryptographic verification (no custom fallback!)
  const minSdk = options.minSdkVersion
    ? String(options.minSdkVersion)
    : inferApksignerMinSdk(buf, zipInfo.centralDirOffset);
  const verifiedSig = runOfficialApksignerVerify(buf, {...options, minSdkVersion: minSdk});

  return {
    appName: manifestInfo.appName,
    packageName: manifestInfo.packageName,
    versionCode: manifestInfo.versionCode,
    versionName: manifestInfo.versionName,
    fileSizeBytes,
    sha256Apk: normalizeHexDigest(sha256Apk),
    sha256Cert: normalizeHexDigest(verifiedSig.sha256Cert),
    signatureScheme: verifiedSig.signatureScheme,
    verifiedSchemes: {
      v1: verifiedSig.v1Verified,
      v2: verifiedSig.v2Verified,
      v3: verifiedSig.v3Verified,
    },
    certificateDn: verifiedSig.certificateDn,
    publicKeySha256: verifiedSig.publicKeySha256,
  };
}

module.exports = {
  normalizeHexDigest,
  sha256Hex,
  sha512Hex,
  parseZipArchive,
  parseBinaryAndroidManifest,
  resolveApksignerRuntime,
  parseApksignerVerifyOutput,
  runOfficialApksignerVerify,
  inspectApkBuffer,
};
