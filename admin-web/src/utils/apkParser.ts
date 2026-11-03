import JSZip from 'jszip';

export interface ParsedApkInfo {
  appName: string;
  packageName: string;
  versionCode: number;
  versionName: string;
  fileSizeBytes: number;
  sha256Apk: string; // raw lowercase 64-char hex without colons
  sha256Cert: string; // raw lowercase 64-char hex without colons
  signatureScheme: 'v1' | 'v2' | 'v3' | 'v2+v3';
  iconDataUrl: string | null;
  isLocalPreviewOnly: true;
  minSdkVersion?: number;
  targetSdkVersion?: number;
}

/**
 * Computes the SHA-256 hash of an ArrayBuffer and formats it as raw lowercase or uppercase hex.
 */
export async function computeSha256Hex(
  buffer: BufferSource,
  uppercase = false
): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return uppercase ? hex.toUpperCase() : hex.toLowerCase();
}

/**
 * Formats a raw hex string with colons (e.g. AA:BB:CC:...) strictly for UI presentation.
 */
export function formatFingerprintWithColons(hex: string): string {
  const clean = hex.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  const parts: string[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    parts.push(clean.substring(i, i + 2));
  }
  return parts.join(':');
}

/**
 * Normalizes any fingerprint string to clean raw lowercase 64-char hex.
 */
export function normalizeHexDigest(str: string): string {
  return str.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

/**
 * Parses an Android APK file for local browser preview.
 * Validates binary AndroidManifest.xml, extracts X.509 certificate from v2, v3, or v1,
 * and checks content digests against tampering.
 * NOTE: Browser parsing is a LOCAL PREVIEW ONLY; authoritative verification and
 * inspection_status='verified' must be set exclusively by the server.
 */
export async function parseApkFile(
  fileOrBuffer: File | Blob | ArrayBuffer
): Promise<ParsedApkInfo> {
  let arrayBuffer: ArrayBuffer;
  let fileSizeBytes: number;

  if (fileOrBuffer instanceof ArrayBuffer) {
    arrayBuffer = fileOrBuffer;
    fileSizeBytes = arrayBuffer.byteLength;
  } else {
    arrayBuffer = await fileOrBuffer.arrayBuffer();
    fileSizeBytes = fileOrBuffer.size;
  }

  if (fileSizeBytes < 100) {
    throw new Error('حجم ملف APK غير صالح أو تالف (أصغر من 100 بايت)');
  }

  // 1. Whole-file SHA-256 digest
  const sha256Apk = await computeSha256Hex(arrayBuffer, false);

  // 2. Unzip APK archive
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(arrayBuffer);
  } catch (err) {
    throw new Error('فشل فتح ملف APK كأرشيف ZIP صالح: ' + (err instanceof Error ? err.message : String(err)));
  }

  // 3. Extract and parse binary AndroidManifest.xml
  const manifestFile = zip.file('AndroidManifest.xml');
  if (!manifestFile) {
    throw new Error('الملف المرفوع لا يحتوي على ملف AndroidManifest.xml صالح');
  }
  const manifestBuffer = await manifestFile.async('arraybuffer');
  const manifestInfo = parseBinaryAndroidManifest(manifestBuffer);

  // 4. Extract APK Signature, X.509 Certificate (v2, v3, or v1), and verify content digests
  const sigInfo = await extractApkSignatures(arrayBuffer, zip);

  // 5. Extract Launcher Icon if present
  let iconDataUrl: string | null = null;
  const iconFiles = Object.keys(zip.files).filter(
    (name) =>
      name.startsWith('res/') &&
      (name.includes('ic_launcher') || name.includes('app_icon') || name.includes('icon')) &&
      name.endsWith('.png')
  );

  if (iconFiles.length > 0) {
    const preferred =
      iconFiles.find((f) => f.includes('xxxhdpi') || f.includes('xxhdpi')) || iconFiles[0];
    const iconFile = zip.file(preferred);
    if (iconFile) {
      try {
        const iconBase64 = await iconFile.async('base64');
        iconDataUrl = `data:image/png;base64,${iconBase64}`;
      } catch {
        // Non-fatal if icon cannot be read
      }
    }
  }

  return {
    appName: manifestInfo.appName || deriveAppNameFromPackage(manifestInfo.packageName),
    packageName: manifestInfo.packageName,
    versionCode: manifestInfo.versionCode,
    versionName: manifestInfo.versionName,
    fileSizeBytes,
    sha256Apk,
    sha256Cert: sigInfo.sha256Cert,
    signatureScheme: sigInfo.scheme,
    iconDataUrl,
    isLocalPreviewOnly: true,
  };
}

/**
 * Parses binary Android XML (AXML) to extract exact package name, versionCode, versionName, and label.
 * Throws explicit error if required attributes are missing.
 */
export function parseBinaryAndroidManifest(buffer: ArrayBuffer): {
  packageName: string;
  versionCode: number;
  versionName: string;
  appName?: string;
} {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8) {
    throw new Error('ملف AndroidManifest.xml فارغ أو تالف');
  }

  const magic = view.getUint32(0, true);
  if (magic !== 0x00080003) {
    throw new Error('ملف AndroidManifest.xml ليس بصيغة AXML ثنائية صالحة');
  }

  let offset = 8;
  let stringPool: string[] = [];
  let foundManifest = false;
  let packageName = '';
  let versionCode = 0;
  let versionName = '';
  let appName = '';

  while (offset < buffer.byteLength) {
    if (offset + 8 > buffer.byteLength) break;
    const chunkType = view.getUint32(offset, true);
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkSize <= 0 || offset + chunkSize > buffer.byteLength) {
      break;
    }

    // StringPool chunk
    if (chunkType === 0x001c0001) {
      stringPool = parseStringPool(buffer, offset);
    }

    // Start Element tag chunk
    if (chunkType === 0x00100102) {
      const nameIdx = view.getInt32(offset + 20, true);
      const attrSize = view.getUint16(offset + 26, true);
      const attrCount = view.getUint16(offset + 28, true);

      const elemName = nameIdx >= 0 && nameIdx < stringPool.length ? stringPool[nameIdx] : '';

      if (elemName === 'manifest') {
        foundManifest = true;
        for (let i = 0; i < attrCount; i++) {
          const aOffset = offset + 36 + i * attrSize;
          if (aOffset + 20 > buffer.byteLength) break;

          const attrNameIdx = view.getInt32(aOffset + 4, true);
          const rawValIdx = view.getInt32(aOffset + 8, true);
          const type = view.getUint8(aOffset + 15);
          const data = view.getInt32(aOffset + 16, true);

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
          if (aOffset + 20 > buffer.byteLength) break;
          const attrNameIdx = view.getInt32(aOffset + 4, true);
          const rawValIdx = view.getInt32(aOffset + 8, true);
          const type = view.getUint8(aOffset + 15);
          const data = view.getInt32(aOffset + 16, true);
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

  // Strict Validation: No Heuristic Fallbacks
  if (!foundManifest || !packageName) {
    throw new Error('فشل فحص الحزمة: لم يتم العثور على اسم الحزمة (packageName) في AndroidManifest.xml');
  }
  if (!packageName.includes('.') || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
    throw new Error(`اسم الحزمة المستخرج غير صالح برمجياً: (${packageName})`);
  }
  if (versionCode <= 0) {
    throw new Error('فشل فحص الحزمة: رقم الإصدار (versionCode) مفقود أو غير صالح في AndroidManifest.xml');
  }
  if (!versionName) {
    throw new Error('فشل فحص الحزمة: اسم الإصدار (versionName) مفقود في AndroidManifest.xml');
  }

  return {
    packageName,
    versionCode,
    versionName,
    appName: appName || undefined,
  };
}

function parseStringPool(buffer: ArrayBuffer, offset: number): string[] {
  const view = new DataView(buffer, offset);
  const stringCount = view.getUint32(8, true);
  const flags = view.getUint32(16, true);
  const stringsStart = view.getUint32(20, true);
  const isUtf8 = (flags & (1 << 8)) !== 0;

  const offsets: number[] = [];
  for (let i = 0; i < stringCount; i++) {
    offsets.push(view.getUint32(28 + i * 4, true));
  }

  const strings: string[] = [];
  const baseOffset = offset + stringsStart;
  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < stringCount; i++) {
    const strOffset = baseOffset + offsets[i];
    if (strOffset >= buffer.byteLength) {
      strings.push('');
      continue;
    }

    if (isUtf8) {
      let pos = strOffset;
      if ((bytes[pos] & 0x80) !== 0) pos += 2;
      else pos += 1;
      let byteLen = bytes[pos];
      if ((byteLen & 0x80) !== 0) {
        byteLen = ((byteLen & 0x7f) << 8) | bytes[pos + 1];
        pos += 2;
      } else {
        pos += 1;
      }
      try {
        const strBytes = bytes.slice(pos, pos + byteLen);
        strings.push(new TextDecoder('utf-8').decode(strBytes));
      } catch {
        strings.push('');
      }
    } else {
      const len = bytes[strOffset] | (bytes[strOffset + 1] << 8);
      const start = strOffset + 2;
      try {
        const u16 = new Uint16Array(buffer, start, len);
        strings.push(String.fromCharCode(...u16));
      } catch {
        strings.push('');
      }
    }
  }

  return strings;
}

/**
 * Computes the official Android APK Signature Scheme v2/v3 chunked Merkle tree SHA-256 digest
 * over the 3 APK sections.
 */
export async function computeApkSigBlockV2MerkleSha256(
  bytes: Uint8Array,
  sigBlockStart: number,
  centralDirOffset: number,
  eocdOffset: number
): Promise<Uint8Array> {
  const CHUNK_SIZE = 1024 * 1024;
  const eocdCopy = new Uint8Array(bytes.slice(eocdOffset));
  const eocdView = new DataView(eocdCopy.buffer, eocdCopy.byteOffset, eocdCopy.byteLength);
  eocdView.setUint32(16, sigBlockStart, true);

  const sections = [
    bytes.slice(0, sigBlockStart),
    bytes.slice(centralDirOffset, eocdOffset),
    eocdCopy,
  ];

  const chunkDigests: Uint8Array[] = [];
  for (const section of sections) {
    let offset = 0;
    while (offset < section.length) {
      const chunkLen = Math.min(CHUNK_SIZE, section.length - offset);
      const chunk = section.slice(offset, offset + chunkLen);
      const buf = new Uint8Array(5 + chunkLen);
      buf[0] = 0xa5;
      new DataView(buf.buffer).setUint32(1, chunkLen, true);
      buf.set(chunk, 5);

      const d = await crypto.subtle.digest('SHA-256', buf);
      chunkDigests.push(new Uint8Array(d));
      offset += chunkLen;
    }
  }

  const topBuf = new Uint8Array(5 + chunkDigests.length * 32);
  topBuf[0] = 0x5a;
  new DataView(topBuf.buffer).setUint32(1, chunkDigests.length, true);
  chunkDigests.forEach((d, idx) => {
    topBuf.set(d, 5 + idx * 32);
  });

  const finalDigest = await crypto.subtle.digest('SHA-256', topBuf);
  return new Uint8Array(finalDigest);
}

/**
 * Extracts the signing certificate and scheme (v2, v3, or v1) from the APK binary,
 * and verifies content digests against tampering when present.
 */
async function extractApkSignatures(
  buffer: ArrayBuffer,
  zip: JSZip
): Promise<{ sha256Cert: string; scheme: 'v1' | 'v2' | 'v3' | 'v2+v3' }> {
  const bytes = new Uint8Array(buffer);
  const totalLen = bytes.length;

  let eocdOffset = -1;
  const maxSearch = Math.min(totalLen, 65535 + 22);
  for (let i = totalLen - 22; i >= totalLen - maxSearch; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset !== -1) {
    const eocdView = new DataView(buffer, eocdOffset);
    const centralDirOffset = eocdView.getUint32(16, true);

    if (centralDirOffset >= 24) {
      const magicOffset = centralDirOffset - 16;
      const magic = String.fromCharCode(...bytes.slice(magicOffset, centralDirOffset));

      if (magic === 'APK Sig Block 42') {
        const blockSizeOffset = centralDirOffset - 24;
        const blockView = new DataView(buffer, blockSizeOffset);
        const blockSize = blockView.getUint32(0, true);
        const blockStart = centralDirOffset - blockSize - 8;

        if (blockStart >= 0) {
          let pos = blockStart + 8;
          let foundV2Cert: Uint8Array | null = null;
          let foundV3Cert: Uint8Array | null = null;

          while (pos < centralDirOffset - 24) {
            const pairView = new DataView(buffer, pos);
            const pairLen = pairView.getUint32(0, true);
            const pairId = pairView.getUint32(8, true);

            if (pairLen <= 0 || pos + 8 + pairLen > centralDirOffset - 24) break;

            if (pairId === 0x7109871a) {
              foundV2Cert = await verifyAndExtractCertFromSignerBlock(
                bytes,
                pos + 12,
                pairLen - 4,
                blockStart,
                centralDirOffset,
                eocdOffset,
                'v2'
              );
            } else if (pairId === 0xf05368c0) {
              foundV3Cert = await verifyAndExtractCertFromSignerBlock(
                bytes,
                pos + 12,
                pairLen - 4,
                blockStart,
                centralDirOffset,
                eocdOffset,
                'v3'
              );
            }

            pos += 8 + pairLen;
          }

          if (foundV3Cert) {
            const sha256 = await computeSha256Hex(new Uint8Array(foundV3Cert), false);
            return { sha256Cert: sha256, scheme: foundV2Cert ? 'v2+v3' : 'v3' };
          }
          if (foundV2Cert) {
            const sha256 = await computeSha256Hex(new Uint8Array(foundV2Cert), false);
            return { sha256Cert: sha256, scheme: 'v2' };
          }
        }
      }
    }
  }

  // 2. Check Scheme v1 (JAR signing in META-INF) for local preview
  const metaInfFiles = Object.keys(zip.files).filter(
    (name) =>
      name.startsWith('META-INF/') &&
      (name.endsWith('.RSA') || name.endsWith('.DSA') || name.endsWith('.EC'))
  );
  const sfFiles = Object.keys(zip.files).filter(
    (name) => name.startsWith('META-INF/') && name.endsWith('.SF')
  );

  if (metaInfFiles.length > 0) {
    const manifestMfFile = zip.file('META-INF/MANIFEST.MF');
    if (!manifestMfFile || sfFiles.length === 0) {
      throw new Error(
        'فشل التحقق الجنائي (v1): الأرشيف يفتقر إلى ملف التوقيع META-INF/*.SF أو MANIFEST.MF؛ لا يُقبل ملف شهادة دون توقيع .SF صالح.'
      );
    }

    const manifestMfRaw = await manifestMfFile.async('arraybuffer');
    const manifestMfText = new TextDecoder('utf-8').decode(manifestMfRaw);
    const sfFile = zip.file(sfFiles[0]);
    const sfText = sfFile ? await sfFile.async('string') : '';
    const sfDigestMatch = sfText.match(/SHA-256-Digest-Manifest:\s*([A-Za-z0-9+/=]+)/);
    if (!sfDigestMatch) {
      throw new Error('فشل التحقق الجنائي (v1): ملف .SF لا يحتوي على بصمة SHA-256-Digest-Manifest صالحة.');
    }
    const actualManifestDigestBuf = await crypto.subtle.digest('SHA-256', manifestMfRaw);
    const actualManifestB64 = btoa(String.fromCharCode(...new Uint8Array(actualManifestDigestBuf)));
    if (actualManifestB64 !== sfDigestMatch[1].trim()) {
      throw new Error(
        'فشل التحقق الجنائي (v1): بصمة MANIFEST.MF لا تطابق SHA-256-Digest-Manifest في ملف .SF (تم تعديل MANIFEST.MF بعد التوقيع)!'
      );
    }

    const sectionMap = new Map<string, string>();
    const blocks = manifestMfText.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const unfolded = block.replace(/\r?\n /g, '');
      const lines = unfolded.split(/\r?\n/);
      let name: string | null = null;
      let sha256B64: string | null = null;
      for (const line of lines) {
        if (line.startsWith('Name:')) name = line.slice(5).trim();
        else if (line.startsWith('SHA-256-Digest:')) sha256B64 = line.slice(15).trim();
      }
      if (name && sha256B64) sectionMap.set(name, sha256B64);
    }

    for (const [entryName, zipObj] of Object.entries(zip.files)) {
      if (zipObj.dir || entryName.startsWith('META-INF/')) continue;
      const expectedB64 = sectionMap.get(entryName);
      if (!expectedB64) {
        throw new Error(`فشل التحقق الجنائي (v1): الملف الداخلي (${entryName}) غير موقع في MANIFEST.MF`);
      }
      const entryBuf = await zipObj.async('arraybuffer');
      const digestBuf = await crypto.subtle.digest('SHA-256', entryBuf);
      const actualB64 = btoa(String.fromCharCode(...new Uint8Array(digestBuf)));
      if (actualB64 !== expectedB64) {
        throw new Error(
          `فشل التحقق الجنائي من سلامة محتوى APK (v1): تم العبث بمحتوى الملف (${entryName}) بعد توقيعه!`
        );
      }
    }

    for (const sigName of metaInfFiles) {
      const sigFile = zip.file(sigName);
      if (!sigFile) continue;
      const sigBuf = await sigFile.async('arraybuffer');
      const sigBytes = new Uint8Array(sigBuf);
      // Require genuine ASN.1 DER PKCS#7 ContentInfo (0x30) with SignedData OID (1.2.840.113549.1.7.2)
      const signedDataOid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
      const hasPkcs7SignedDataOid = sigBytes[0] === 0x30 && signedDataOid.every((_, i) =>
        sigBytes.some((__, idx) =>
          idx + signedDataOid.length <= sigBytes.length &&
          signedDataOid.every((b, k) => sigBytes[idx + k] === b)
        )
      );
      if (!hasPkcs7SignedDataOid) {
        throw new Error(
          'فشل التحقق الجنائي (v1): ملف التوقيع في META-INF لا يحتوي على هيكل PKCS#7 SignedData صالح.'
        );
      }
      const certBytes = extractX509FromPkcs7(sigBytes);
      if (certBytes) {
        const sha256 = await computeSha256Hex(new Uint8Array(certBytes), false);
        return { sha256Cert: sha256, scheme: 'v1' };
      }
    }
  }

  throw new Error('فشل التحقق الأمني: حزمة APK غير موقعة، أو لا تحتوي على توقيع صالح وفق معايير Android (v1/v2/v3).');
}

/**
 * Extracts the first DER X.509 certificate from an APK v2/v3 signer sequence,
 * and verifies content digests if present in signedData.digests.
 */
async function verifyAndExtractCertFromSignerBlock(
  bytes: Uint8Array,
  start: number,
  length: number,
  sigBlockStart: number,
  centralDirOffset: number,
  eocdOffset: number,
  schemeLabel: string
): Promise<Uint8Array | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, length);
  const signersLen = view.getUint32(0, true);
  if (signersLen <= 4) return null;

  let pos = 12;
  const digestsLen = view.getUint32(pos, true);
  const digestsStart = start + pos + 4;

  if (digestsLen >= 12) {
    let dPos = 0;
    while (dPos + 8 <= digestsLen) {
      const dView = new DataView(bytes.buffer, bytes.byteOffset + digestsStart + dPos, digestsLen - dPos);
      const recLen = dView.getUint32(0, true);
      if (recLen < 8 || dPos + 4 + recLen > digestsLen) break;
      const algoId = dView.getUint32(4, true);
      const valLen = dView.getUint32(8, true);
      const digestVal = bytes.slice(digestsStart + dPos + 12, digestsStart + dPos + 12 + valLen);

      if (algoId === 0x0101 || algoId === 0x0103 || algoId === 0x0201) {
        const expectedMerkle = await computeApkSigBlockV2MerkleSha256(
          bytes,
          sigBlockStart,
          centralDirOffset,
          eocdOffset
        );
        if (
          expectedMerkle.length !== digestVal.length ||
          !expectedMerkle.every((b, idx) => b === digestVal[idx])
        ) {
          throw new Error(
            `فشل التحقق الجنائي من سلامة محتوى APK (${schemeLabel}): تم تعديل محتويات الأرشيف أو العبث بها بعد التوقيع!`
          );
        }
      }
      dPos += 4 + recLen;
    }
  }

  pos += 4 + digestsLen;
  pos += 4; // certs sequence length
  const firstCertLen = view.getUint32(pos, true);
  pos += 4;

  if (firstCertLen > 0 && pos + firstCertLen <= length) {
    return bytes.slice(start + pos, start + pos + firstCertLen);
  }
  return null;
}

function extractX509FromPkcs7(bytes: Uint8Array): Uint8Array | null {
  for (let i = 0; i < bytes.length - 20; i++) {
    if (bytes[i] === 0x30 && bytes[i + 1] === 0x82) {
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      const certEnd = i + 4 + len;
      if (certEnd <= bytes.length && len > 100) {
        if (bytes[i + 4] === 0x30 && bytes[i + 5] === 0x82) {
          let inner = i + 8;
          while (inner < certEnd - 5) {
            if (bytes[inner] === 0xa0 && bytes[inner + 1] === 0x03 && bytes[inner + 2] === 0x02) {
              return bytes.slice(i, certEnd);
            }
            inner++;
          }
        }
      }
    }
  }
  return null;
}

function deriveAppNameFromPackage(pkg: string): string {
  if (!pkg) return 'تطبيق شركة معتمد';
  const parts = pkg.split('.');
  const last = parts[parts.length - 1] || 'app';
  return last.charAt(0).toUpperCase() + last.slice(1);
}

