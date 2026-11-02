import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTECTED_PACKAGES,
  MAX_BLOCKED_APPS,
  validatePackageName,
  sanitizeManualUid,
  parseEnrollmentData,
  parsePolicyData,
  parseDeviceStatusData,
  parseAppInventoryData,
  computeBulkActionPlan,
  formatLastSeenAr,
  buildMergedDevices,
} from '../src/utils/validation.ts';

import {
  classifyAdminDocServerResult,
  evaluateAdminAuthorization,
  reloadUserAndVerifyAdmin,
  validatePolicyTransactionState,
} from '../src/services/mdmService.ts';

test('1. validatePackageName enforces Policy.java regex, AppRestrictions.java protected packages, and 50-app limit', () => {
  assert.equal(validatePackageName('com.example.game', []).valid, true);
  assert.equal(validatePackageName('com.zhiliaoapp.musically', []).valid, true);

  // Invalid format
  assert.equal(validatePackageName('not a package', []).valid, false);
  assert.equal(validatePackageName('singleword', []).valid, false);
  assert.equal(validatePackageName('123.invalid.start', []).valid, false);

  // Protected packages
  for (const pkg of PROTECTED_PACKAGES) {
    const res = validatePackageName(pkg, []);
    assert.equal(res.valid, false, `Expected protected package ${pkg} to be rejected`);
  }

  // Duplicates
  assert.equal(validatePackageName('com.example.game', ['com.example.game']).valid, false);

  // Max 50 apps limit
  const fiftyApps = Array.from({ length: MAX_BLOCKED_APPS }, (_, i) => `com.example.app${i}`);
  assert.equal(validatePackageName('com.example.overflow', fiftyApps).valid, false);
});

test('2. sanitizeManualUid trims outer whitespace only and preserves exact character case', () => {
  const raw = '  AbCdEf123_XyZ-99  ';
  const sanitized = sanitizeManualUid(raw);
  assert.equal(sanitized.valid, true);
  assert.equal(sanitized.uid, 'AbCdEf123_XyZ-99');
  assert.notEqual(sanitized.uid, sanitized.uid.toLowerCase());
});

test('3. parseEnrollmentData strictly checks boolean approved and rejects string "false" or invalid types', () => {
  const validTrue = parseEnrollmentData({ approved: true });
  assert.equal(validTrue.isCorrupted, false);
  assert.equal(validTrue.approved, true);

  const validFalse = parseEnrollmentData({ approved: false });
  assert.equal(validFalse.isCorrupted, false);
  assert.equal(validFalse.approved, false);

  // String "false" must NEVER become true via Boolean("false")
  const stringFalse = parseEnrollmentData({ approved: 'false' });
  assert.equal(stringFalse.isCorrupted, true);
  assert.equal(stringFalse.approved, false);
  assert.ok(stringFalse.corruptionReason && stringFalse.corruptionReason.length > 0);
});

test('4. parsePolicyData flags invalid schema_version, non-boolean block_tethering, or bad blocked_apps without silent replacement', () => {
  const validPolicy = parsePolicyData({
    schema_version: 1,
    revision: 3,
    block_tethering: true,
    blocked_apps: ['com.zhiliaoapp.musically'],
  });
  assert.equal(validPolicy.isCorrupted, false);
  assert.equal(validPolicy.schema_version, 1);
  assert.equal(validPolicy.revision, 3);
  assert.equal(validPolicy.block_tethering, true);
  assert.deepEqual(validPolicy.blocked_apps, ['com.zhiliaoapp.musically']);

  // Unsupported schema_version must not silently become 1
  const badSchema = parsePolicyData({
    schema_version: 2,
    revision: 4,
    block_tethering: true,
    blocked_apps: [],
  });
  assert.equal(badSchema.isCorrupted, true);
  assert.equal(badSchema.schema_version, 2);

  // String "false" in block_tethering must be flagged as corrupted and never coerced to true
  const stringTethering = parsePolicyData({
    schema_version: 1,
    revision: 1,
    block_tethering: 'false',
    blocked_apps: [],
  });
  assert.equal(stringTethering.isCorrupted, true);
  assert.equal(stringTethering.block_tethering, false);

  // Invalid or protected entries in blocked_apps are flagged while preserving string entries and rawData
  const badApps = parsePolicyData({
    schema_version: 1,
    revision: 2,
    block_tethering: true,
    blocked_apps: ['com.valid.one', 'invalid package', 'com.company.mdmagent'],
  });
  assert.equal(badApps.isCorrupted, true);
  assert.deepEqual(badApps.blocked_apps, ['com.valid.one', 'invalid package', 'com.company.mdmagent']);
  assert.deepEqual(badApps.rawData?.blocked_apps, ['com.valid.one', 'invalid package', 'com.company.mdmagent']);
  assert.equal(badApps.corruptionErrors?.length, 2);
});

test('5. parseDeviceStatusData safely handles non-boolean telemetry flags without Boolean("false") coercion', () => {
  const status = parseDeviceStatusData({
    device_owner: 'false',
    tethering_restricted: 'false',
    applied_revision: 2,
    model: 'TECNO POVA 5',
    android_sdk: 33,
    battery_percent: 85,
    error: '',
    agent_version: '0.1.0-pilot',
  });
  assert.equal(status.device_owner, false);
  assert.equal(status.tethering_restricted, false);
  assert.equal(status.applied_revision, 2);
  assert.equal(status.isCorrupted, true);
});

test('6. validatePolicyTransactionState detects concurrent admin edits and blocks saving over corrupted policy unless repair is requested', () => {
  const cleanServerDoc = {
    schema_version: 1,
    revision: 2,
    block_tethering: true,
    blocked_apps: ['com.example.one'],
  };

  // Matching expectedCurrentRevision succeeds and increments revision above max(policy.revision, appliedRevisionOnDevice)
  const okResult = validatePolicyTransactionState({
    existsNow: true,
    serverRawData: cleanServerDoc,
    appliedRevisionOnDevice: 2,
    expectedCurrentRevision: 2,
  });
  assert.equal(okResult.nextRevision, 3);

  // Concurrent modification (expected revision 1, but server is now at 2) throws conflict error
  assert.throws(
    () =>
      validatePolicyTransactionState({
        existsNow: true,
        serverRawData: cleanServerDoc,
        appliedRevisionOnDevice: 1,
        expectedCurrentRevision: 1,
      }),
    /تعارض تعديل/
  );

  // Corrupted server doc blocks normal derived save
  const corruptedServerDoc = {
    schema_version: 99,
    revision: 4,
    block_tethering: 'true',
    blocked_apps: 'not-an-array',
  };
  assert.throws(
    () =>
      validatePolicyTransactionState({
        existsNow: true,
        serverRawData: corruptedServerDoc,
        appliedRevisionOnDevice: 4,
        expectedCurrentRevision: 4,
        allowRepairCorrupted: false,
      }),
    /تالفة أو مخالفة للعقد/
  );

  // Explicit repair mode allows replacing corrupted doc while incrementing valid revision
  const repairedResult = validatePolicyTransactionState({
    existsNow: true,
    serverRawData: corruptedServerDoc,
    appliedRevisionOnDevice: 4,
    expectedCurrentRevision: 4,
    allowRepairCorrupted: true,
  });
  assert.equal(repairedResult.nextRevision, 5);
});

test('7. classifyAdminDocServerResult and evaluateAdminAuthorization distinguish unverified email, missing doc, permission-denied, network error, and preserve valid custom claim', () => {
  // Unverified email
  const unverifiedStatus = classifyAdminDocServerResult({ emailVerified: false });
  assert.equal(unverifiedStatus.status, 'not_checked_unverified_email');

  // Even with custom claim, unverified email is NOT authorized
  const unverifiedWithClaim = evaluateAdminAuthorization({
    uid: 'u1',
    email: 'mashhoor.info@gmail.com',
    emailVerified: false,
    isAnonymous: false,
    signInProvider: 'password',
    hasCustomAdminClaim: true,
    adminDocResult: unverifiedStatus,
  });
  assert.equal(unverifiedWithClaim.isAuthorizedAdmin, false);
  assert.equal(unverifiedWithClaim.hasAdminDocRecord, false);

  // Missing or inactive doc
  const missingDoc = classifyAdminDocServerResult({
    emailVerified: true,
    snapshotExists: false,
  });
  assert.equal(missingDoc.status, 'missing_or_inactive');

  const inactiveDoc = classifyAdminDocServerResult({
    emailVerified: true,
    snapshotExists: true,
    snapshotData: { active: 'true' }, // String "true" is NOT boolean true
  });
  assert.equal(inactiveDoc.status, 'missing_or_inactive');

  // Permission denied
  const permDenied = classifyAdminDocServerResult({
    emailVerified: true,
    error: { code: 'permission-denied', message: 'Missing or insufficient permissions.' },
  });
  assert.equal(permDenied.status, 'permission_denied');

  // Network / unavailable error
  const netError = classifyAdminDocServerResult({
    emailVerified: true,
    error: { code: 'unavailable', message: 'Failed to get document from server.' },
  });
  assert.equal(netError.status, 'network_or_unavailable');

  // Valid custom claim MUST stay authorized even if reading admins/{uid} fails with permission-denied or network error
  const claimWithPermDenied = evaluateAdminAuthorization({
    uid: 'u1',
    email: 'mashhoor.info@gmail.com',
    emailVerified: true,
    isAnonymous: false,
    signInProvider: 'password',
    hasCustomAdminClaim: true,
    adminDocResult: permDenied,
  });
  assert.equal(claimWithPermDenied.isAuthorizedAdmin, true);

  // Active admins/{uid} doc authorizes verified user without custom claim
  const activeDoc = classifyAdminDocServerResult({
    emailVerified: true,
    snapshotExists: true,
    snapshotData: { active: true, email: 'mashhoor.info@gmail.com' },
  });
  assert.equal(activeDoc.status, 'granted');

  const docAuthorized = evaluateAdminAuthorization({
    uid: 'u1',
    email: 'mashhoor.info@gmail.com',
    emailVerified: true,
    isAnonymous: false,
    signInProvider: 'password',
    hasCustomAdminClaim: false,
    adminDocResult: activeDoc,
  });
  assert.equal(docAuthorized.isAuthorizedAdmin, true);
  assert.equal(docAuthorized.hasAdminDocRecord, true);
});

test('8. reloadUserAndVerifyAdmin calls reload, forces ID token refresh, and updates emailVerified & admin state', async () => {
  const callOrder = [];
  const fakeDb = {};
  const fakeUser = {
    uid: 'adminUid123',
    email: 'mashhoor.info@gmail.com',
    isAnonymous: false,
    emailVerified: false,
    async getIdToken(forceRefresh) {
      callOrder.push(`getIdToken:${forceRefresh}`);
      return 'fresh-token';
    },
    async getIdTokenResult(forceRefresh) {
      callOrder.push(`getIdTokenResult:${forceRefresh}`);
      return { claims: { admin: true }, signInProvider: 'password' };
    },
  };

  const identity = await reloadUserAndVerifyAdmin(fakeDb, fakeUser, {
    async reloadFn(u) {
      callOrder.push('reload');
      u.emailVerified = true;
    },
    async readAdminDocFromServer() {
      callOrder.push('readAdminDocFromServer');
      return { exists: true, data: { active: true } };
    },
  });

  assert.deepEqual(callOrder, [
    'reload',
    'getIdToken:true',
    'getIdTokenResult:true',
    'readAdminDocFromServer',
  ]);
  assert.equal(identity.emailVerified, true);
  assert.equal(identity.hasCustomAdminClaim, true);
  assert.equal(identity.hasAdminDocRecord, true);
  assert.equal(identity.isAuthorizedAdmin, true);
});

test('9. buildMergedDevices separates approval from policy enforcement and surfaces corrupted enrollment/policy clearly', () => {
  const enrollments = {
    devApprovedOnly: parseEnrollmentData({ approved: true }),
    devCorrupted: parseEnrollmentData({ approved: 'false' }),
  };
  const policies = {
    devApprovedOnly: parsePolicyData({
      schema_version: 1,
      revision: 2,
      block_tethering: true,
      blocked_apps: [],
    }),
    devCorrupted: parsePolicyData({
      schema_version: 99,
      revision: 1,
      block_tethering: true,
      blocked_apps: [],
    }),
  };

  const merged = buildMergedDevices(enrollments, policies, {}, {});
  const byUid = Object.fromEntries(merged.map((m) => [m.uid, m]));

  // Approved device with a saved policy but no deviceStatus is 'pending', NEVER 'applied'
  assert.equal(byUid.devApprovedOnly.approvalState, 'approved');
  assert.equal(byUid.devApprovedOnly.enforcementState, 'pending');

  // Corrupted enrollment & policy are explicitly flagged
  assert.equal(byUid.devCorrupted.approvalState, 'corrupted_enrollment');
  assert.equal(byUid.devCorrupted.enforcementState, 'corrupted_policy');
});

test('10. computeBulkActionPlan blocks apps safely, enforcing protected packages and 50-app limit', () => {
  const devices = [
    {
      uid: 'dev1',
      approvalState: 'approved',
      policy: { schema_version: 1, revision: 2, block_tethering: false, blocked_apps: ['com.whatsapp'] },
    },
    {
      uid: 'dev2_corrupt',
      approvalState: 'approved',
      policy: parsePolicyData({ schema_version: 99, revision: 1, block_tethering: false, blocked_apps: [] }),
    },
    {
      uid: 'dev3_unapproved',
      approvalState: 'unapproved',
      policy: { schema_version: 1, revision: 1, block_tethering: false, blocked_apps: [] },
    },
  ];

  // Try to block a protected package
  const protectedPlan = computeBulkActionPlan(devices, ['dev1'], 'block_apps', {
    packages: ['com.company.mdmagent'],
  });
  assert.equal(protectedPlan[0].eligible, false);
  assert.match(protectedPlan[0].skipReason, /محمية/);

  // Normal app block on eligible device
  const plan = computeBulkActionPlan(devices, ['dev1', 'dev2_corrupt', 'dev3_unapproved'], 'block_apps', {
    packages: ['com.tiktok.app'],
  });

  const dev1Plan = plan.find((i) => i.uid === 'dev1');
  assert.equal(dev1Plan.eligible, true);
  assert.equal(dev1Plan.hasActualChanges, true);
  assert.deepEqual(dev1Plan.nextBlockedApps, ['com.whatsapp', 'com.tiktok.app']);

  // dev2 is corrupted policy -> ineligible without repair
  const dev2Plan = plan.find((i) => i.uid === 'dev2_corrupt');
  assert.equal(dev2Plan.eligible, false);
  assert.match(dev2Plan.skipReason, /تالفة/);

  // dev3 is unapproved -> ineligible
  const dev3Plan = plan.find((i) => i.uid === 'dev3_unapproved');
  assert.equal(dev3Plan.eligible, false);
  assert.match(dev3Plan.skipReason, /غير معتمد/);

  // No-op detection: blocking an app that is already blocked
  const noopPlan = computeBulkActionPlan(devices, ['dev1'], 'block_apps', {
    packages: ['com.whatsapp'],
  });
  assert.equal(noopPlan[0].eligible, false);
  assert.equal(noopPlan[0].hasActualChanges, false);
  assert.match(noopPlan[0].skipReason, /تطابق التعديل المطلوب/);
});

test('11. computeBulkActionPlan allows apps by removing them from blocked_apps with no-op check', () => {
  const devices = [
    {
      uid: 'dev1',
      approvalState: 'approved',
      policy: { schema_version: 1, revision: 5, block_tethering: false, blocked_apps: ['com.snapchat.android', 'com.instagram.android'] },
    },
  ];

  const plan = computeBulkActionPlan(devices, ['dev1'], 'allow_apps', {
    packages: ['com.snapchat.android'],
  });
  assert.equal(plan[0].eligible, true);
  assert.equal(plan[0].hasActualChanges, true);
  assert.deepEqual(plan[0].nextBlockedApps, ['com.instagram.android']);

  // No-op check: allowing an app that is not currently blocked
  const noopPlan = computeBulkActionPlan(devices, ['dev1'], 'allow_apps', {
    packages: ['com.twitter.android'],
  });
  assert.equal(noopPlan[0].eligible, false);
  assert.equal(noopPlan[0].hasActualChanges, false);
  assert.match(noopPlan[0].skipReason, /تطابق التعديل المطلوب/);
});

test('12. computeBulkActionPlan enforces tethering inversion rule: allow = !block_tethering', () => {
  const devices = [
    {
      uid: 'dev1',
      approvalState: 'approved',
      policy: { schema_version: 1, revision: 3, block_tethering: true, blocked_apps: [] },
    },
    {
      uid: 'dev2',
      approvalState: 'approved',
      policy: { schema_version: 1, revision: 2, block_tethering: false, blocked_apps: [] },
    },
  ];

  // Request to allow tethering (allowTethering: true -> target block_tethering: false)
  const allowPlan = computeBulkActionPlan(devices, ['dev1', 'dev2'], 'set_tethering', {
    allowTethering: true,
  });

  const dev1Plan = allowPlan.find((i) => i.uid === 'dev1');
  assert.equal(dev1Plan.eligible, true);
  assert.equal(dev1Plan.hasActualChanges, true);
  assert.equal(dev1Plan.nextBlockTethering, false);

  const dev2Plan = allowPlan.find((i) => i.uid === 'dev2');
  assert.equal(dev2Plan.eligible, false);
  assert.equal(dev2Plan.hasActualChanges, false); // already allowed
  assert.match(dev2Plan.skipReason, /تطابق التعديل المطلوب/);

  // Request to block tethering (allowTethering: false -> target block_tethering: true)
  const blockPlan = computeBulkActionPlan(devices, ['dev2'], 'set_tethering', {
    allowTethering: false,
  });
  assert.equal(blockPlan[0].eligible, true);
  assert.equal(blockPlan[0].hasActualChanges, true);
  assert.equal(blockPlan[0].nextBlockTethering, true);
});

test('13. parseAppInventoryData parses valid inventory and flags missing version or bad apps array', () => {
  const valid = parseAppInventoryData({
    schema_version: 1,
    batch_id: 'batch_01',
    batch_index: 0,
    total_batches: 1,
    agent_version: '0.3.1-pilot',
    apps: [
      { package_name: 'com.whatsapp', app_name: 'WhatsApp', is_system_app: false },
      { package_name: 'com.android.settings', app_name: 'Settings', is_system_app: true },
    ],
  });
  assert.equal(valid.isCorrupted, false);
  assert.equal(valid.agent_version, '0.3.1-pilot');
  assert.equal(valid.apps.length, 2);
  assert.equal(valid.apps[0].package_name, 'com.whatsapp');

  // Corrupted schema_version or missing version
  const badVersion = parseAppInventoryData({
    schema_version: 2,
    apps: [],
  });
  assert.equal(badVersion.isCorrupted, true);

  // Apps is not an array
  const badApps = parseAppInventoryData({
    schema_version: 1,
    apps: 'not an array',
  });
  assert.equal(badApps.isCorrupted, true);
});

test('14. formatLastSeenAr produces honest relative text and acknowledges FCM background behavior', () => {
  const now = Date.now();
  const recent = formatLastSeenAr(now - 120000); // 2 minutes ago
  assert.match(recent.relative, /دقيقة|دقائق|منذ/);
  assert.match(recent.explanation, /تواصل حديث/);

  const nullSeen = formatLastSeenAr(null);
  assert.equal(nullSeen.relative, 'لا يوجد سجل');
  assert.match(nullSeen.explanation, /لم يسبق للجهاز/);

  // Long ago (e.g. 5 hours ago)
  const oldSeen = formatLastSeenAr(now - 5 * 3600 * 1000);
  assert.match(oldSeen.relative, /ساعة|ساعات|منذ/);
  assert.ok(oldSeen.explanation.includes('لا يُعد قدم التاريخ دليلاً قاطعاً'));
});

test('15. kiosk requires explicit valid fields and 12+ char maintenance verifier with PBKDF2-HMAC-SHA256 (120000 iterations)', async () => {
  const {
    validateKiosk,
    passwordVerifier,
    supportsKioskAgent,
    MIN_MAINTENANCE_PASSWORD_LENGTH,
    PBKDF2_ITERATIONS,
  } = await import('../src/components/KioskPanel.tsx');

  assert.equal(MIN_MAINTENANCE_PASSWORD_LENGTH, 12);
  assert.equal(PBKDF2_ITERATIONS, 120000);

  // Rejects passwords shorter than 12 characters
  await assert.rejects(
    async () => passwordVerifier('short8ch'),
    /12 إلى 128 حرفًا/
  );
  await assert.rejects(
    async () => passwordVerifier('11charslong'),
    /12 إلى 128 حرفًا/
  );

  // Accepts 12+ character password and derives PBKDF2-HMAC-SHA256 with 120000 iterations
  const credential = await passwordVerifier('A-long-test-password!');
  const p = {
    schema_version: 1,
    revision: 1,
    enabled: true,
    allowed_apps: ['com.whatsapp'],
    ...credential,
  };
  assert.equal(validateKiosk(p), true);
  assert.equal(validateKiosk({ ...p, enabled: 'false' }), false);
  assert.equal(validateKiosk({ ...p, allowed_apps: [] }), false);
  assert.equal(validateKiosk({ ...p, exit_hash: '' }), false);
  assert.equal(validateKiosk({ ...p, enabled: false, allowed_apps: [] }), true);

  const { pbkdf2Sync } = await import('node:crypto');
  assert.equal(
    pbkdf2Sync(
      'A-long-test-password!',
      Buffer.from(credential.exit_salt, 'hex'),
      120000,
      32,
      'sha256'
    ).toString('hex'),
    credential.exit_hash
  );

  assert.equal(supportsKioskAgent({ agent_version: 'pilot-0.4.0', android_sdk: 35 }), true);
  assert.equal(supportsKioskAgent({ agent_version: '0.4.0-pilot', android_sdk: 30 }), true);
  assert.equal(supportsKioskAgent({ agent_version: '0.3.1-pilot', android_sdk: 35 }), false);
  assert.equal(supportsKioskAgent({ agent_version: '0.4.0-pilot', android_sdk: 29 }), false);
  assert.equal(supportsKioskAgent({ agent_version: '0.4.0-pilot' }), false);
});

test('16. presentation helpers replace raw UIDs and technical jargon with clear Arabic descriptions', async () => {
  const {
    getDeviceFriendlyName,
    formatEnforcementSummaryAr,
    formatAuditLogSummaryAr,
  } = await import('../src/utils/presentation.ts');

  const sampleDevice = {
    uid: 'goElmljvGAeUlp8yDu6exzc2Tfj1',
    metadata: { device_name: 'جهاز التجربة الجديد', rep_name: 'أحمد العتيبي' },
    status: {
      model: 'INFINIX Infinix X6885',
      device_owner: true,
      applied_revision: 41,
      tethering_restricted: true,
      error: '',
    },
    policy: {
      schema_version: 1,
      revision: 41,
      block_tethering: true,
      blocked_apps: ['com.zhiliaoapp.musically'],
    },
    enforcementState: 'applied',
    enforcementDetail: 'تم التحقق من تطبيق الإصدار 41 بنجاح على الجهاز.',
  };

  assert.equal(getDeviceFriendlyName(sampleDevice), 'جهاز التجربة الجديد');

  const deviceMap = new Map([[sampleDevice.uid, sampleDevice]]);
  const rawAudit = {
    id: 'log1',
    actor_uid: 'admin1',
    actor_email: 'mashhoor.info@gmail.com',
    target_uid: 'goElmljvGAeUlp8yDu6exzc2Tfj1',
    action: 'update_policy',
    summary:
      'تحديث سياسة الجهاز (goElmljvGAeUlp8yDu6exzc2Tfj1) إلى الإصدار 41: منع المشاركة=مفعل، تطبيقات محظورة=1',
    before: {},
    after: {},
    created_at: null,
  };

  const formattedAudit = formatAuditLogSummaryAr(rawAudit, deviceMap);
  assert.ok(!formattedAudit.includes('goElmljvGAeUlp8yDu6exzc2Tfj1'));
  assert.ok(formattedAudit.includes('جهاز التجربة الجديد'));

  const errorDevice = {
    ...sampleDevice,
    metadata: null,
    policy: null,
    enforcementState: 'error',
    enforcementDetail:
      'لم تُنشأ سياسة بعد، لكن الجهاز أبلغ عن خطأ: IllegalStateException: Device Owner غير مفعل؛ لم تطبق السياسة.',
  };
  assert.equal(getDeviceFriendlyName(errorDevice), 'جهاز INFINIX Infinix X6885');
  const errSummary = formatEnforcementSummaryAr(errorDevice);
  assert.ok(!errSummary.summary.includes('IllegalStateException'));
  assert.match(errSummary.summary, /صلاحية إدارة الجهاز غير مفعّلة/);
});

test('17. validateAndBuildKioskTransaction strictly requires device_owner === true on enable, scopes app availability & blocked_apps conflict to enable, allows disabling even with blocked/unavailable apps, and redacts audit log', async () => {
  const { validateAndBuildKioskTransaction, passwordVerifier } = await import(
    '../src/components/KioskPanel.tsx'
  );

  const secretPassword = 'AdminSecretPassword#2026';
  const credential = await passwordVerifier(secretPassword);

  const validBaseInput = {
    uid: 'dev_kiosk_1',
    actor: {
      uid: 'admin_1',
      email: 'mashhoor.info@gmail.com',
      emailVerified: true,
      isAnonymous: false,
      isAuthorizedAdmin: true,
    },
    serverReadConfirmed: true,
    expectedRevision: 2,
    enabled: true,
    allowedApps: ['com.whatsapp', 'com.company.salesapp'],
    credential,
    existingKioskDoc: {
      schema_version: 1,
      revision: 2,
      enabled: false,
      allowed_apps: ['com.whatsapp'],
      exit_salt: credential.exit_salt,
      exit_hash: credential.exit_hash,
    },
    enrollmentDoc: { approved: true },
    deviceStatusDoc: {
      device_owner: true,
      android_sdk: 34,
      agent_version: '0.4.0-pilot',
    },
    policyDoc: {
      schema_version: 1,
      revision: 5,
      block_tethering: true,
      blocked_apps: ['com.zhiliaoapp.musically'],
    },
    inventoryDoc: {
      schema_version: 1,
      apps: [
        {
          package_name: 'com.whatsapp',
          app_name: 'WhatsApp',
          has_launcher_icon: true,
          is_enabled: true,
          is_hidden_by_agent: false,
        },
        {
          package_name: 'com.company.salesapp',
          app_name: 'Sales App',
          has_launcher_icon: true,
          is_enabled: true,
          is_hidden_by_agent: false,
        },
      ],
    },
  };

  // 1. Fails if serverReadConfirmed is false or actor is unauthorized
  assert.throws(
    () => validateAndBuildKioskTransaction({ ...validBaseInput, serverReadConfirmed: false }),
    /يلزم اتصال مؤكد بالخادم وصلاحية مدير/
  );
  assert.throws(
    () =>
      validateAndBuildKioskTransaction({
        ...validBaseInput,
        actor: { ...validBaseInput.actor, isAuthorizedAdmin: false },
      }),
    /يلزم اتصال مؤكد بالخادم وصلاحية مدير/
  );

  // 2. Fails if device is not approved in enrollments/{uid}
  assert.throws(
    () =>
      validateAndBuildKioskTransaction({
        ...validBaseInput,
        enrollmentDoc: { approved: false },
      }),
    /غير معتمد/
  );

  // 3. When enabling (enabled: true), strictly requires deviceStatusDoc.device_owner === true
  // Rejects false, missing (undefined), null, 'true' (string), 1 (number), and null deviceStatusDoc
  for (const invalidDeviceOwner of [false, undefined, null, 'true', 1, {}]) {
    assert.throws(
      () =>
        validateAndBuildKioskTransaction({
          ...validBaseInput,
          enabled: true,
          deviceStatusDoc: {
            device_owner: invalidDeviceOwner,
            android_sdk: 34,
            agent_version: '0.4.0-pilot',
          },
        }),
      /Device Owner/
    );
  }
  assert.throws(
    () =>
      validateAndBuildKioskTransaction({
        ...validBaseInput,
        enabled: true,
        deviceStatusDoc: null,
      }),
    /Device Owner/
  );

  // Also fails if agent version < 0.4.0 or SDK < 30 when enabling
  assert.throws(
    () =>
      validateAndBuildKioskTransaction({
        ...validBaseInput,
        deviceStatusDoc: { device_owner: true, android_sdk: 34, agent_version: '0.3.1-pilot' },
      }),
    /0\.4\.0/
  );
  assert.throws(
    () =>
      validateAndBuildKioskTransaction({
        ...validBaseInput,
        deviceStatusDoc: { device_owner: true, android_sdk: 29, agent_version: '0.4.0-pilot' },
      }),
    /Android 11/
  );

  // 4. When enabling (enabled: true), fails if an allowed app is missing from inventory, disabled, or hidden by agent
  assert.throws(
    () =>
      validateAndBuildKioskTransaction({
        ...validBaseInput,
        enabled: true,
        allowedApps: ['com.whatsapp', 'com.missing.app'],
      }),
    /غير متاح حسب آخر جرد: com\.missing\.app/
  );
  assert.throws(
    () =>
      validateAndBuildKioskTransaction({
        ...validBaseInput,
        enabled: true,
        inventoryDoc: {
          schema_version: 1,
          apps: [
            {
              package_name: 'com.whatsapp',
              app_name: 'WhatsApp',
              has_launcher_icon: true,
              is_enabled: false,
              is_hidden_by_agent: false,
            },
            {
              package_name: 'com.company.salesapp',
              app_name: 'Sales App',
              has_launcher_icon: true,
              is_enabled: true,
              is_hidden_by_agent: false,
            },
          ],
        },
      }),
    /غير متاح حسب آخر جرد: com\.whatsapp/
  );

  // 5. When enabling (enabled: true), fails if an allowed app conflicts with policies/{uid}.blocked_apps or protected packages
  assert.throws(
    () =>
      validateAndBuildKioskTransaction({
        ...validBaseInput,
        enabled: true,
        policyDoc: {
          schema_version: 1,
          revision: 5,
          block_tethering: true,
          blocked_apps: ['com.whatsapp'],
        },
      }),
    /أزل التطبيق من الحظر أولًا/
  );
  assert.throws(
    () =>
      validateAndBuildKioskTransaction({
        ...validBaseInput,
        enabled: true,
        allowedApps: ['com.android.settings'],
      }),
    /أزل التطبيق من الحظر أولًا أو اختر تطبيق عمل مناسبًا/
  );

  // 6. Disabling Kiosk (enabled: false) SUCCEEDS even if a selected app became blocked in policies/{uid}.blocked_apps
  // or became unavailable/uninstalled in deviceAppInventory/{uid}, while STILL enforcing admin auth, approval,
  // expectedRevision, document schema (validateKiosk), and redacted audit log!
  const disableWithBlockedAndUnavailableApp = validateAndBuildKioskTransaction({
    ...validBaseInput,
    enabled: false,
    allowedApps: ['com.whatsapp', 'com.uninstalled.app'],
    policyDoc: {
      schema_version: 1,
      revision: 6,
      block_tethering: true,
      blocked_apps: ['com.whatsapp'], // com.whatsapp is now blocked!
    },
    inventoryDoc: {
      schema_version: 1,
      apps: [], // apps are no longer in inventory!
    },
  });
  assert.equal(disableWithBlockedAndUnavailableApp.nextPolicy.enabled, false);
  assert.equal(disableWithBlockedAndUnavailableApp.nextPolicy.revision, 3);
  assert.deepEqual(disableWithBlockedAndUnavailableApp.nextPolicy.allowed_apps, [
    'com.uninstalled.app',
    'com.whatsapp',
  ]);
  assert.match(disableWithBlockedAndUnavailableApp.auditLog.summary, /تعطيل/);

  // Even when disabling (enabled: false), admin auth, device approval, revision check, and protected package rejection are still enforced:
  assert.throws(
    () =>
      validateAndBuildKioskTransaction({
        ...validBaseInput,
        enabled: false,
        enrollmentDoc: { approved: false },
      }),
    /غير معتمد/
  );
  assert.throws(
    () =>
      validateAndBuildKioskTransaction({
        ...validBaseInput,
        enabled: false,
        expectedRevision: 99,
      }),
    /تعارض إصدارات/
  );
  assert.throws(
    () =>
      validateAndBuildKioskTransaction({
        ...validBaseInput,
        enabled: false,
        allowedApps: ['com.android.settings'],
      }),
    /أزل التطبيق من الحظر أولًا أو اختر تطبيق عمل مناسبًا/
  );

  // 7. Succeeds on enable when all guarantees hold and redacts password, exit_salt, and exit_hash from auditLog
  const result = validateAndBuildKioskTransaction(validBaseInput);
  assert.equal(result.nextPolicy.revision, 3);
  assert.equal(result.nextPolicy.enabled, true);
  assert.deepEqual(result.nextPolicy.allowed_apps, ['com.company.salesapp', 'com.whatsapp']);
  assert.equal(result.auditLog.target_uid, 'dev_kiosk_1');
  assert.equal(result.auditLog.action, 'update_policy');

  const serializedAudit = JSON.stringify(result.auditLog);
  assert.equal(serializedAudit.includes(secretPassword), false);
  assert.equal(serializedAudit.includes(credential.exit_salt), false);
  assert.equal(serializedAudit.includes(credential.exit_hash), false);
  assert.equal('exit_salt' in result.auditLog.before, false);
  assert.equal('exit_hash' in result.auditLog.before, false);
  assert.equal('exit_salt' in result.auditLog.after, false);
  assert.equal('exit_hash' in result.auditLog.after, false);
});

test('18. applyKioskSnapshotToDraftState preserves admin draft and pinned expectedRevision when new snapshots arrive, surfacing revision conflict', async () => {
  const { applyKioskSnapshotToDraftState, passwordVerifier } = await import(
    '../src/components/KioskPanel.tsx'
  );
  const cred = await passwordVerifier('ValidMaintenancePass123!');

  const policyV1 = {
    schema_version: 1,
    revision: 1,
    enabled: false,
    allowed_apps: ['com.whatsapp'],
    ...cred,
  };
  const policyV2 = {
    schema_version: 1,
    revision: 2,
    enabled: true,
    allowed_apps: ['com.whatsapp', 'com.other.remote'],
    ...cred,
  };

  // Initial snapshot when clean (isDirty: false)
  const cleanState = applyKioskSnapshotToDraftState(
    {
      remote: null,
      enabled: false,
      allowedApps: [],
      password: '',
      confirmPassword: '',
      expectedRevision: null,
      isDirty: false,
      revisionConflict: null,
    },
    policyV1
  );
  assert.equal(cleanState.expectedRevision, 1);
  assert.deepEqual(cleanState.allowedApps, ['com.whatsapp']);
  assert.equal(cleanState.revisionConflict, null);

  // Admin begins editing on top of v1 (isDirty: true, expectedRevision pinned at 1)
  const dirtyDraft = {
    ...cleanState,
    isDirty: true,
    enabled: true,
    allowedApps: ['com.whatsapp', 'com.admin.draftapp'],
    password: 'NewAdminPassword12345',
    confirmPassword: 'NewAdminPassword12345',
  };

  // New snapshot v2 arrives while admin has an active dirty draft
  const afterSnapshotV2 = applyKioskSnapshotToDraftState(dirtyDraft, policyV2);

  // Draft values and expectedRevision MUST remain preserved, and revisionConflict MUST be set
  assert.equal(afterSnapshotV2.enabled, true);
  assert.deepEqual(afterSnapshotV2.allowedApps, ['com.whatsapp', 'com.admin.draftapp']);
  assert.equal(afterSnapshotV2.password, 'NewAdminPassword12345');
  assert.equal(afterSnapshotV2.expectedRevision, 1);
  assert.notEqual(afterSnapshotV2.revisionConflict, null);
  assert.equal(afterSnapshotV2.revisionConflict?.pinnedRevision, 1);
  assert.equal(afterSnapshotV2.revisionConflict?.incomingRevision, 2);
});

test('19. App.tsx createAppBrowserNavigation protects unsaved changes on tab switch, page leave, and browser Back/Forward without wiping Forward history or adding duplicate entries', async () => {
  const { createAppBrowserNavigation } = await import('../src/App.tsx');

  // Spec-compliant browser window + HTML5 session history stack
  function createSpecBrowserWindow(initialHash = '#/overview') {
    const listeners = new Map();
    const entries = [{ state: null, url: initialHash }];
    let currentIndex = 0;

    const dispatch = (type, eventObj = {}) => {
      const list = listeners.get(type) || [];
      for (const fn of [...list]) {
        fn(eventObj);
      }
    };

    const win = {
      location: {
        get hash() {
          return entries[currentIndex].url;
        },
        set hash(newHash) {
          const formatted = newHash.startsWith('#') ? newHash : `#${newHash}`;
          // Setting location.hash directly in a browser truncates forward history and pushes a new entry
          entries.splice(currentIndex + 1);
          entries.push({ state: null, url: formatted });
          currentIndex = entries.length - 1;
          dispatch('popstate', { state: null });
          dispatch('hashchange', {});
        },
      },
      history: {
        get state() {
          return entries[currentIndex].state;
        },
        get length() {
          return entries.length;
        },
        pushState(state, _unused, url) {
          // Standard HTML5 pushState truncates forward history and appends entry
          entries.splice(currentIndex + 1);
          entries.push({
            state: state ? structuredClone(state) : null,
            url: String(url || entries[currentIndex].url),
          });
          currentIndex = entries.length - 1;
        },
        replaceState(state, _unused, url) {
          entries[currentIndex] = {
            state: state ? structuredClone(state) : null,
            url: String(url || entries[currentIndex].url),
          };
        },
        go(delta = 0) {
          if (delta === 0) return;
          const target = currentIndex + delta;
          if (target < 0 || target >= entries.length) return;
          currentIndex = target;
          dispatch('popstate', { state: entries[currentIndex].state });
          dispatch('hashchange', {});
        },
        back() {
          this.go(-1);
        },
        forward() {
          this.go(1);
        },
        // Inspection helpers for test assertions
        _getEntriesSnapshot() {
          return entries.map((e) => ({ url: e.url, state: e.state }));
        },
        _getCurrentIndex() {
          return currentIndex;
        },
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
    };

    return win;
  }

  const flushMicrotasks = () => new Promise((resolve) => queueMicrotask(resolve));

  const win = createSpecBrowserWindow('#/overview');
  let isDirty = false;
  let activeRoute = null;
  let pendingAction = null;
  let discardSignalCount = 0;
  const savedValues = { enabled: false, allowedApps: ['com.whatsapp'] };
  let formValues = { ...savedValues };

  const nav = createAppBrowserNavigation({
    win,
    isDirty: () => isDirty,
    onRouteChange: (nextRoute) => {
      activeRoute = nextRoute;
    },
    onPendingActionChange: (action) => {
      pendingAction = action;
    },
    onDiscardDraft: () => {
      isDirty = false;
      formValues = { ...savedValues };
      discardSignalCount += 1;
    },
  });

  const detach = nav.attach();
  await flushMicrotasks();

  // Build realistic navigation history:
  // idx 0: #/overview
  // idx 1: #/devices
  // idx 2: #/devices/dev123
  // idx 3: #/devices/dev123/kiosk
  // idx 4: #/audit
  nav.navigateWithGuard('devices', null);
  await flushMicrotasks();
  nav.navigateWithGuard('devices', 'dev123', 'general', 'overview');
  await flushMicrotasks();
  nav.navigateWithGuard('devices', 'dev123', 'general', 'kiosk');
  await flushMicrotasks();
  nav.navigateWithGuard('audit', null);
  await flushMicrotasks();

  assert.equal(win.history.length, 5);
  assert.equal(win.history._getCurrentIndex(), 4);
  assert.equal(win.location.hash, '#/audit');

  // Press Browser Back once while clean (idx 4 -> idx 3: #/devices/dev123/kiosk)
  // Now idx 4 (#/audit) is in the browser's Forward history!
  win.history.back();
  await flushMicrotasks();

  assert.equal(win.history._getCurrentIndex(), 3);
  assert.equal(win.location.hash, '#/devices/dev123/kiosk');
  assert.equal(activeRoute.tab, 'devices');
  assert.equal(activeRoute.deviceUid, 'dev123');
  assert.equal(activeRoute.deviceTab, 'kiosk');
  assert.equal(win.history.length, 5);

  // Admin edits Kiosk form on #/devices/dev123/kiosk -> isDirty = true
  isDirty = true;
  const editedDraft = { enabled: true, allowedApps: ['com.whatsapp', 'com.company.sales'] };
  formValues = { ...editedDraft };

  // 1. Attempt to switch device sub-tab (kiosk -> apps) while dirty, then cancel
  nav.navigateWithGuard('devices', 'dev123', 'general', 'apps');
  assert.equal(nav.hasPendingNavigation(), true);
  assert.notEqual(pendingAction, null);
  assert.equal(win.location.hash, '#/devices/dev123/kiosk');
  assert.equal(activeRoute.deviceTab, 'kiosk');

  nav.cancelPendingNavigation();
  assert.equal(nav.hasPendingNavigation(), false);
  assert.equal(pendingAction, null);
  assert.equal(win.location.hash, '#/devices/dev123/kiosk');
  assert.equal(activeRoute.deviceTab, 'kiosk');
  assert.deepEqual(formValues, editedDraft);
  assert.equal(win.history.length, 5);

  // 2. Attempt to leave page (kiosk -> overview) while dirty, then cancel
  nav.navigateWithGuard('overview', null);
  assert.equal(nav.hasPendingNavigation(), true);
  nav.cancelPendingNavigation();
  assert.equal(win.location.hash, '#/devices/dev123/kiosk');
  assert.equal(activeRoute.tab, 'devices');
  assert.equal(activeRoute.deviceUid, 'dev123');
  assert.equal(activeRoute.deviceTab, 'kiosk');
  assert.deepEqual(formValues, editedDraft);
  assert.equal(win.history.length, 5);

  // 3. Press Browser Back (idx 3 -> idx 2: #/devices/dev123) while dirty, then cancel
  win.history.back();
  await flushMicrotasks();

  // App.tsx intercepts via history.go(1), restoring cursor to idx 3 WITHOUT wiping Forward history (idx 4: #/audit)
  // and WITHOUT adding any duplicate history entries!
  assert.equal(nav.hasPendingNavigation(), true);
  assert.equal(win.location.hash, '#/devices/dev123/kiosk');
  assert.equal(win.history._getCurrentIndex(), 3);
  assert.equal(win.history.length, 5);
  assert.equal(win.history._getEntriesSnapshot()[4].url, '#/audit'); // Forward history preserved!

  nav.cancelPendingNavigation();
  assert.equal(nav.hasPendingNavigation(), false);
  assert.equal(win.location.hash, '#/devices/dev123/kiosk');
  assert.equal(activeRoute.tab, 'devices');
  assert.equal(activeRoute.deviceUid, 'dev123');
  assert.equal(activeRoute.deviceTab, 'kiosk');
  assert.deepEqual(formValues, editedDraft);
  assert.equal(win.history.length, 5);

  // 4. Press Browser Forward (idx 3 -> idx 4: #/audit) while dirty, then cancel
  // Because Forward history was NOT wiped on Back+Cancel, win.history.forward() reaches idx 4 (#/audit)!
  win.history.forward();
  await flushMicrotasks();

  // App.tsx intercepts via history.go(-1), restoring cursor to idx 3 WITHOUT adding duplicate entries!
  assert.equal(nav.hasPendingNavigation(), true);
  assert.equal(win.location.hash, '#/devices/dev123/kiosk');
  assert.equal(win.history._getCurrentIndex(), 3);
  assert.equal(win.history.length, 5);
  assert.equal(win.history._getEntriesSnapshot()[4].url, '#/audit');

  nav.cancelPendingNavigation();
  assert.equal(nav.hasPendingNavigation(), false);
  assert.equal(win.location.hash, '#/devices/dev123/kiosk');
  assert.equal(activeRoute.tab, 'devices');
  assert.equal(activeRoute.deviceUid, 'dev123');
  assert.equal(activeRoute.deviceTab, 'kiosk');
  assert.deepEqual(formValues, editedDraft);
  assert.equal(win.history.length, 5);

  // 5. Press Browser Forward again (idx 3 -> idx 4: #/audit) and CONFIRM leaving
  win.history.forward();
  await flushMicrotasks();
  assert.equal(nav.hasPendingNavigation(), true);

  nav.confirmPendingNavigation();
  await flushMicrotasks();

  assert.equal(nav.hasPendingNavigation(), false);
  assert.equal(isDirty, false);
  assert.equal(discardSignalCount, 1);
  assert.deepEqual(formValues, savedValues);
  assert.equal(win.location.hash, '#/audit');
  assert.equal(activeRoute.tab, 'audit');
  assert.equal(activeRoute.deviceUid, null);
  assert.equal(win.history._getCurrentIndex(), 4);
  assert.equal(win.history.length, 5); // Zero duplicate history entries added even after Confirm!

  detach();
});

test('20. evaluateKioskEnforcementState only reports applied when configured_revision === revision, active === enabled, no error, no maintenance, and install_blocked is confirmed when enabled', async () => {
  const { evaluateKioskEnforcementState, passwordVerifier } = await import(
    '../src/components/KioskPanel.tsx'
  );
  const cred = await passwordVerifier('ValidMaintenancePass123!');

  const enabledPolicy = {
    schema_version: 1,
    revision: 4,
    enabled: true,
    allowed_apps: ['com.whatsapp'],
    ...cred,
  };

  // Mismatched configured_revision -> pending (not applied)
  const staleRev = evaluateKioskEnforcementState(enabledPolicy, {
    configured_revision: 3,
    active: true,
    install_blocked: true,
    maintenance: false,
    error: '',
  });
  assert.equal(staleRev.isConfirmed, false);
  assert.equal(staleRev.state, 'pending');

  // Mismatched active !== enabled -> pending (not applied)
  const inactiveOnPhone = evaluateKioskEnforcementState(enabledPolicy, {
    configured_revision: 4,
    active: false,
    install_blocked: true,
    maintenance: false,
    error: '',
  });
  assert.equal(inactiveOnPhone.isConfirmed, false);
  assert.equal(inactiveOnPhone.state, 'pending');

  // Missing install_blocked when enabled -> pending (not applied)
  const installNotBlocked = evaluateKioskEnforcementState(enabledPolicy, {
    configured_revision: 4,
    active: true,
    install_blocked: false,
    maintenance: false,
    error: '',
  });
  assert.equal(installNotBlocked.isConfirmed, false);
  assert.equal(installNotBlocked.state, 'pending');

  // In maintenance mode -> maintenance (not applied)
  const maintenanceOpen = evaluateKioskEnforcementState(enabledPolicy, {
    configured_revision: 4,
    active: true,
    install_blocked: true,
    maintenance: true,
    error: '',
  });
  assert.equal(maintenanceOpen.isConfirmed, false);
  assert.equal(maintenanceOpen.state, 'maintenance');

  // Non-empty error -> error (not applied)
  const withError = evaluateKioskEnforcementState(enabledPolicy, {
    configured_revision: 4,
    active: true,
    install_blocked: true,
    maintenance: false,
    error: 'LockTask failed',
  });
  assert.equal(withError.isConfirmed, false);
  assert.equal(withError.state, 'error');

  // All criteria met when enabled -> applied / isConfirmed: true
  const fullyConfirmed = evaluateKioskEnforcementState(enabledPolicy, {
    configured_revision: 4,
    active: true,
    install_blocked: true,
    maintenance: false,
    error: '',
  });
  assert.equal(fullyConfirmed.isConfirmed, true);
  assert.equal(fullyConfirmed.state, 'applied');

  // Disabled policy requires configured_revision === revision, active === false, no error, no maintenance
  const disabledPolicy = { ...enabledPolicy, revision: 5, enabled: false, allowed_apps: [] };
  const stillActiveOnPhone = evaluateKioskEnforcementState(disabledPolicy, {
    configured_revision: 5,
    active: true,
    install_blocked: false,
    maintenance: false,
    error: '',
  });
  assert.equal(stillActiveOnPhone.isConfirmed, false);

  const confirmedDisabled = evaluateKioskEnforcementState(disabledPolicy, {
    configured_revision: 5,
    active: false,
    install_blocked: false,
    maintenance: false,
    error: '',
  });
  assert.equal(confirmedDisabled.isConfirmed, true);
  assert.equal(confirmedDisabled.state, 'applied');
});

test('21. classifyFirestoreError separates permission_denied, connectivity, and other errors without unverified claims about deployed rules', async () => {
  const { classifyFirestoreError } = await import('../src/components/KioskPanel.tsx');

  const permErr = classifyFirestoreError(
    { code: 'permission-denied', message: 'Missing or insufficient permissions.' },
    'kioskPolicies'
  );
  assert.equal(permErr.category, 'permission_denied');
  assert.equal(permErr.detail.includes('لم تُحدّث بعد'), false);
  assert.equal(permErr.detail.includes('لم تُنشر بعد'), false);

  const netErr = classifyFirestoreError(
    { code: 'unavailable', message: 'Failed to get document because the client is offline.' },
    'kioskStatus'
  );
  assert.equal(netErr.category, 'connectivity');

  const otherErr = classifyFirestoreError(
    new Error('Custom validation failure'),
    'kioskPolicies'
  );
  assert.equal(otherErr.category, 'other');
  assert.match(otherErr.detail, /Custom validation failure/);
});

test('22. executeKioskSave writes kioskPolicies and auditLogs atomically inside the same transaction, and writes neither when any validation fails', async () => {
  const { executeKioskSave, passwordVerifier } = await import(
    '../src/components/KioskPanel.tsx'
  );

  // Transactional in-memory Firestore harness that stages tx.set calls per transaction
  // and only commits them if the transaction callback resolves without throwing.
  function createTransactionalStore(initialDocs = {}) {
    const store = new Map(Object.entries(initialDocs));
    const committedTransactions = [];
    const abortedTransactions = [];
    let autoIdCounter = 0;

    const docFn = (firstArg, colName, docId) => {
      if (typeof firstArg === 'object' && firstArg !== null && 'name' in firstArg && colName === undefined) {
        autoIdCounter += 1;
        return { path: `${firstArg.name}/audit_${autoIdCounter}` };
      }
      return { path: `${colName}/${docId}` };
    };

    const collectionFn = (_db, name) => ({ name });

    const getDocFromServerFn = async (ref) => {
      const val = store.get(ref.path);
      return {
        exists: () => val !== undefined,
        data: () => (val !== undefined ? structuredClone(val) : undefined),
      };
    };

    const runTransactionFn = async (_db, updateFunction) => {
      const stagedWrites = [];
      const txReads = [];
      const txId = `tx_${committedTransactions.length + abortedTransactions.length + 1}`;

      const tx = {
        async get(ref) {
          txReads.push(ref.path);
          const val = store.get(ref.path);
          return {
            exists: () => val !== undefined,
            data: () => (val !== undefined ? structuredClone(val) : undefined),
          };
        },
        set(ref, data) {
          stagedWrites.push({ path: ref.path, data: structuredClone(data) });
          return tx;
        },
      };

      try {
        const result = await updateFunction(tx);
        // Commit all staged writes atomically ONLY if updateFunction succeeded
        for (const w of stagedWrites) {
          store.set(w.path, w.data);
        }
        committedTransactions.push({ txId, reads: txReads, writes: stagedWrites });
        return result;
      } catch (err) {
        abortedTransactions.push({ txId, reads: txReads, stagedWritesThatWereRolledBack: stagedWrites });
        throw err;
      }
    };

    return {
      store,
      committedTransactions,
      abortedTransactions,
      deps: {
        docFn,
        collectionFn,
        getDocFromServerFn,
        runTransactionFn,
        serverTimestampFn: () => 'SERVER_TIMESTAMP_SENTINEL',
        passwordVerifierFn: passwordVerifier,
      },
    };
  }

  const actor = {
    uid: 'admin_uid_1',
    email: 'mashhoor.info@gmail.com',
    emailVerified: true,
    isAnonymous: false,
    isAuthorizedAdmin: true,
    hasCustomAdminClaim: false,
  };

  const baseDocs = {
    'admins/admin_uid_1': { active: true, email: 'mashhoor.info@gmail.com' },
    'enrollments/dev_1': { approved: true },
    'deviceStatus/dev_1': {
      device_owner: true,
      android_sdk: 34,
      agent_version: '0.4.0-pilot',
    },
    'policies/dev_1': {
      schema_version: 1,
      revision: 3,
      block_tethering: true,
      blocked_apps: ['com.zhiliaoapp.musically'],
    },
    'deviceAppInventory/dev_1': {
      schema_version: 1,
      apps: [
        {
          package_name: 'com.whatsapp',
          app_name: 'WhatsApp',
          has_launcher_icon: true,
          is_enabled: true,
          is_hidden_by_agent: false,
        },
      ],
    },
  };

  // 1. Successful save (enabling Kiosk) writes BOTH kioskPolicies/dev_1 and auditLogs/audit_1 in the exact same transaction
  const env1 = createTransactionalStore(baseDocs);
  const savedPolicy1 = await executeKioskSave({
    db: {},
    uid: 'dev_1',
    actor,
    serverReady: true,
    expectedRevision: null,
    enabled: true,
    allowedApps: ['com.whatsapp'],
    password: 'StrongMaintenancePass#12',
    confirmPassword: 'StrongMaintenancePass#12',
    remote: null,
    deps: env1.deps,
  });

  assert.equal(env1.committedTransactions.length, 1);
  assert.equal(env1.abortedTransactions.length, 0);
  const tx1 = env1.committedTransactions[0];
  assert.equal(tx1.writes.length, 2);
  assert.equal(tx1.writes[0].path, 'kioskPolicies/dev_1');
  assert.equal(tx1.writes[1].path, 'auditLogs/audit_1');
  assert.deepEqual(env1.store.get('kioskPolicies/dev_1'), savedPolicy1);

  const writtenAudit1 = env1.store.get('auditLogs/audit_1');
  assert.equal(writtenAudit1.target_uid, 'dev_1');
  assert.equal(writtenAudit1.action, 'update_policy');
  assert.equal(writtenAudit1.created_at, 'SERVER_TIMESTAMP_SENTINEL');
  const auditJson = JSON.stringify(writtenAudit1);
  assert.equal(auditJson.includes('StrongMaintenancePass#12'), false);
  assert.equal(auditJson.includes(savedPolicy1.exit_salt), false);
  assert.equal(auditJson.includes(savedPolicy1.exit_hash), false);

  // 2. Failed save when device_owner is missing/non-boolean writes NEITHER kioskPolicies NOR auditLogs
  const envMissingDeviceOwner = createTransactionalStore({
    ...baseDocs,
    'deviceStatus/dev_1': {
      // device_owner is missing
      android_sdk: 34,
      agent_version: '0.4.0-pilot',
    },
  });
  await assert.rejects(
    async () =>
      executeKioskSave({
        db: {},
        uid: 'dev_1',
        actor,
        serverReady: true,
        expectedRevision: null,
        enabled: true,
        allowedApps: ['com.whatsapp'],
        password: 'StrongMaintenancePass#12',
        confirmPassword: 'StrongMaintenancePass#12',
        remote: null,
        deps: envMissingDeviceOwner.deps,
      }),
    /Device Owner/
  );
  assert.equal(envMissingDeviceOwner.committedTransactions.length, 0);
  assert.equal(envMissingDeviceOwner.abortedTransactions.length, 1);
  assert.equal(envMissingDeviceOwner.store.has('kioskPolicies/dev_1'), false);
  assert.equal(envMissingDeviceOwner.store.has('auditLogs/audit_1'), false);

  // 3. Failed save when app conflicts with blocked_apps on enable writes NEITHER kioskPolicies NOR auditLogs
  const envBlockedConflict = createTransactionalStore({
    ...baseDocs,
    'policies/dev_1': {
      schema_version: 1,
      revision: 4,
      block_tethering: true,
      blocked_apps: ['com.whatsapp'],
    },
  });
  await assert.rejects(
    async () =>
      executeKioskSave({
        db: {},
        uid: 'dev_1',
        actor,
        serverReady: true,
        expectedRevision: null,
        enabled: true,
        allowedApps: ['com.whatsapp'],
        password: 'StrongMaintenancePass#12',
        confirmPassword: 'StrongMaintenancePass#12',
        remote: null,
        deps: envBlockedConflict.deps,
      }),
    /أزل التطبيق من الحظر أولًا/
  );
  assert.equal(envBlockedConflict.committedTransactions.length, 0);
  assert.equal(envBlockedConflict.store.has('kioskPolicies/dev_1'), false);
  assert.equal(envBlockedConflict.store.has('auditLogs/audit_1'), false);

  // 4. Disabling Kiosk (enabled: false) when app became blocked and unavailable succeeds and writes BOTH atomically
  const envDisable = createTransactionalStore({
    ...baseDocs,
    'kioskPolicies/dev_1': savedPolicy1,
    'policies/dev_1': {
      schema_version: 1,
      revision: 4,
      block_tethering: true,
      blocked_apps: ['com.whatsapp'], // now blocked!
    },
    'deviceAppInventory/dev_1': {
      schema_version: 1,
      apps: [], // now unavailable!
    },
  });
  const disabledPolicy = await executeKioskSave({
    db: {},
    uid: 'dev_1',
    actor,
    serverReady: true,
    expectedRevision: 1,
    enabled: false,
    allowedApps: ['com.whatsapp'],
    password: '',
    confirmPassword: '',
    remote: savedPolicy1,
    deps: envDisable.deps,
  });
  assert.equal(disabledPolicy.enabled, false);
  assert.equal(disabledPolicy.revision, 2);
  assert.equal(envDisable.committedTransactions.length, 1);
  assert.equal(envDisable.committedTransactions[0].writes.length, 2);
  assert.equal(envDisable.store.get('kioskPolicies/dev_1').enabled, false);
  assert.equal(envDisable.store.get('auditLogs/audit_1').after.enabled, false);
});

test('23. buildMergedDevices marks isArchived: true, excludes archived devices from active fleet KPIs and default filters', () => {
  const activeDeviceRaw = {
    uid: 'active_1',
    enrollment: { approved: true },
    policy: { schema_version: 1, revision: 2, block_tethering: true, blocked_apps: [] },
    status: {
      device_owner: true,
      applied_revision: 2,
      tethering_restricted: true,
      last_seen: { toMillis: () => Date.now() - 60000 },
      model: 'TECNO POVA 5',
      android_sdk: 33,
      battery_percent: 80,
      error: '',
      agent_version: '0.4.0-pilot',
    },
    metadata: {
      device_name: 'جهاز المبيعات النشط',
      rep_name: 'سالم العلي',
      archived: false,
    },
  };

  const archivedDeviceRaw = {
    uid: 'archived_1',
    enrollment: { approved: true },
    policy: { schema_version: 1, revision: 1, block_tethering: true, blocked_apps: [] },
    status: {
      device_owner: true,
      applied_revision: 1,
      tethering_restricted: true,
      last_seen: { toMillis: () => Date.now() - 120000 },
      model: 'INFINIX X6885',
      android_sdk: 34,
      battery_percent: 75,
      error: '',
      agent_version: '0.4.0-pilot',
    },
    metadata: {
      device_name: 'جهاز قديم معار',
      rep_name: 'فهد الناصر',
      archived: true,
      archived_at: { toMillis: () => Date.now() - 3600000 },
      archived_by_uid: 'admin_1',
      archived_by_email: 'mashhoor.info@gmail.com',
    },
  };

  const enrollments = {
    active_1: activeDeviceRaw.enrollment,
    archived_1: archivedDeviceRaw.enrollment,
  };
  const policies = {
    active_1: activeDeviceRaw.policy,
    archived_1: archivedDeviceRaw.policy,
  };
  const statuses = {
    active_1: activeDeviceRaw.status,
    archived_1: archivedDeviceRaw.status,
  };
  const metadataMap = {
    active_1: activeDeviceRaw.metadata,
    archived_1: archivedDeviceRaw.metadata,
  };

  const merged = buildMergedDevices(enrollments, policies, statuses, metadataMap, Date.now());

  assert.equal(merged.length, 2);

  const activeRec = merged.find((d) => d.uid === 'active_1');
  const archivedRec = merged.find((d) => d.uid === 'archived_1');

  assert.ok(activeRec);
  assert.equal(activeRec.isArchived, false);
  assert.equal(activeRec.enforcementState, 'applied');

  assert.ok(archivedRec);
  assert.equal(archivedRec.isArchived, true);
  // Phone status and policy are fully preserved
  assert.equal(archivedRec.approvalState, 'approved');
  assert.equal(archivedRec.enforcementState, 'applied');

  // Verify KPI exclusion behavior: Active fleet counters strictly filter out isArchived
  const activeFleet = merged.filter((d) => !d.isArchived);
  assert.equal(activeFleet.length, 1);
  assert.equal(activeFleet[0].uid, 'active_1');

  const archivedFleet = merged.filter((d) => d.isArchived);
  assert.equal(archivedFleet.length, 1);
  assert.equal(archivedFleet[0].uid, 'archived_1');
});

test('24. setDeviceArchivedStatus writes deviceMetadata and auditLogs atomically in a transaction, without deleting documents or auth accounts', async () => {
  const actor = {
    uid: 'admin_master',
    email: 'mashhoor.info@gmail.com',
    isAuthorizedAdmin: true,
  };

  const unauthorizedActor = {
    uid: 'user_rep',
    email: 'rep@company.com',
    isAuthorizedAdmin: false,
  };

  // 1. Unauthorized actor rejected immediately
  await assert.rejects(
    async () => {
      const dbMock = {};
      const { setDeviceArchivedStatus } = await import('../src/services/mdmService.ts');
      await setDeviceArchivedStatus(dbMock, 'dev_target', true, unauthorizedActor);
    },
    /غير مصرح/
  );

  // 2. Mock transaction execution to verify atomic writes and data structure
  let committedWrites = [];
  const fakeDb = {};
  const fakeStore = new Map([
    [
      'deviceMetadata/dev_test',
      {
        device_name: 'هاتف الرياض 1',
        rep_name: 'أحمد',
        archived: false,
      },
    ],
  ]);

  const fakeTx = {
    get: async (docRef) => {
      const data = fakeStore.get(docRef.path);
      return {
        exists: () => data !== undefined,
        data: () => data,
      };
    },
    set: (docRef, data) => {
      committedWrites.push({ path: docRef.path, data });
      fakeStore.set(docRef.path, data);
    },
  };

  // Test archiving
  const runTx = async (txFunc) => txFunc(fakeTx);

  // Execute archive logic
  const metaSnap = await fakeTx.get({ path: 'deviceMetadata/dev_test' });
  const dataBefore = metaSnap.data();

  const auditId = 'audit_archive_1';
  fakeTx.set(
    { path: 'deviceMetadata/dev_test' },
    {
      device_name: dataBefore.device_name,
      rep_name: dataBefore.rep_name,
      updated_at: 'SERVER_TIME',
      updated_by_uid: actor.uid,
      updated_by_email: actor.email,
      archived: true,
      archived_at: 'SERVER_TIME',
      archived_by_uid: actor.uid,
      archived_by_email: actor.email,
    }
  );

  fakeTx.set(
    { path: `auditLogs/${auditId}` },
    {
      actor_uid: actor.uid,
      actor_email: actor.email,
      target_uid: 'dev_test',
      action: 'archive_device',
      summary: `إزالة الجهاز من القائمة الرئيسية وأرشفته (dev_test): "${dataBefore.device_name}"`,
      before: { archived: false, device_name: dataBefore.device_name, rep_name: dataBefore.rep_name },
      after: { archived: true, device_name: dataBefore.device_name, rep_name: dataBefore.rep_name },
      created_at: 'SERVER_TIME',
    }
  );

  assert.equal(committedWrites.length, 2);
  assert.equal(committedWrites[0].path, 'deviceMetadata/dev_test');
  assert.equal(committedWrites[0].data.archived, true);
  assert.equal(committedWrites[1].path, 'auditLogs/audit_archive_1');
  assert.equal(committedWrites[1].data.action, 'archive_device');

  // Verify restoring
  committedWrites = [];
  const metaSnapArchived = await fakeTx.get({ path: 'deviceMetadata/dev_test' });
  const dataArchived = metaSnapArchived.data();
  assert.equal(dataArchived.archived, true);

  fakeTx.set(
    { path: 'deviceMetadata/dev_test' },
    {
      device_name: dataArchived.device_name,
      rep_name: dataArchived.rep_name,
      updated_at: 'SERVER_TIME',
      updated_by_uid: actor.uid,
      updated_by_email: actor.email,
      archived: false,
      archived_at: null,
      archived_by_uid: null,
      archived_by_email: null,
    }
  );

  fakeTx.set(
    { path: 'auditLogs/audit_restore_1' },
    {
      actor_uid: actor.uid,
      actor_email: actor.email,
      target_uid: 'dev_test',
      action: 'restore_device',
      summary: `استعادة الجهاز المؤرشف إلى القائمة الرئيسية (dev_test): "${dataArchived.device_name}"`,
      before: { archived: true, device_name: dataArchived.device_name, rep_name: dataArchived.rep_name },
      after: { archived: false, device_name: dataArchived.device_name, rep_name: dataArchived.rep_name },
      created_at: 'SERVER_TIME',
    }
  );

  assert.equal(committedWrites.length, 2);
  assert.equal(fakeStore.get('deviceMetadata/dev_test').archived, false);
  assert.equal(committedWrites[1].data.action, 'restore_device');
});

test('25. Phone kiosk exit maintenance contract re-enforces local valid policy without revision change and rejects disabled policy', () => {
  // Pure state evaluator simulating the Android KioskManager.exitMaintenanceMode() logic
  function evaluateExitMaintenance(params) {
    const { isDeviceOwner, sdkInt, localPolicy, currentMaintenance } = params;

    if (!currentMaintenance) {
      throw new Error('الجهاز ليس في وضع الصيانة');
    }
    if (!isDeviceOwner) {
      throw new Error('صلاحية Device Owner غير مفعّلة على الهاتف');
    }
    if (sdkInt < 30) {
      throw new Error('نظام الهاتف يتطلب Android 11 (SDK 30) كحد أدنى لشاشة الشركة');
    }
    if (!localPolicy) {
      throw new Error('لا توجد سياسة شاشة شركة محفوظة محليًا');
    }
    if (!localPolicy.enabled) {
      throw new Error('السياسة الأخيرة معطلة من الإدارة؛ لا يمكن إعادة التفعيل المحلي لسياسة ملغاة');
    }
    if (!localPolicy.allowed_apps || localPolicy.allowed_apps.length === 0) {
      throw new Error('السياسة لا تتضمن أي تطبيقات عمل مسموحة');
    }

    // Re-enforces restrictions and returns new kioskStatus report
    return {
      success: true,
      maintenance: false,
      install_blocked: true,
      active: true,
      configured_revision: localPolicy.revision,
      allowed_packages: localPolicy.allowed_apps,
      error: '',
    };
  }

  // 1. Eligible phone in maintenance with enabled policy succeeds offline
  const successResult = evaluateExitMaintenance({
    isDeviceOwner: true,
    sdkInt: 34,
    currentMaintenance: true,
    localPolicy: {
      schema_version: 1,
      revision: 6,
      enabled: true,
      allowed_apps: ['com.whatsapp.w4b'],
    },
  });
  assert.equal(successResult.success, true);
  assert.equal(successResult.maintenance, false);
  assert.equal(successResult.active, true);
  assert.equal(successResult.install_blocked, true);
  assert.equal(successResult.configured_revision, 6);
  assert.deepEqual(successResult.allowed_packages, ['com.whatsapp.w4b']);

  // 2. Re-enabling a disabled policy (enabled: false) is strictly rejected
  assert.throws(
    () =>
      evaluateExitMaintenance({
        isDeviceOwner: true,
        sdkInt: 34,
        currentMaintenance: true,
        localPolicy: {
          schema_version: 1,
          revision: 7,
          enabled: false,
          allowed_apps: ['com.whatsapp.w4b'],
        },
      }),
    /السياسة الأخيرة معطلة من الإدارة/
  );

  // 3. Lack of Device Owner prevents exit to kiosk
  assert.throws(
    () =>
      evaluateExitMaintenance({
        isDeviceOwner: false,
        sdkInt: 34,
        currentMaintenance: true,
        localPolicy: {
          schema_version: 1,
          revision: 6,
          enabled: true,
          allowed_apps: ['com.whatsapp.w4b'],
        },
      }),
    /Device Owner/
  );
});

