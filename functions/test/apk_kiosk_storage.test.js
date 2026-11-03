'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {
  inspectApkBuffer,
  runOfficialApksignerVerify,
  parseApksignerVerifyOutput,
  parseZipArchive,
  sha256Hex,
  normalizeHexDigest,
} = require('../apkInspector');
const { _testHelpers } = require('../index');
const {
  executeServerApkInspection,
  authorizeTaskApkDownload,
  processCommandKioskSync,
  processInventoryUpdatedKioskSync,
  invokeCloudRunInspectorService,
  validateInspectorServiceUrl,
} = _testHelpers;

// ---------------------------------------------------------------------------
// Official Android Tooling Test Harness (keytool + official apksigner.jar)
// ---------------------------------------------------------------------------

function resolveTestJavaTool(toolName) {
  const candidates = [
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', toolName) : null,
    `/tmp/android-env/jdk-17/bin/${toolName}`,
    `/tmp/android-env/jdk-21/bin/${toolName}`,
    `/usr/bin/${toolName}`,
    toolName,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (candidate !== toolName && !fs.existsSync(candidate)) continue;
      const checkArgs = toolName === 'keytool' ? ['-help'] : ['-version'];
      execFileSync(candidate, checkArgs, {stdio: 'ignore', timeout: 5000});
      return candidate;
    } catch {
      // Try next
    }
  }
  return null;
}

const JAVA_BIN = resolveTestJavaTool('java');
const KEYTOOL_BIN = resolveTestJavaTool('keytool');
const HAS_JAVA = Boolean(JAVA_BIN && KEYTOOL_BIN);
const APKSIGNER_JAR = path.join(__dirname, '..', 'bin', 'apksigner.jar');

const TEST_WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'injaz_official_apk_suite_'));
process.on('exit', () => {
  try {
    fs.rmSync(TEST_WORK_DIR, {recursive: true, force: true});
  } catch {
    // Ignore cleanup errors
  }
});

function createKeystoreWithKeytool(alias, cn) {
  if (!HAS_JAVA) {
    const mockDer = Buffer.from(`mock_cert_der_${alias}_dname_${cn}`, 'utf8');
    return {
      ksPath: path.join(TEST_WORK_DIR, `${alias}.p12`),
      alias,
      pass: 'android123',
      certDer: mockDer,
      certSha256: sha256Hex(mockDer),
    };
  }
  const ksPath = path.join(TEST_WORK_DIR, `${alias}.p12`);
  execFileSync(
    KEYTOOL_BIN,
    [
      '-genkeypair',
      '-keystore',
      ksPath,
      '-storetype',
      'PKCS12',
      '-storepass',
      'android123',
      '-keypass',
      'android123',
      '-alias',
      alias,
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '3650',
      '-dname',
      `CN=${cn}, OU=Mobile, O=Injaz, L=Riyadh, S=Riyadh, C=SA`,
    ],
    {stdio: 'ignore'}
  );

  const certDer = execFileSync(
    KEYTOOL_BIN,
    [
      '-exportcert',
      '-keystore',
      ksPath,
      '-storetype',
      'PKCS12',
      '-storepass',
      'android123',
      '-alias',
      alias,
    ],
    {stdio: ['ignore', 'pipe', 'ignore']}
  );

  return {
    ksPath,
    alias,
    pass: 'android123',
    certDer: Buffer.from(certDer),
    certSha256: sha256Hex(certDer),
  };
}

const keystoreA = createKeystoreWithKeytool('signer_a', 'Injaz Enterprise Signer A');
const keystoreB = createKeystoreWithKeytool('signer_b', 'Injaz Enterprise Signer B');

function buildBinaryAxml({pkg, versionCode, versionName, appLabel = 'Injaz Enterprise'}) {
  const strings = [
    'manifest',
    'package',
    'versionCode',
    'versionName',
    'application',
    'label',
    pkg || '',
    versionName || '',
    appLabel || '',
  ];

  const strBuffers = strings.map(s => {
    const buf = Buffer.alloc(2 + s.length * 2 + 2);
    buf.writeUInt16LE(s.length, 0);
    for (let i = 0; i < s.length; i++) {
      buf.writeUInt16LE(s.charCodeAt(i), 2 + i * 2);
    }
    buf.writeUInt16LE(0, 2 + s.length * 2);
    return buf;
  });

  const offsets = [];
  let currentOffset = 0;
  for (const b of strBuffers) {
    offsets.push(currentOffset);
    currentOffset += b.length;
  }
  const padBytes = (4 - (currentOffset % 4)) % 4;
  const stringsStart = 28 + strings.length * 4;
  const spChunkSize = stringsStart + currentOffset + padBytes;

  const attrCount = (pkg ? 1 : 0) + (versionCode !== undefined ? 1 : 0) + (versionName ? 1 : 0);
  const elemChunkSize = 36 + attrCount * 20;
  const totalSize = 8 + spChunkSize + elemChunkSize;

  const out = Buffer.alloc(totalSize);
  out.writeUInt32LE(0x00080003, 0);
  out.writeUInt32LE(totalSize, 4);

  let pos = 8;
  out.writeUInt32LE(0x001c0001, pos);
  out.writeUInt32LE(spChunkSize, pos + 4);
  out.writeUInt32LE(strings.length, pos + 8);
  out.writeUInt32LE(0, pos + 12);
  out.writeUInt32LE(0, pos + 16);
  out.writeUInt32LE(stringsStart, pos + 20);
  out.writeUInt32LE(0, pos + 24);

  for (let i = 0; i < offsets.length; i++) {
    out.writeUInt32LE(offsets[i], pos + 28 + i * 4);
  }

  let sPos = pos + stringsStart;
  for (const b of strBuffers) {
    b.copy(out, sPos);
    sPos += b.length;
  }

  pos = 8 + spChunkSize;
  out.writeUInt32LE(0x00100102, pos);
  out.writeUInt32LE(elemChunkSize, pos + 4);
  out.writeInt32LE(0, pos + 20);
  out.writeUInt16LE(20, pos + 24);
  out.writeUInt16LE(20, pos + 26);
  out.writeUInt16LE(attrCount, pos + 28);

  let aIdx = 0;
  if (pkg) {
    const aOff = pos + 36 + aIdx * 20;
    out.writeInt32LE(1, aOff + 4);
    out.writeInt32LE(6, aOff + 8);
    out.writeUInt8(3, aOff + 15);
    out.writeInt32LE(6, aOff + 16);
    aIdx++;
  }
  if (versionCode !== undefined) {
    const aOff = pos + 36 + aIdx * 20;
    out.writeInt32LE(2, aOff + 4);
    out.writeInt32LE(-1, aOff + 8);
    out.writeUInt8(0x10, aOff + 15);
    out.writeInt32LE(versionCode, aOff + 16);
    aIdx++;
  }
  if (versionName) {
    const aOff = pos + 36 + aIdx * 20;
    out.writeInt32LE(3, aOff + 4);
    out.writeInt32LE(7, aOff + 8);
    out.writeUInt8(3, aOff + 15);
    out.writeInt32LE(7, aOff + 16);
    aIdx++;
  }

  return out;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const {name, data} of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const bodyBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const entryCrc = crc32(bodyBuf);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8); // STORED
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(entryCrc, 14);
    localHeader.writeUInt32LE(bodyBuf.length, 18);
    localHeader.writeUInt32LE(bodyBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    localParts.push(localHeader, bodyBuf);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(entryCrc, 16);
    centralHeader.writeUInt32LE(bodyBuf.length, 20);
    centralHeader.writeUInt32LE(bodyBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + bodyBuf.length;
  }

  const centralDirOffset = offset;
  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}

/**
 * Signs an unsigned APK buffer using the OFFICIAL Android `apksigner` CLI tool (`apksigner.jar`).
 */
function signApkWithOfficialApksigner(
  unsignedZipBuf,
  keystore,
  {v1 = false, v2 = true, v3 = false, minSdk = '24'} = {}
) {
  if (!HAS_JAVA) {
    return {
      signedBuf: unsignedZipBuf,
      cliVerifyStdout: `Signer #1 certificate SHA-256 digest: ${keystore.certSha256}\nSigner #1 certificate DN: CN=Injaz\n`,
      outPath: '/mock/out.apk',
    };
  }
  const id = crypto.randomBytes(6).toString('hex');
  const inPath = path.join(TEST_WORK_DIR, `in_${id}.apk`);
  const outPath = path.join(TEST_WORK_DIR, `out_${id}.apk`);
  fs.writeFileSync(inPath, unsignedZipBuf);

  execFileSync(
    JAVA_BIN,
    [
      '-jar',
      APKSIGNER_JAR,
      'sign',
      '--ks',
      keystore.ksPath,
      '--ks-pass',
      `pass:${keystore.pass}`,
      '--key-pass',
      `pass:${keystore.pass}`,
      '--ks-key-alias',
      keystore.alias,
      '--min-sdk-version',
      String(minSdk),
      '--v1-signing-enabled',
      String(v1),
      '--v2-signing-enabled',
      String(v2),
      '--v3-signing-enabled',
      String(v3),
      '--out',
      outPath,
      inPath,
    ],
    {stdio: 'ignore'}
  );

  const signedBuf = fs.readFileSync(outPath);
  const cliVerifyStdout = execFileSync(
    JAVA_BIN,
    [
      '-jar',
      APKSIGNER_JAR,
      'verify',
      '--verbose',
      '--print-certs',
      '--min-sdk-version',
      String(minSdk),
      outPath,
    ],
    {encoding: 'utf8'}
  );

  return {signedBuf, cliVerifyStdout, outPath};
}

// ---------------------------------------------------------------------------
// 1. Official `apksigner` Verification & Direct Comparison Against CLI Output
// ---------------------------------------------------------------------------

test('1. inspectApkBuffer verifies real APKs signed by official Android apksigner (v1, v2, v3, v2+v3) and matches apksigner verify --print-certs output directly', t => {
  if (!HAS_JAVA) {
    t.skip('البيئة المحلية لا تحتوي على أدوات Java (java/keytool) المعتمدة لتشغيل apksigner الكلاسيكي');
    return;
  }
  const axml = buildBinaryAxml({
    pkg: 'com.injaz.sales.field',
    versionCode: 18,
    versionName: '3.2.0',
  });
  const dexOriginal = Buffer.from('dex\n035\0official-apksigner-verified-code-v18', 'utf8');
  const unsignedApk = buildStoredZip([
    {name: 'AndroidManifest.xml', data: axml},
    {name: 'classes.dex', data: dexOriginal},
  ]);

  // 1A. Official v1-signed APK
  const v1Signed = signApkWithOfficialApksigner(unsignedApk, keystoreA, {
    v1: true,
    v2: false,
    v3: false,
    minSdk: '24',
  });
  const cliParsedV1 = parseApksignerVerifyOutput(v1Signed.cliVerifyStdout);
  const resV1 = inspectApkBuffer(v1Signed.signedBuf);
  assert.equal(resV1.packageName, 'com.injaz.sales.field');
  assert.equal(resV1.versionCode, 18);
  assert.equal(resV1.versionName, '3.2.0');
  assert.equal(resV1.signatureScheme, 'v1');
  assert.equal(resV1.sha256Cert, keystoreA.certSha256);
  assert.equal(resV1.sha256Cert, cliParsedV1.sha256Cert);
  assert.equal(resV1.publicKeySha256, cliParsedV1.publicKeySha256);
  assert.equal(resV1.certificateDn, cliParsedV1.certificateDn);
  assert.deepEqual(resV1.verifiedSchemes, {v1: true, v2: false, v3: false});

  // 1B. Official v2-signed APK
  const v2Signed = signApkWithOfficialApksigner(unsignedApk, keystoreA, {
    v1: false,
    v2: true,
    v3: false,
    minSdk: '24',
  });
  const cliParsedV2 = parseApksignerVerifyOutput(v2Signed.cliVerifyStdout);
  const resV2 = inspectApkBuffer(v2Signed.signedBuf);
  assert.equal(resV2.signatureScheme, 'v2');
  assert.equal(resV2.sha256Cert, keystoreA.certSha256);
  assert.equal(resV2.sha256Cert, cliParsedV2.sha256Cert);
  assert.equal(resV2.publicKeySha256, cliParsedV2.publicKeySha256);
  assert.deepEqual(resV2.verifiedSchemes, {v1: false, v2: true, v3: false});

  // 1C. Official v3-signed APK
  const v3Signed = signApkWithOfficialApksigner(unsignedApk, keystoreB, {
    v1: false,
    v2: false,
    v3: true,
    minSdk: '28',
  });
  const cliParsedV3 = parseApksignerVerifyOutput(v3Signed.cliVerifyStdout);
  const resV3 = inspectApkBuffer(v3Signed.signedBuf);
  assert.equal(resV3.signatureScheme, 'v3');
  assert.equal(resV3.sha256Cert, keystoreB.certSha256);
  assert.equal(resV3.sha256Cert, cliParsedV3.sha256Cert);
  assert.equal(resV3.publicKeySha256, cliParsedV3.publicKeySha256);
  assert.deepEqual(resV3.verifiedSchemes, {v1: false, v2: false, v3: true});

  // 1D. Official v2+v3-signed APK
  const v2v3Signed = signApkWithOfficialApksigner(unsignedApk, keystoreA, {
    v1: true,
    v2: true,
    v3: true,
    minSdk: '24',
  });
  const cliParsedV2V3 = parseApksignerVerifyOutput(v2v3Signed.cliVerifyStdout);
  const resV2V3 = inspectApkBuffer(v2v3Signed.signedBuf);
  assert.equal(resV2V3.signatureScheme, 'v2+v3');
  assert.equal(resV2V3.sha256Cert, cliParsedV2V3.sha256Cert);
  assert.deepEqual(resV2V3.verifiedSchemes, {
    v1: cliParsedV2V3.v1Verified,
    v2: true,
    v3: true,
  });
});

// ---------------------------------------------------------------------------
// 2. Comprehensive Adversarial Rejection Tests (v1, v2, v3)
// ---------------------------------------------------------------------------

test('2. inspectApkBuffer REJECTS synthetic v1 archive without .SF and without PKCS#7 signature, missing .SF, cert block without signature, modified content with recalculated MANIFEST.MF & CRC32, replaced cert, and corrupted signature', t => {
  if (!HAS_JAVA) {
    t.skip('البيئة المحلية لا تحتوي على أدوات Java (java/keytool) المعتمدة لتشغيل apksigner الكلاسيكي');
    return;
  }
  const axml = buildBinaryAxml({
    pkg: 'com.injaz.legacy.v1app',
    versionCode: 7,
    versionName: '1.0.7',
  });
  const dexBytes = Buffer.from('dex\n035\0clean-v1-classes-dex', 'utf8');
  const unsignedApk = buildStoredZip([
    {name: 'AndroidManifest.xml', data: axml},
    {name: 'classes.dex', data: dexBytes},
  ]);

  // -------------------------------------------------------------------------
  // Case A (Previously accepted flaw): Synthetic v1 archive with MANIFEST.MF +
  // artificial 24-byte prefix + DER cert in META-INF/CERT.RSA, NO .SF, NO PKCS#7 signature
  // -------------------------------------------------------------------------
  const manifestMf = [
    'Manifest-Version: 1.0',
    '',
    'Name: AndroidManifest.xml',
    `SHA-256-Digest: ${crypto.createHash('sha256').update(axml).digest('base64')}`,
    '',
    'Name: classes.dex',
    `SHA-256-Digest: ${crypto.createHash('sha256').update(dexBytes).digest('base64')}`,
    '',
  ].join('\r\n');

  const syntheticCertBlockWithoutPkcs7 = Buffer.concat([
    Buffer.alloc(24, 0x01),
    keystoreA.certDer,
  ]);

  const syntheticFakeV1Apk = buildStoredZip([
    {name: 'AndroidManifest.xml', data: axml},
    {name: 'classes.dex', data: dexBytes},
    {name: 'META-INF/MANIFEST.MF', data: Buffer.from(manifestMf, 'utf8')},
    {name: 'META-INF/CERT.RSA', data: syntheticCertBlockWithoutPkcs7},
  ]);

  assert.throws(
    () => inspectApkBuffer(syntheticFakeV1Apk),
    /فشل التحقق الرسمي من توقيع وسلامة APK عبر أداة Android الرسمية \(apksigner\)/,
    'Synthetic v1 archive without .SF and without valid PKCS#7 signature MUST be rejected'
  );

  // -------------------------------------------------------------------------
  // Build a genuine official v1-signed APK via apksigner to derive surgical tamper cases
  // -------------------------------------------------------------------------
  const realV1 = signApkWithOfficialApksigner(unsignedApk, keystoreA, {
    v1: true,
    v2: false,
    v3: false,
    minSdk: '24',
  });
  const v1Zip = parseZipArchive(realV1.signedBuf);
  const sfEntryName = Array.from(v1Zip.entries.keys()).find(
    k => k.startsWith('META-INF/') && k.endsWith('.SF')
  );
  const rsaEntryName = Array.from(v1Zip.entries.keys()).find(
    k => k.startsWith('META-INF/') && (k.endsWith('.RSA') || k.endsWith('.DSA') || k.endsWith('.EC'))
  );
  assert.ok(sfEntryName, 'Official v1 APK must contain META-INF/*.SF');
  assert.ok(rsaEntryName, 'Official v1 APK must contain META-INF/*.RSA');

  // -------------------------------------------------------------------------
  // Case B: Missing .SF file (keep real MANIFEST.MF and real PKCS#7 .RSA from apksigner)
  // -------------------------------------------------------------------------
  const entriesWithoutSf = [];
  for (const [entryName] of v1Zip.entries.entries()) {
    if (entryName === sfEntryName) continue;
    entriesWithoutSf.push({name: entryName, data: v1Zip.extractEntry(entryName)});
  }
  const apkMissingSf = buildStoredZip(entriesWithoutSf);
  assert.throws(
    () => inspectApkBuffer(apkMissingSf),
    /apksigner/,
    'v1 APK missing .SF file MUST be rejected even when .RSA is genuine'
  );

  // -------------------------------------------------------------------------
  // Case C: Certificate block (.RSA) without a cryptographic signature (valid .SF present)
  // -------------------------------------------------------------------------
  const entriesCertOnlyNoSig = [];
  for (const [entryName] of v1Zip.entries.entries()) {
    if (entryName === rsaEntryName) {
      entriesCertOnlyNoSig.push({name: entryName, data: keystoreA.certDer});
    } else {
      entriesCertOnlyNoSig.push({name: entryName, data: v1Zip.extractEntry(entryName)});
    }
  }
  const apkCertWithoutSignature = buildStoredZip(entriesCertOnlyNoSig);
  assert.throws(
    () => inspectApkBuffer(apkCertWithoutSignature),
    /apksigner/,
    'v1 APK with .SF and raw certificate block lacking PKCS#7 signature MUST be rejected'
  );

  // -------------------------------------------------------------------------
  // Case D: Modified classes.dex WITH recalculated MANIFEST.MF SHA-256 AND recalculated ZIP CRC32
  //         (keeping original .SF and .RSA from official apksigner)
  // -------------------------------------------------------------------------
  const tamperedDex = Buffer.from('dex\n035\0MODIFIED-WITH-RECALCULATED-MANIFEST-AND-CRC', 'utf8');
  const recalculatedManifestMf = [
    'Manifest-Version: 1.0',
    'Created-By: 1.0 (Android)',
    '',
    'Name: AndroidManifest.xml',
    `SHA-256-Digest: ${crypto.createHash('sha256').update(axml).digest('base64')}`,
    '',
    'Name: classes.dex',
    `SHA-256-Digest: ${crypto.createHash('sha256').update(tamperedDex).digest('base64')}`,
    '',
  ].join('\r\n');

  const apkModifiedWithRecalculatedManifestAndCrc = buildStoredZip([
    {name: 'AndroidManifest.xml', data: axml},
    {name: 'classes.dex', data: tamperedDex},
    {name: 'META-INF/MANIFEST.MF', data: Buffer.from(recalculatedManifestMf, 'utf8')},
    {name: sfEntryName, data: v1Zip.extractEntry(sfEntryName)},
    {name: rsaEntryName, data: v1Zip.extractEntry(rsaEntryName)},
  ]);
  assert.throws(
    () => inspectApkBuffer(apkModifiedWithRecalculatedManifestAndCrc),
    /apksigner/,
    'APK with modified classes.dex and recalculated MANIFEST.MF + ZIP CRC32 MUST be rejected'
  );

  // -------------------------------------------------------------------------
  // Case E: Certificate modified/replaced inside a real v2-signed APK
  // -------------------------------------------------------------------------
  const realV2 = signApkWithOfficialApksigner(unsignedApk, keystoreA, {
    v1: false,
    v2: true,
    v3: false,
    minSdk: '24',
  });
  const certIdxInV2 = realV2.signedBuf.indexOf(keystoreA.certDer);
  assert.ok(certIdxInV2 > 0, 'Signer A certDer must be present in v2 signing block');
  const v2WithModifiedCert = Buffer.from(realV2.signedBuf);
  // Flip bytes inside the embedded X.509 certificate in the signing block
  v2WithModifiedCert[certIdxInV2 + 20] ^= 0xff;
  v2WithModifiedCert[certIdxInV2 + 21] ^= 0xff;
  assert.throws(
    () => inspectApkBuffer(v2WithModifiedCert),
    /apksigner/,
    'v2 APK with modified/replaced certificate bytes MUST be rejected'
  );

  // -------------------------------------------------------------------------
  // Case F: Corrupted cryptographic signature bytes in real v1 and v2 APKs
  // -------------------------------------------------------------------------
  // F1: Corrupt signature tail in v1 .RSA
  const corruptedRsa = Buffer.from(v1Zip.extractEntry(rsaEntryName));
  corruptedRsa[corruptedRsa.length - 8] ^= 0xff;
  corruptedRsa[corruptedRsa.length - 7] ^= 0xff;
  const v1CorruptedSigApk = buildStoredZip([
    {name: 'AndroidManifest.xml', data: axml},
    {name: 'classes.dex', data: dexBytes},
    {name: 'META-INF/MANIFEST.MF', data: v1Zip.extractEntry('META-INF/MANIFEST.MF')},
    {name: sfEntryName, data: v1Zip.extractEntry(sfEntryName)},
    {name: rsaEntryName, data: corruptedRsa},
  ]);
  assert.throws(
    () => inspectApkBuffer(v1CorruptedSigApk),
    /apksigner/,
    'v1 APK with corrupted PKCS#7 signature bytes MUST be rejected'
  );

  // F2: Corrupt the RSA signature bytes immediately following signedData/certDer in v2 Signing Block
  const v2CorruptedSigApk = Buffer.from(realV2.signedBuf);
  const sigBytePos = certIdxInV2 + keystoreA.certDer.length + 28;
  v2CorruptedSigApk[sigBytePos] ^= 0xff;
  v2CorruptedSigApk[sigBytePos + 1] ^= 0xff;
  assert.throws(
    () => inspectApkBuffer(v2CorruptedSigApk),
    /apksigner/,
    'v2 APK with corrupted signature block bytes MUST be rejected'
  );
});

// ---------------------------------------------------------------------------
// 3. Server Inspection Binding & Fail-Closed When Inspection Runtime Unavailable
// ---------------------------------------------------------------------------

test('3. executeServerApkInspection keeps app in pending_inspection (no fallback acceptance) when official apksigner environment is unavailable, and binds verified result to storage_path, generation, and sha256_apk when available', async () => {
  const axml = buildBinaryAxml({
    pkg: 'com.injaz.erp.mobile',
    versionCode: 25,
    versionName: '4.1.0',
  });
  const cleanZip = buildStoredZip([
    {name: 'AndroidManifest.xml', data: axml},
    {name: 'classes.dex', data: Buffer.from('dex\n035\0clean-erp-v25', 'utf8')},
  ]);
  const {signedBuf: validApkBuf} = signApkWithOfficialApksigner(cleanZip, keystoreA, {
    v1: true,
    v2: true,
    v3: true,
    minSdk: '24',
  });
  const validApkSha = sha256Hex(validApkBuf);

  const docs = new Map();
  docs.set('admins/admin_1', {active: true});
  docs.set('companyApps/app_25', {
    app_name: 'Injaz ERP',
    package_name: 'com.injaz.erp.mobile',
    version_code: 25,
    version_name: '4.1.0',
    storage_path: 'company_apps/app_25/erp.apk',
    sha256_apk: validApkSha,
    inspection_status: 'pending_inspection',
    inspected_by_server: false,
  });

  let storageFileBuffer = validApkBuf;
  let storageGeneration = 'gen_1001';

  const mockDb = {
    doc: docPath => ({
      path: docPath,
      get: async () => ({
        exists: docs.has(docPath),
        data: () => docs.get(docPath),
      }),
      update: async updates => {
        docs.set(docPath, {...(docs.get(docPath) || {}), ...updates});
      },
    }),
  };

  const storageReader = async storagePath => {
    assert.ok(storagePath.endsWith('/erp.apk'));
    return {
      buffer: storageFileBuffer,
      generation: storageGeneration,
      size: storageFileBuffer.length,
      contentType: 'application/vnd.android.package-archive',
    };
  };

  // 3A. Simulate unavailable official inspection environment -> MUST stay pending_inspection and block distribution
  await assert.rejects(
    () =>
      executeServerApkInspection({
        appId: 'app_25',
        auth: {uid: 'admin_1', token: {admin: true, email_verified: true, email: 'admin@injaz.sa'}},
        firestoreDb: mockDb,
        storageReader,
        inspectorOptions: {forceEnvironmentUnavailable: true},
        serverTimestampFn: () => 'SERVER_TS',
      }),
    err => err.code === 'failed-precondition' && /غير متوفرة/.test(err.message)
  );

  const pendingDocAfterUnavailable = docs.get('companyApps/app_25');
  assert.equal(
    pendingDocAfterUnavailable.inspection_status,
    'pending_inspection',
    'App MUST remain pending_inspection when official apksigner runtime is unavailable'
  );
  assert.equal(
    pendingDocAfterUnavailable.inspected_by_server,
    false,
    'inspected_by_server MUST remain false when official apksigner runtime is unavailable'
  );

  // 3B. Now run with available official apksigner -> verifies and binds storage_generation & sha256_apk
  const mockCustomRunner = HAS_JAVA
    ? undefined
    : () => `Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): false
Signer #1 certificate SHA-256 digest: ${keystoreA.certSha256}
Signer #1 certificate DN: CN=Injaz Enterprise Signer A
Signer #1 public key SHA-256 digest: ${keystoreA.certSha256}
`;

  const verifiedRes = await executeServerApkInspection({
    appId: 'app_25',
    auth: {uid: 'admin_1', token: {admin: true, email_verified: true, email: 'admin@injaz.sa'}},
    firestoreDb: mockDb,
    storageReader,
    inspectorOptions: HAS_JAVA ? {} : {customRunner: mockCustomRunner},
    serverTimestampFn: () => 'SERVER_TS',
  });

  assert.equal(verifiedRes.inspection_status, 'verified');
  assert.equal(verifiedRes.inspected_by_server, true);
  assert.equal(verifiedRes.storage_generation, 'gen_1001');
  assert.equal(verifiedRes.sha256_cert, keystoreA.certSha256);

  // 3C. Attempting to re-inspect after replacing the file generation in Storage must be rejected!
  storageGeneration = 'gen_REPLACED_AFTER_VERIFY';
  await assert.rejects(
    () =>
      executeServerApkInspection({
        appId: 'app_25',
        auth: {uid: 'admin_1', token: {admin: true, email_verified: true, email: 'admin@injaz.sa'}},
        firestoreDb: mockDb,
        storageReader,
        serverTimestampFn: () => 'SERVER_TS',
      }),
    /تم رصد استبدال ملف APK بعد اعتماده/
  );
});

// ---------------------------------------------------------------------------
// 4. Task-Bound Storage Permissions & Download Authorization Tests
// ---------------------------------------------------------------------------

test('4. authorizeTaskApkDownload allows targeted approved device, returns requiresFirebaseAuthToken=false for pre-signed URLs, rejects non-targeted device, and rejects after cancellation, expiration, or file replacement', async () => {
  const futureIso = new Date(Date.now() + 3600_000).toISOString();
  const pastIso = new Date(Date.now() - 3600_000).toISOString();

  const docs = new Map([
    ['enrollments/device_target', {approved: true}],
    ['deviceStatus/device_target', {device_owner: true, deprovisioned: false}],
    ['enrollments/device_other', {approved: true}],
    ['deviceStatus/device_other', {device_owner: true, deprovisioned: false}],
    [
      'companyApps/app_1',
      {
        package_name: 'com.injaz.sales.field',
        version_code: 18,
        storage_path: 'company_apps/app_1/sales.apk',
        storage_generation: 'gen_555',
        sha256_apk: 'a'.repeat(64),
        sha256_cert: keystoreA.certSha256,
        inspection_status: 'verified',
        inspected_by_server: true,
      },
    ],
    [
      'deviceCommands/device_target/commands/cmd_1',
      {
        type: 'install_app',
        app_id: 'app_1',
        package_name: 'com.injaz.sales.field',
        version_code: 18,
        sha256_apk: 'a'.repeat(64),
        sha256_cert: keystoreA.certSha256,
        status: 'pending',
        cancelled: false,
        expires_at: futureIso,
      },
    ],
    [
      'deviceDownloadGrants/device_target/apps/app_1',
      {
        status: 'active',
        command_id: 'cmd_1',
        app_id: 'app_1',
        storage_path: 'company_apps/app_1/sales.apk',
        expires_at: futureIso,
      },
    ],
  ]);

  let currentStorageGen = 'gen_555';

  const mockDb = {
    doc: docPath => ({
      path: docPath,
      get: async () => ({
        exists: docs.has(docPath),
        data: () => docs.get(docPath),
      }),
    }),
  };

  const storageSigner = async ({storagePath, expectedGeneration, expiresAtMs}) => {
    if (expectedGeneration && String(currentStorageGen) !== String(expectedGeneration)) {
      throw Object.assign(
        new Error('تغيرت نسخة الملف في التخزين بعد الاعتماد؛ تم حظر التنزيل'),
        {code: 'permission-denied'}
      );
    }
    return {
      url: `https://storage.googleapis.com/vansales-mdm.appspot.com/${storagePath}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=deadbeef&exp=${expiresAtMs}`,
      expiresAtMs,
    };
  };

  const okAuth = await authorizeTaskApkDownload({
    auth: {uid: 'device_target'},
    uid: 'device_target',
    cmdId: 'cmd_1',
    appId: 'app_1',
    firestoreDb: mockDb,
    storageSigner,
  });
  assert.equal(okAuth.packageName, 'com.injaz.sales.field');
  assert.equal(okAuth.versionCode, 18);
  assert.equal(okAuth.requiresFirebaseAuthToken, false);
  assert.match(okAuth.downloadUrl, /^https:\/\/storage\.googleapis\.com\//);

  // Non-targeted approved device -> REJECTED
  await assert.rejects(
    () =>
      authorizeTaskApkDownload({
        auth: {uid: 'device_other'},
        uid: 'device_target',
        cmdId: 'cmd_1',
        appId: 'app_1',
        firestoreDb: mockDb,
        storageSigner,
      }),
    err => err.code === 'permission-denied'
  );

  // Cancelled command -> REJECTED
  docs.set('deviceCommands/device_target/commands/cmd_1', {
    ...docs.get('deviceCommands/device_target/commands/cmd_1'),
    status: 'cancelled',
    cancelled: true,
  });
  await assert.rejects(
    () =>
      authorizeTaskApkDownload({
        auth: {uid: 'device_target'},
        uid: 'device_target',
        cmdId: 'cmd_1',
        appId: 'app_1',
        firestoreDb: mockDb,
        storageSigner,
      }),
    err => err.code === 'permission-denied' && /تم إلغاؤه/.test(err.message)
  );

  // Expired grant -> REJECTED
  docs.set('deviceCommands/device_target/commands/cmd_1', {
    ...docs.get('deviceCommands/device_target/commands/cmd_1'),
    status: 'pending',
    cancelled: false,
  });
  docs.set('deviceDownloadGrants/device_target/apps/app_1', {
    ...docs.get('deviceDownloadGrants/device_target/apps/app_1'),
    status: 'active',
    expires_at: pastIso,
  });
  await assert.rejects(
    () =>
      authorizeTaskApkDownload({
        auth: {uid: 'device_target'},
        uid: 'device_target',
        cmdId: 'cmd_1',
        appId: 'app_1',
        firestoreDb: mockDb,
        storageSigner,
      }),
    err => err.code === 'permission-denied' && /انتهت صلاحية/.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// 5. Kiosk App Addition Authority, Mandatory Real Inventory, Waiting Retry & Idempotency
// ---------------------------------------------------------------------------

function createTransactionalMockDb(initialDocs) {
  const store = new Map(Object.entries(initialDocs));
  const createdAudits = [];

  const makeDocRef = docPath => ({
    path: docPath,
    get: async () => ({
      exists: store.has(docPath),
      data: () => (store.has(docPath) ? structuredClone(store.get(docPath)) : undefined),
    }),
    update: async updates => {
      const prev = store.get(docPath) || {};
      store.set(docPath, {...prev, ...updates});
    },
    set: async (data, opts) => {
      if (docPath.startsWith('auditLogs/')) {
        createdAudits.push({path: docPath, data});
      }
      const prev = store.get(docPath) || {};
      store.set(docPath, opts && opts.merge ? {...prev, ...data} : structuredClone(data));
    },
  });

  return {
    store,
    createdAudits,
    doc: docPath => makeDocRef(docPath),
    collection: colName => ({
      doc: () => makeDocRef(`${colName}/audit_${createdAudits.length + 1}`),
      get: async () => {
        const prefix = `${colName}/`;
        const docs = [];
        for (const [k, v] of store.entries()) {
          if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) {
            const id = k.slice(prefix.length);
            docs.push({
              id,
              data: () => structuredClone(v),
            });
          }
        }
        return {docs, empty: docs.length === 0};
      },
    }),
    runTransaction: async fn => {
      const tx = {
        get: async ref => ref.get(),
        update: (ref, updates) => ref.update(updates),
        set: (ref, data, opts) => ref.set(data, opts),
      };
      return fn(tx);
    },
  };
}

test('5. processCommandKioskSync prevents phone from requesting Kiosk addition when admin set add_to_kiosk=false', async () => {
  const db = createTransactionalMockDb({
    'enrollments/dev_1': {approved: true},
    'deviceStatus/dev_1': {device_owner: true, android_sdk: 33, deprovisioned: false},
    'policies/dev_1': {blocked_apps: []},
    'kioskPolicies/dev_1': {
      schema_version: 1,
      revision: 4,
      enabled: true,
      allowed_apps: ['com.company.base'],
      exit_salt: 'a'.repeat(32),
      exit_hash: 'b'.repeat(64),
    },
    'deviceCommands/dev_1/commands/cmd_no_kiosk': {
      type: 'install_app',
      package_name: 'com.company.newapp',
      version_code: 10,
      installed_version: 10,
      add_to_kiosk: false,
      add_to_kiosk_requested: true,
      status: 'executed',
      cancelled: false,
    },
  });

  const res = await processCommandKioskSync({
    uid: 'dev_1',
    cmdId: 'cmd_no_kiosk',
    firestoreDb: db,
    wakeFn: async () => {},
    serverTimestampFn: () => 'TS',
  });

  assert.equal(res.action, 'ignored_not_requested_by_admin');
  assert.equal(db.store.get('kioskPolicies/dev_1').revision, 4);
  assert.deepEqual(db.store.get('kioskPolicies/dev_1').allowed_apps, ['com.company.base']);
  assert.equal(db.createdAudits.length, 0);
});

test('6. processCommandKioskSync NEVER skips missing inventory when Kiosk is enabled: sets waiting_for_inventory and automatically completes addition when deviceAppInventory/{uid} arrives', async () => {
  const db = createTransactionalMockDb({
    'enrollments/dev_1': {approved: true},
    'deviceStatus/dev_1': {device_owner: true, android_sdk: 33, deprovisioned: false},
    'policies/dev_1': {blocked_apps: []},
    // Inventory currently contains only the base app; com.company.newapp has NOT arrived in inventory yet!
    'deviceAppInventory/dev_1': {
      apps: [
        {
          package_name: 'com.company.base',
          is_enabled: true,
          has_launcher_icon: true,
          is_hidden_by_agent: false,
        },
      ],
    },
    'kioskPolicies/dev_1': {
      schema_version: 1,
      revision: 4,
      enabled: true,
      allowed_apps: ['com.company.base'],
      exit_salt: 'a'.repeat(32),
      exit_hash: 'b'.repeat(64),
    },
    'deviceCommands/dev_1/commands/cmd_kiosk_delayed_inv': {
      type: 'install_app',
      package_name: 'com.company.newapp',
      version_code: 15,
      installed_version: 15,
      add_to_kiosk: true,
      status: 'executed',
      cancelled: false,
      created_by_uid: 'admin_1',
      created_by_email: 'admin@injaz.sa',
    },
  });

  // Step 1: Install confirmation arrives BEFORE inventory has com.company.newapp
  // MUST NOT bypass inventory check, and MUST NOT fail permanently -> records waiting_for_inventory
  const waitRes = await processCommandKioskSync({
    uid: 'dev_1',
    cmdId: 'cmd_kiosk_delayed_inv',
    firestoreDb: db,
    wakeFn: async () => {},
    serverTimestampFn: () => 'TS',
  });

  assert.equal(waitRes.action, 'waiting_for_inventory');
  assert.equal(
    db.store.get('deviceCommands/dev_1/commands/cmd_kiosk_delayed_inv').kiosk_addition_status,
    'waiting_for_inventory'
  );
  assert.equal(
    db.store.get('kioskPolicies/dev_1').revision,
    4,
    'Kiosk policy revision must not increment before app is confirmed in inventory'
  );
  assert.deepEqual(db.store.get('kioskPolicies/dev_1').allowed_apps, ['com.company.base']);
  assert.equal(db.createdAudits.length, 0);

  // Step 2: Phone publishes updated deviceAppInventory/{uid} containing com.company.newapp with has_launcher_icon === true
  db.store.set('deviceAppInventory/dev_1', {
    apps: [
      {
        package_name: 'com.company.base',
        is_enabled: true,
        has_launcher_icon: true,
        is_hidden_by_agent: false,
      },
      {
        package_name: 'com.company.newapp',
        is_enabled: true,
        has_launcher_icon: true,
        is_hidden_by_agent: false,
      },
    ],
  });

  const retryRes = await processInventoryUpdatedKioskSync({
    uid: 'dev_1',
    firestoreDb: db,
    wakeFn: async () => {
      throw new Error('FCM temporary outage');
    },
    serverTimestampFn: () => 'TS',
  });

  assert.equal(retryRes.processed, 1);
  assert.equal(retryRes.outcomes[0].action, 'added');
  assert.equal(retryRes.outcomes[0].revision, 5);
  assert.equal(db.store.get('kioskPolicies/dev_1').revision, 5);
  assert.deepEqual(db.store.get('kioskPolicies/dev_1').allowed_apps, [
    'com.company.base',
    'com.company.newapp',
  ]);
  assert.equal(
    db.store.get('deviceCommands/dev_1/commands/cmd_kiosk_delayed_inv').kiosk_addition_status,
    'added'
  );
  assert.equal(db.createdAudits.length, 1);

  // Step 3: Duplicate inventory or command triggers MUST be idempotent (no second increment or audit log)
  const dupRes = await processCommandKioskSync({
    uid: 'dev_1',
    cmdId: 'cmd_kiosk_delayed_inv',
    firestoreDb: db,
    wakeFn: async () => {},
    serverTimestampFn: () => 'TS',
  });
  assert.equal(dupRes.action, 'noop_already_added');
  assert.equal(db.store.get('kioskPolicies/dev_1').revision, 5);
  assert.equal(db.createdAudits.length, 1);
});

test('7. processCommandKioskSync rejects apps without launcher icon (has_launcher_icon !== true), blocked apps, and version mismatch', async () => {
  // Case A: App arrives in inventory with has_launcher_icon: false -> rejected
  const dbNoLauncher = createTransactionalMockDb({
    'enrollments/dev_1': {approved: true},
    'deviceStatus/dev_1': {device_owner: true, android_sdk: 33, deprovisioned: false},
    'policies/dev_1': {blocked_apps: []},
    'deviceAppInventory/dev_1': {
      apps: [
        {
          package_name: 'com.company.headless',
          is_enabled: true,
          has_launcher_icon: false,
          is_hidden_by_agent: false,
        },
      ],
    },
    'kioskPolicies/dev_1': {
      schema_version: 1,
      revision: 2,
      enabled: true,
      allowed_apps: ['com.company.base'],
      exit_salt: 'a'.repeat(32),
      exit_hash: 'b'.repeat(64),
    },
    'deviceCommands/dev_1/commands/cmd_headless': {
      type: 'install_app',
      package_name: 'com.company.headless',
      version_code: 3,
      installed_version: 3,
      add_to_kiosk: true,
      status: 'executed',
      cancelled: false,
    },
  });

  const noLauncherRes = await processCommandKioskSync({
    uid: 'dev_1',
    cmdId: 'cmd_headless',
    firestoreDb: dbNoLauncher,
    wakeFn: async () => {},
    serverTimestampFn: () => 'TS',
  });
  assert.equal(noLauncherRes.action, 'failed');
  assert.match(noLauncherRes.error, /has_launcher_icon/);
  assert.equal(dbNoLauncher.store.get('kioskPolicies/dev_1').revision, 2);

  // Case B: App is in policies/{uid}.blocked_apps -> rejected
  const dbBlocked = createTransactionalMockDb({
    'enrollments/dev_1': {approved: true},
    'deviceStatus/dev_1': {device_owner: true, android_sdk: 33, deprovisioned: false},
    'policies/dev_1': {blocked_apps: ['com.company.blockedapp']},
    'deviceAppInventory/dev_1': {
      apps: [
        {
          package_name: 'com.company.blockedapp',
          is_enabled: true,
          has_launcher_icon: true,
          is_hidden_by_agent: false,
        },
      ],
    },
    'kioskPolicies/dev_1': {
      schema_version: 1,
      revision: 2,
      enabled: true,
      allowed_apps: ['com.company.base'],
      exit_salt: 'a'.repeat(32),
      exit_hash: 'b'.repeat(64),
    },
    'deviceCommands/dev_1/commands/cmd_blocked': {
      type: 'install_app',
      package_name: 'com.company.blockedapp',
      version_code: 3,
      installed_version: 3,
      add_to_kiosk: true,
      status: 'executed',
      cancelled: false,
    },
  });

  const blockedRes = await processCommandKioskSync({
    uid: 'dev_1',
    cmdId: 'cmd_blocked',
    firestoreDb: dbBlocked,
    wakeFn: async () => {},
    serverTimestampFn: () => 'TS',
  });

  assert.equal(blockedRes.action, 'failed');
  assert.match(blockedRes.error, /المحظورة/);
  assert.equal(dbBlocked.store.get('kioskPolicies/dev_1').revision, 2);
});

test('8. functions index exports all old and new triggers and isolated Cloud Run inspector server enforces admin auth, verifies APKs via apksigner.jar, and fails closed when runtime is unavailable', async () => {
  const {EventEmitter} = require('node:events');
  const fnModule = require('../index');
  const {createInspectorRequestHandler} = require('../cloudRunInspectorServer');

  const expectedExports = [
    'registerMdmPush',
    'inspectCompanyApk',
    'getTaskDownloadAuthorization',
    'mdmPolicyChanged',
    'mdmEnrollmentChanged',
    'mdmPushRegistered',
    'mdmKioskChanged',
    'cleanupOldLocationPoints',
    'onCommandCompletedKioskSync',
    'onInventoryUpdatedKioskSync',
  ];
  for (const name of expectedExports) {
    assert.equal(typeof fnModule[name], 'function', `Expected export ${name} to be a function`);
  }
  assert.ok(fs.existsSync(APKSIGNER_JAR), 'Bundled functions/bin/apksigner.jar must exist');

  const axml = buildBinaryAxml({
    pkg: 'com.injaz.cloudrun.app',
    versionCode: 31,
    versionName: '5.0.0',
  });
  const cleanZip = buildStoredZip([
    {name: 'AndroidManifest.xml', data: axml},
    {name: 'classes.dex', data: Buffer.from('dex\n035\0cloudrun-inspector-v31', 'utf8')},
  ]);
  const {signedBuf: validApkBuf} = signApkWithOfficialApksigner(cleanZip, keystoreA, {
    v1: false,
    v2: true,
    v3: true,
    minSdk: '24',
  });
  const validApkSha = sha256Hex(validApkBuf);

  const docs = new Map([
    ['admins/admin_cr', {active: true}],
    [
      'companyApps/app_cr_31',
      {
        app_name: 'CloudRun App',
        package_name: 'com.injaz.cloudrun.app',
        version_code: 31,
        version_name: '5.0.0',
        storage_path: 'company_apps/app_cr_31/release.apk',
        sha256_apk: validApkSha,
        inspection_status: 'pending_inspection',
        inspected_by_server: false,
      },
    ],
  ]);

  const mockDb = {
    doc: docPath => ({
      path: docPath,
      get: async () => ({
        exists: docs.has(docPath),
        data: () => docs.get(docPath),
      }),
      update: async updates => {
        docs.set(docPath, {...(docs.get(docPath) || {}), ...updates});
      },
    }),
  };

  const storageReader = async () => ({
    buffer: validApkBuf,
    generation: 'gen_cr_31',
    size: validApkBuf.length,
    contentType: 'application/vnd.android.package-archive',
  });

  async function invokeHttp(handler, {method = 'POST', url = '/inspectCompanyApk', headers = {}, body = null}) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = headers;
    let statusCode = 200;
    let resBody = '';
    const res = {
      writeHead(code) {
        statusCode = code;
      },
      end(str) {
        resBody = str || '';
      },
    };
    const promise = handler(req, res);
    if (body !== null) {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    }
    req.emit('end');
    await promise;
    return {statusCode, json: resBody ? JSON.parse(resBody) : null};
  }

  // 8A. Health check when apksigner is unavailable -> 503
  const unavailableHandler = createInspectorRequestHandler({
    firestoreDb: mockDb,
    storageReader,
    inspectorOptions: {forceEnvironmentUnavailable: true},
    verifyIdTokenFn: async () => ({
      uid: 'admin_cr',
      email: 'admin@injaz.sa',
      email_verified: true,
      admin: true,
    }),
    serverTimestampFn: () => 'TS',
  });
  const health503 = await invokeHttp(unavailableHandler, {method: 'GET', url: '/healthz'});
  assert.equal(health503.statusCode, 503);
  assert.equal(health503.json.apksignerReady, false);

  // 8B. Inspection when apksigner is unavailable -> 412 and keeps pending_inspection
  const inspect412 = await invokeHttp(unavailableHandler, {
    headers: {authorization: 'Bearer valid-admin-token'},
    body: {data: {appId: 'app_cr_31'}},
  });
  assert.equal(inspect412.statusCode, 412);
  assert.equal(docs.get('companyApps/app_cr_31').inspection_status, 'pending_inspection');
  assert.equal(docs.get('companyApps/app_cr_31').inspected_by_server, false);

  // 8C. Unauthenticated request -> 401
  const crMockCustomRunner = HAS_JAVA
    ? undefined
    : () => `Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): false
Signer #1 certificate SHA-256 digest: ${keystoreA.certSha256}
Signer #1 certificate DN: CN=Injaz Enterprise Signer A
Signer #1 public key SHA-256 digest: ${keystoreA.certSha256}
`;

  const readyHandler = createInspectorRequestHandler({
    firestoreDb: mockDb,
    storageReader,
    verifyIdTokenFn: async token => {
      if (token !== 'valid-admin-token') throw new Error('invalid token');
      return {
        uid: 'admin_cr',
        email: 'admin@injaz.sa',
        email_verified: true,
        admin: true,
      };
    },
    serverTimestampFn: () => 'TS',
    inspectorOptions: HAS_JAVA ? {} : {customRunner: crMockCustomRunner},
  });
  const unauthRes = await invokeHttp(readyHandler, {body: {appId: 'app_cr_31'}});
  assert.equal(unauthRes.statusCode, 401);

  // 8D. Authenticated admin request with available Java + apksigner.jar -> 200 verified
  const okRes = await invokeHttp(readyHandler, {
    headers: {authorization: 'Bearer valid-admin-token'},
    body: {data: {appId: 'app_cr_31'}},
  });
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.json.result.inspection_status, 'verified');
  assert.equal(okRes.json.result.inspected_by_server, true);
  assert.equal(okRes.json.result.storage_generation, 'gen_cr_31');
  assert.equal(okRes.json.result.sha256_cert, keystoreA.certSha256);
});

test('9. Connected Pipeline Test: inspectCompanyApk -> invokeCloudRunInspectorService -> real local HTTP Inspector Server', async () => {
  const http = require('node:http');
  const {createInspectorRequestHandler} = require('../cloudRunInspectorServer');

  const axml = buildBinaryAxml({
    pkg: 'com.injaz.connected.pipeline',
    versionCode: 42,
    versionName: '6.0.0',
  });
  const unsignedZip = buildStoredZip([
    {name: 'AndroidManifest.xml', data: axml},
    {name: 'classes.dex', data: Buffer.from('dex\n035\0connected-pipeline-v42', 'utf8')},
  ]);

  let validApkBuf = unsignedZip;
  if (HAS_JAVA) {
    const signed = signApkWithOfficialApksigner(unsignedZip, keystoreA, {v1: true, v2: true, minSdk: '24'});
    validApkBuf = signed.signedBuf;
  }
  const validSha = sha256Hex(validApkBuf);

  // REAL Tampered APK: modify bytes AFTER signing without re-signing!
  const tamperedApkBuf = Buffer.from(validApkBuf);
  if (tamperedApkBuf.length > 50) {
    tamperedApkBuf[Math.floor(tamperedApkBuf.length / 2)] ^= 0xff;
    tamperedApkBuf[Math.floor(tamperedApkBuf.length / 2) + 1] ^= 0xff;
  }

  const docs = new Map([
    ['admins/admin_conn', {active: true}],
    ['admins/user_regular', {active: false}],
    [
      'companyApps/app_valid',
      {
        app_name: 'Connected App Valid',
        package_name: 'com.injaz.connected.pipeline',
        version_code: 42,
        version_name: '6.0.0',
        storage_path: 'company_apps/app_valid/app-release.apk',
        sha256_apk: validSha,
        inspection_status: 'pending_inspection',
        inspected_by_server: false,
      },
    ],
    [
      'companyApps/app_tampered',
      {
        app_name: 'Connected App Tampered',
        package_name: 'com.injaz.connected.pipeline',
        version_code: 42,
        version_name: '6.0.0',
        storage_path: 'company_apps/app_tampered/app-release.apk',
        sha256_apk: sha256Hex(tamperedApkBuf),
        inspection_status: 'pending_inspection',
        inspected_by_server: false,
      },
    ],
  ]);

  const mockDb = {
    doc: docPath => ({
      path: docPath,
      get: async () => ({
        exists: docs.has(docPath),
        data: () => docs.get(docPath),
      }),
      update: async updates => {
        docs.set(docPath, {...(docs.get(docPath) || {}), ...updates});
      },
    }),
  };

  const storageReader = async storagePath => {
    const isTampered = storagePath.includes('app_tampered');
    const buf = isTampered ? tamperedApkBuf : validApkBuf;
    return {
      buffer: buf,
      generation: 'gen_conn_101',
      size: buf.length,
      contentType: 'application/vnd.android.package-archive',
    };
  };

  let lastReceivedHeaders = null;

  const mockCustomRunner = HAS_JAVA
    ? undefined
    : () => `Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): false
Signer #1 certificate SHA-256 digest: ${keystoreA.certSha256}
Signer #1 certificate DN: CN=Injaz Enterprise Signer A
Signer #1 public key SHA-256 digest: ${keystoreA.certSha256}
`;

  const inspectorHandler = createInspectorRequestHandler({
    firestoreDb: mockDb,
    storageReader,
    verifyIdTokenFn: async token => {
      if (token === 'real-admin-firebase-token') {
        return {uid: 'admin_conn', email: 'admin@injaz.sa', email_verified: true, admin: true};
      }
      throw Object.assign(new Error('Invalid token'), {code: 'unauthenticated'});
    },
    serverTimestampFn: () => 'TS',
    inspectorOptions: HAS_JAVA ? {} : {customRunner: mockCustomRunner},
  });

  const server = http.createServer((req, res) => {
    lastReceivedHeaders = req.headers;
    return inspectorHandler(req, res);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;
  const inspectorServerUrl = `http://127.0.0.1:${serverPort}`;

  try {
    // 9A. Valid signed APK -> APPROVED (200 verified)
    const validRes = await invokeCloudRunInspectorService({
      inspectorUrl: inspectorServerUrl,
      appId: 'app_valid',
      auth: {
        uid: 'admin_conn',
        token: {admin: true, email: 'admin@injaz.sa', email_verified: true},
      },
      firebaseAuthToken: 'real-admin-firebase-token',
      getIdTokenFn: async () => 'mock-iam-oidc-token-123',
      firestoreDb: mockDb,
      allowLocalHttpForTest: true,
    });

    assert.equal(validRes.inspection_status, 'verified');
    assert.equal(validRes.inspected_by_server, true);
    assert.equal(docs.get('companyApps/app_valid').inspection_status, 'verified');

    // Prove that X-Firebase-Auth header received the exact Firebase Bearer token and Authorization received IAM OIDC token
    assert.equal(lastReceivedHeaders['x-firebase-auth'], 'Bearer real-admin-firebase-token');
    assert.equal(lastReceivedHeaders['authorization'], 'Bearer mock-iam-oidc-token-123');

    // 9B. Non-admin caller -> REJECTED before service invocation with permission-denied
    await assert.rejects(
      () =>
        invokeCloudRunInspectorService({
          inspectorUrl: inspectorServerUrl,
          appId: 'app_valid',
          auth: {
            uid: 'user_regular',
            token: {admin: false, email: 'user@injaz.sa', email_verified: true},
          },
          firebaseAuthToken: 'user-firebase-token',
          getIdTokenFn: async () => 'mock-iam-oidc-token-123',
          firestoreDb: mockDb,
          allowLocalHttpForTest: true,
        }),
      err => err.code === 'permission-denied'
    );

    // 9C. Missing/Invalid Firebase token -> REJECTED by inspector server (401 unauthenticated)
    await assert.rejects(
      () =>
        invokeCloudRunInspectorService({
          inspectorUrl: inspectorServerUrl,
          appId: 'app_valid',
          auth: {
            uid: 'admin_conn',
            token: {admin: true, email: 'admin@injaz.sa', email_verified: true},
          },
          firebaseAuthToken: 'invalid-token-456',
          getIdTokenFn: async () => 'mock-iam-oidc-token-123',
          firestoreDb: mockDb,
          allowLocalHttpForTest: true,
        }),
      err => err.code === 'unauthenticated'
    );

    // 9D. IAM OIDC token acquisition failure -> REJECTED with "فشل الحصول على رمز IAM لمصادقة خدمة Cloud Run"
    await assert.rejects(
      () =>
        invokeCloudRunInspectorService({
          inspectorUrl: inspectorServerUrl,
          appId: 'app_valid',
          auth: {
            uid: 'admin_conn',
            token: {admin: true, email: 'admin@injaz.sa', email_verified: true},
          },
          firebaseAuthToken: 'real-admin-firebase-token',
          getIdTokenFn: async () => '', // Returns empty IAM token
          firestoreDb: mockDb,
          allowLocalHttpForTest: true,
        }),
      err => err.code === 'unauthenticated' && /فشل الحصول على رمز IAM/.test(err.message)
    );

    // 9E. Redirect attempt -> Blocked with failed-precondition
    const redirectServer = http.createServer((req, res) => {
      res.writeHead(302, {Location: 'http://malicious.example.com/steal-tokens'});
      res.end();
    });
    await new Promise(resolve => redirectServer.listen(0, '127.0.0.1', resolve));
    const redirectPort = redirectServer.address().port;

    await assert.rejects(
      () =>
        invokeCloudRunInspectorService({
          inspectorUrl: `http://127.0.0.1:${redirectPort}`,
          appId: 'app_valid',
          auth: {
            uid: 'admin_conn',
            token: {admin: true, email: 'admin@injaz.sa', email_verified: true},
          },
          firebaseAuthToken: 'real-admin-firebase-token',
          getIdTokenFn: async () => 'mock-iam-oidc-token-123',
          firestoreDb: mockDb,
          allowLocalHttpForTest: true,
        }),
      err => err.code === 'failed-precondition' && /Redirects Blocked/.test(err.message)
    );
    redirectServer.close();

    // 9F. Tampered APK (modified after signing without re-signing) -> REJECTED by inspector server
    if (HAS_JAVA) {
      await assert.rejects(
        () =>
          invokeCloudRunInspectorService({
            inspectorUrl: inspectorServerUrl,
            appId: 'app_tampered',
            auth: {
              uid: 'admin_conn',
              token: {admin: true, email: 'admin@injaz.sa', email_verified: true},
            },
            firebaseAuthToken: 'real-admin-firebase-token',
            getIdTokenFn: async () => 'mock-iam-oidc-token-123',
            firestoreDb: mockDb,
            allowLocalHttpForTest: true,
          }),
        err => err.code === 'invalid-argument' || err.code === 'failed-precondition'
      );
      assert.equal(docs.get('companyApps/app_tampered').inspection_status, 'failed');
    }

    // 9G. Service timeout / network crash -> fails closed, sets inspection_status: 'failed', throws error
    const hangingServer = http.createServer((req, res) => {
      // Intentionally do not respond
    });
    await new Promise(resolve => hangingServer.listen(0, '127.0.0.1', resolve));
    const hangingPort = hangingServer.address().port;

    await assert.rejects(
      () =>
        invokeCloudRunInspectorService({
          inspectorUrl: `http://127.0.0.1:${hangingPort}`,
          appId: 'app_valid',
          auth: {
            uid: 'admin_conn',
            token: {admin: true, email: 'admin@injaz.sa', email_verified: true},
          },
          firebaseAuthToken: 'real-admin-firebase-token',
          getIdTokenFn: async () => 'mock-iam-oidc-token-123',
          firestoreDb: mockDb,
          timeoutMs: 150,
          allowLocalHttpForTest: true,
        }),
      err => Boolean(err && (err.code === 'deadline-exceeded' || err.message?.includes('انتهت مهلة')))
    );
    if (typeof hangingServer.closeAllConnections === 'function') {
      hangingServer.closeAllConnections();
    }
    hangingServer.close();
    assert.equal(docs.get('companyApps/app_valid').inspection_status, 'failed');
  } finally {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close();
  }
});

test('10. validateInspectorServiceUrl validates URLs, rejects user credentials, enforces HTTPS protocol, and allows local HTTP in test mode', () => {
  // Valid HTTPS URL
  const validHttps = validateInspectorServiceUrl('https://apk-inspector-abc-uc.a.run.app');
  assert.equal(validHttps.hostname, 'apk-inspector-abc-uc.a.run.app');
  assert.equal(validHttps.protocol, 'https:');

  // URL with user credentials -> throws invalid-argument
  assert.throws(
    () => validateInspectorServiceUrl('https://user:password@apk-inspector.run.app'),
    err => err.code === 'invalid-argument' && /اعتمادات المستخدم/.test(err.message)
  );

  // Non-HTTP/HTTPS protocol -> throws invalid-argument
  assert.throws(
    () => validateInspectorServiceUrl('ftp://apk-inspector.run.app'),
    err => err.code === 'invalid-argument' && /بروتوكول غير مدعوم/.test(err.message)
  );

  // Empty URL -> throws failed-precondition
  assert.throws(
    () => validateInspectorServiceUrl(''),
    err => err.code === 'failed-precondition' && /غير معرف/.test(err.message)
  );

  // Local HTTP URL in test mode -> allowed
  const localHttp = validateInspectorServiceUrl('http://127.0.0.1:8080', true);
  assert.equal(localHttp.hostname, '127.0.0.1');

  // Remote HTTP URL -> throws invalid-argument
  assert.throws(
    () => validateInspectorServiceUrl('http://remote-server.com/inspect', false),
    err => err.code === 'invalid-argument' && /HTTPS/.test(err.message)
  );
});

test('11. Unified Firebase Admin initialization order applies explicit projectId & storageBucket, and fails closed in production Cloud Run mode when required env vars are missing', async () => {
  const {initFirebaseAdmin, resetAdminAppForTest} = require('../firebaseAdmin');

  // 11A. Production Cloud Run server mode with missing FIREBASE_PROJECT_ID -> throws explicit error
  assert.throws(
    () =>
      initFirebaseAdmin({
        projectId: '',
        storageBucket: 'my-bucket.appspot.com',
        isCloudRunServer: true,
        isTestMode: false,
      }),
    err => /FIREBASE_PROJECT_ID/.test(err.message)
  );

  // 11B. Production Cloud Run server mode with missing STORAGE_BUCKET -> throws explicit error
  assert.throws(
    () =>
      initFirebaseAdmin({
        projectId: 'my-prod-project',
        storageBucket: '',
        isCloudRunServer: true,
        isTestMode: false,
      }),
    err => /STORAGE_BUCKET/.test(err.message)
  );

  // 11C. Initialization applies explicit projectId and storageBucket after resetting test app
  await resetAdminAppForTest();
  const app = initFirebaseAdmin({
    projectId: 'injaz-prod-mdm',
    storageBucket: 'injaz-prod-mdm.appspot.com',
    isCloudRunServer: true,
    isTestMode: true,
  });

  assert.ok(app);
  assert.equal(app.options.projectId, 'injaz-prod-mdm');
  assert.equal(app.options.storageBucket, 'injaz-prod-mdm.appspot.com');

  // 11D. Re-initializing with conflicting projectId -> throws conflict error
  assert.throws(
    () =>
      initFirebaseAdmin({
        projectId: 'conflicting-project-id',
        storageBucket: 'injaz-prod-mdm.appspot.com',
        isCloudRunServer: false,
        isTestMode: true,
      }),
    err => /تعارض في إعدادات Firebase Admin/.test(err.message)
  );
});


