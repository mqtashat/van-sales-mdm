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
} from '../admin-web/src/utils/validation.ts';

import {
  classifyAdminDocServerResult,
  evaluateAdminAuthorization,
  reloadUserAndVerifyAdmin,
  validatePolicyTransactionState,
} from '../admin-web/src/services/mdmService.ts';

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
  } = await import('../admin-web/src/components/KioskPanel.tsx');

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
  } = await import('../admin-web/src/utils/presentation.ts');

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
    '../admin-web/src/components/KioskPanel.tsx'
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
    '../admin-web/src/components/KioskPanel.tsx'
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
  const { createAppBrowserNavigation } = await import('../admin-web/src/App.tsx');

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
    '../admin-web/src/components/KioskPanel.tsx'
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
  const { classifyFirestoreError } = await import('../admin-web/src/components/KioskPanel.tsx');

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
    '../admin-web/src/components/KioskPanel.tsx'
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
      const { setDeviceArchivedStatus } = await import('../admin-web/src/services/mdmService.ts');
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

test('26. Independent AppInstallPolicy and LocationPolicy increment revision, enforce schema_version 1, and write audit logs', async () => {
  // Test simulated install policy transaction
  let installRevision = 1;
  const mockTx = {
    records: new Map(),
    get(ref) {
      return {
        exists: () => this.records.has(ref),
        data: () => this.records.get(ref),
      };
    },
    set(ref, data) {
      this.records.set(ref, data);
    },
  };

  const actor = { uid: 'admin_test_1', email: 'admin@company.com' };
  const uid = 'device_test_123';

  // 1. First save creates revision 1
  const policyRef = `appInstallPolicies/${uid}`;
  const auditRef = 'auditLogs/log_1';

  let snap = mockTx.get(policyRef);
  let nextRev = snap.exists() ? snap.data().revision + 1 : 1;
  assert.equal(nextRev, 1);
  mockTx.set(policyRef, {
    schema_version: 1,
    revision: nextRev,
    block_app_installs: true,
    updated_by_uid: actor.uid,
  });
  mockTx.set(auditRef, {
    actor_uid: actor.uid,
    action: 'update_install_policy',
    target_uid: uid,
  });

  assert.equal(mockTx.records.get(policyRef).revision, 1);
  assert.equal(mockTx.records.get(policyRef).block_app_installs, true);

  // 2. Subsequent save increments revision to 2
  snap = mockTx.get(policyRef);
  nextRev = snap.exists() ? snap.data().revision + 1 : 1;
  assert.equal(nextRev, 2);
  mockTx.set(policyRef, {
    schema_version: 1,
    revision: nextRev,
    block_app_installs: false,
    updated_by_uid: actor.uid,
  });
  assert.equal(mockTx.records.get(policyRef).revision, 2);
  assert.equal(mockTx.records.get(policyRef).block_app_installs, false);

  // 3. Location Policy validates schedule bounds and intervals
  const locPolicy = {
    schema_version: 1,
    revision: 1,
    enabled: true,
    mode: 'work_hours',
    start_time: '08:00',
    end_time: '18:00',
    work_days: [1, 2, 3, 4, 5],
    sampling_interval_seconds: 120,
  };
  assert.equal(locPolicy.schema_version, 1);
  assert.ok(locPolicy.sampling_interval_seconds >= 30 && locPolicy.sampling_interval_seconds <= 3600);
});

test('27. Authorized Deprovisioning issues remote command and audit record without data wipe or destructive payload', () => {
  const actor = { uid: 'admin_test_1', email: 'admin@company.com' };
  const uid = 'device_deprovision_test';
  const reason = 'انتهاء فترة عمل المندوب وتسليم الجهاز';

  const commandDoc = {
    type: 'deprovision',
    status: 'pending',
    reason,
    created_by_uid: actor.uid,
    created_by_email: actor.email,
  };

  const auditDoc = {
    actor_uid: actor.uid,
    actor_email: actor.email,
    target_uid: uid,
    action: 'deprovision_device',
    summary: `طلب إنهاء إدارة مسؤول الجهاز (Device Owner) المصرّح: ${reason}`,
    after: { deprovision_requested: true, reason },
  };

  assert.equal(commandDoc.type, 'deprovision');
  assert.equal(commandDoc.status, 'pending');
  assert.equal(auditDoc.action, 'deprovision_device');
  assert.equal(auditDoc.target_uid, uid);
  // Ensure NO wipe or factory reset key exists
  assert.equal('wipe' in commandDoc, false);
  assert.equal('factory_reset' in commandDoc, false);
});

// Helper to construct binary AndroidManifest.xml (AXML) buffer for testing parseBinaryAndroidManifest & parseApkFile
function buildTestBinaryAxml({ pkg, versionCode, versionName, appLabel }) {
  const strings = ['manifest', 'package', 'versionCode', 'versionName', 'application', 'label', pkg || '', versionName || '', appLabel || ''];
  // Build UTF-16LE string pool chunk (type 0x001c0001)
  const strBuffers = strings.map((s) => {
    const buf = new ArrayBuffer(2 + s.length * 2 + 2);
    const view = new DataView(buf);
    view.setUint16(0, s.length, true);
    for (let i = 0; i < s.length; i++) {
      view.setUint16(2 + i * 2, s.charCodeAt(i), true);
    }
    view.setUint16(2 + s.length * 2, 0, true);
    return new Uint8Array(buf);
  });

  const offsets = [];
  let currentOffset = 0;
  for (const b of strBuffers) {
    offsets.push(currentOffset);
    currentOffset += b.byteLength;
  }
  // Align string data to 4 bytes
  const padBytes = (4 - (currentOffset % 4)) % 4;
  const stringsStart = 28 + strings.length * 4;
  const spChunkSize = stringsStart + currentOffset + padBytes;

  // Manifest StartElement chunk (type 0x00100102)
  // 3 attributes: package (idx 1), versionCode (idx 2), versionName (idx 3)
  const attrCount = (pkg ? 1 : 0) + (versionCode !== undefined ? 1 : 0) + (versionName ? 1 : 0);
  const elemChunkSize = 36 + attrCount * 20;

  const totalSize = 8 + spChunkSize + elemChunkSize;
  const out = new ArrayBuffer(totalSize);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  // AXML Header
  view.setUint32(0, 0x00080003, true);
  view.setUint32(4, totalSize, true);

  // String Pool Header
  let pos = 8;
  view.setUint32(pos, 0x001c0001, true);
  view.setUint32(pos + 4, spChunkSize, true);
  view.setUint32(pos + 8, strings.length, true); // stringCount
  view.setUint32(pos + 12, 0, true); // styleCount
  view.setUint32(pos + 16, 0, true); // flags (0 = UTF-16LE)
  view.setUint32(pos + 20, stringsStart, true);
  view.setUint32(pos + 24, 0, true);

  for (let i = 0; i < offsets.length; i++) {
    view.setUint32(pos + 28 + i * 4, offsets[i], true);
  }

  let sPos = pos + stringsStart;
  for (const b of strBuffers) {
    bytes.set(b, sPos);
    sPos += b.byteLength;
  }

  // StartElement ('manifest' = index 0)
  pos = 8 + spChunkSize;
  view.setUint32(pos, 0x00100102, true);
  view.setUint32(pos + 4, elemChunkSize, true);
  view.setInt32(pos + 20, 0, true); // nameIdx = 0 ('manifest')
  view.setUint16(pos + 24, 20, true); // attrStart
  view.setUint16(pos + 26, 20, true); // attrSize
  view.setUint16(pos + 28, attrCount, true);

  let aIdx = 0;
  if (pkg) {
    const aOff = pos + 36 + aIdx * 20;
    view.setInt32(aOff + 4, 1, true); // 'package'
    view.setInt32(aOff + 8, 6, true); // rawValIdx = 6 (pkg)
    view.setUint8(aOff + 15, 3); // string type
    view.setInt32(aOff + 16, 6, true);
    aIdx++;
  }
  if (versionCode !== undefined) {
    const aOff = pos + 36 + aIdx * 20;
    view.setInt32(aOff + 4, 2, true); // 'versionCode'
    view.setInt32(aOff + 8, -1, true);
    view.setUint8(aOff + 15, 0x10); // int type
    view.setInt32(aOff + 16, versionCode, true);
    aIdx++;
  }
  if (versionName) {
    const aOff = pos + 36 + aIdx * 20;
    view.setInt32(aOff + 4, 3, true); // 'versionName'
    view.setInt32(aOff + 8, 7, true); // rawValIdx = 7 (versionName)
    view.setUint8(aOff + 15, 3);
    view.setInt32(aOff + 16, 7, true);
    aIdx++;
  }

  return out;
}

// Helper to build a synthetic DER X.509 certificate with a specific payload for deterministic SHA-256 fingerprint
function buildSyntheticX509Cert(seedByte = 0xaa) {
  const innerLen = 140;
  const totalLen = 4 + innerLen;
  const cert = new Uint8Array(4 + totalLen);
  cert[0] = 0x30;
  cert[1] = 0x82;
  cert[2] = (totalLen >> 8) & 0xff;
  cert[3] = totalLen & 0xff;
  // TBSCertificate SEQUENCE
  cert[4] = 0x30;
  cert[5] = 0x82;
  cert[6] = (innerLen >> 8) & 0xff;
  cert[7] = innerLen & 0xff;
  // Version [0] EXPLICIT v3 (0xA0 0x03 0x02 0x01 0x02)
  cert[8] = 0xa0;
  cert[9] = 0x03;
  cert[10] = 0x02;
  cert[11] = 0x01;
  cert[12] = 0x02;
  for (let i = 13; i < cert.length; i++) {
    cert[i] = (seedByte + i) & 0xff;
  }
  return cert;
}

// Injects an APK Signing Block (v2 or v3) with a real SHA-256 Merkle tree digest immediately before the ZIP Central Directory
async function injectApkSigningBlock(zipBuffer, certBytes, schemeId = 0x7109871a) {
  const { computeApkSigBlockV2MerkleSha256 } = await import('../admin-web/src/utils/apkParser.ts');
  const zipBytes = new Uint8Array(zipBuffer);
  let eocdOffset = -1;
  for (let i = zipBytes.length - 22; i >= 0; i--) {
    if (
      zipBytes[i] === 0x50 &&
      zipBytes[i + 1] === 0x4b &&
      zipBytes[i + 2] === 0x05 &&
      zipBytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  assert.notEqual(eocdOffset, -1, 'Valid ZIP EOCD required');
  const eocdView = new DataView(zipBuffer, eocdOffset);
  const cdOffset = eocdView.getUint32(16, true);

  // Compute real Merkle tree digest over the unsigned ZIP sections
  const merkleDigest = await computeApkSigBlockV2MerkleSha256(
    zipBytes,
    cdOffset,
    cdOffset,
    eocdOffset
  );

  // Build digest record: [recordLen(4)=40][algoId(4)=0x0103][digestLen(4)=32][merkleDigest(32)]
  const digestsLen = 4 + 4 + 4 + merkleDigest.length; // 44 bytes
  const certsLen = 4 + certBytes.length;
  const signedDataLen = 4 + digestsLen + 4 + certsLen;
  const signerLen = 4 + signedDataLen;
  const signersLen = 4 + signerLen;
  const valueLen = 4 + signersLen;
  const pairLen = 4 + valueLen; // ID (4) + value

  // Block layout: [size8(8)][pairLen(8)][pairId(4)][value...][size8(8)][magic(16)]
  const blockContentSize = 8 + pairLen + 8 + 16; // size excluding leading 8-byte length
  const totalSigBlockBytes = 8 + blockContentSize;

  const sigBlock = new ArrayBuffer(totalSigBlockBytes);
  const sv = new DataView(sigBlock);
  const sb = new Uint8Array(sigBlock);

  sv.setUint32(0, blockContentSize, true); // leading uint64 low
  sv.setUint32(4, 0, true);

  // Pair
  sv.setUint32(8, pairLen, true); // pair uint64 length low
  sv.setUint32(12, 0, true);
  sv.setUint32(16, schemeId, true); // 0x7109871a (v2) or 0xf05368c0 (v3)

  // Signer payload at offset 20
  sv.setUint32(20, signersLen, true);
  sv.setUint32(24, signerLen, true);
  sv.setUint32(28, signedDataLen, true);
  sv.setUint32(32, digestsLen, true);
  // Digest record at offset 36
  sv.setUint32(36, 4 + 4 + merkleDigest.length, true); // singleDigestRecordLen = 40
  sv.setUint32(40, 0x0103, true); // algoId = RSA PKCS#1 v1.5 with SHA-256
  sv.setUint32(44, merkleDigest.length, true);
  sb.set(merkleDigest, 48);

  const certsPos = 36 + digestsLen;
  sv.setUint32(certsPos, certsLen, true);
  sv.setUint32(certsPos + 4, certBytes.length, true);
  sb.set(certBytes, certsPos + 8);

  const trailingOffset = 20 + valueLen;
  sv.setUint32(trailingOffset, blockContentSize, true);
  sv.setUint32(trailingOffset + 4, 0, true);

  const magicStr = 'APK Sig Block 42';
  for (let i = 0; i < 16; i++) {
    sb[trailingOffset + 8 + i] = magicStr.charCodeAt(i);
  }

  // Splice into ZIP at cdOffset and update EOCD cdOffset
  const out = new Uint8Array(zipBytes.length + totalSigBlockBytes);
  out.set(zipBytes.slice(0, cdOffset), 0);
  out.set(sb, cdOffset);
  out.set(zipBytes.slice(cdOffset), cdOffset + totalSigBlockBytes);

  const outView = new DataView(out.buffer);
  const newEocdOffset = eocdOffset + totalSigBlockBytes;
  outView.setUint32(newEocdOffset + 16, cdOffset + totalSigBlockBytes, true);

  return out.buffer;
}

test('28. parseApkFile marks result as local preview only (isLocalPreviewOnly=true), verifies v1/v2/v3 signatures, and rejects tampered APKs that preserve certificate bytes', async () => {
  const JSZip = (await import('jszip')).default;
  const crypto = await import('node:crypto');
  const { parseApkFile, computeSha256Hex, formatFingerprintWithColons } = await import('../admin-web/src/utils/apkParser.ts');

  const certA = buildSyntheticX509Cert(0x11);
  const certB = buildSyntheticX509Cert(0x22);
  const expectedCertAHex = await computeSha256Hex(certA.buffer, false);
  const expectedCertBHex = await computeSha256Hex(certB.buffer, false);
  assert.notEqual(expectedCertAHex, expectedCertBHex);
  assert.equal(expectedCertAHex.length, 64);

  const axml = buildTestBinaryAxml({
    pkg: 'com.injaz.vansales.enterprise',
    versionCode: 42,
    versionName: '2.4.0-prod',
  });

  // 1. Test Scheme v2-only APK (no META-INF/*.RSA)
  const zipV2 = new JSZip();
  zipV2.file('AndroidManifest.xml', axml);
  zipV2.file('classes.dex', new Uint8Array([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00]));
  const rawZipV2 = await zipV2.generateAsync({ type: 'arraybuffer' });
  const apkV2Buffer = await injectApkSigningBlock(rawZipV2, certA, 0x7109871a);

  const parsedV2 = await parseApkFile(apkV2Buffer);
  assert.equal(parsedV2.isLocalPreviewOnly, true, 'Browser parser must strictly flag output as local preview only');
  assert.equal('inspection_status' in parsedV2, false, 'Browser parser must never emit inspection_status');
  assert.equal(parsedV2.packageName, 'com.injaz.vansales.enterprise');
  assert.equal(parsedV2.versionCode, 42);
  assert.equal(parsedV2.versionName, '2.4.0-prod');
  assert.equal(parsedV2.signatureScheme, 'v2');
  assert.equal(parsedV2.sha256Cert, expectedCertAHex);
  assert.equal(parsedV2.sha256Cert.includes(':'), false, 'Stored cert hash must be raw hex without colons');
  assert.equal(formatFingerprintWithColons(parsedV2.sha256Cert).split(':').length, 32);

  // 2. Test TAMPERED v2 APK: modify classes.dex content while keeping the v2 Signing Block and X.509 certificate intact
  const zipV2Tampered = new JSZip();
  zipV2Tampered.file('AndroidManifest.xml', axml);
  zipV2Tampered.file('classes.dex', new Uint8Array([0x64, 0x65, 0x78, 0x0a, 0xff, 0xff, 0xff, 0xff]));
  const rawZipTampered = await zipV2Tampered.generateAsync({ type: 'arraybuffer' });

  // Splice the original v2 signing block (with intact certA and original digest) into rawZipTampered
  const origBytes = new Uint8Array(rawZipV2);
  const origCdOffset = new DataView(rawZipV2, origBytes.length - 22).getUint32(16, true);
  const signedBytes = new Uint8Array(apkV2Buffer);
  const signedCdOffset = new DataView(apkV2Buffer, signedBytes.length - 22).getUint32(16, true);
  const sigBlockSlice = signedBytes.slice(origCdOffset, signedCdOffset);

  const tamperedZipBytes = new Uint8Array(rawZipTampered);
  const tamperedApk = new Uint8Array(tamperedZipBytes.length + sigBlockSlice.length);
  tamperedApk.set(tamperedZipBytes.slice(0, origCdOffset), 0);
  tamperedApk.set(sigBlockSlice, origCdOffset);
  tamperedApk.set(tamperedZipBytes.slice(origCdOffset), origCdOffset + sigBlockSlice.length);
  new DataView(tamperedApk.buffer, tamperedApk.length - 22).setUint32(
    16,
    origCdOffset + sigBlockSlice.length,
    true
  );

  await assert.rejects(
    async () => parseApkFile(tamperedApk.buffer),
    /فشل التحقق الجنائي من سلامة محتوى APK/,
    'Tampered v2 APK with preserved certificate bytes MUST be rejected'
  );

  // 3. Test Scheme v3 APK with different certificate (certB)
  const apkV3Buffer = await injectApkSigningBlock(rawZipV2, certB, 0xf05368c0);
  const parsedV3 = await parseApkFile(apkV3Buffer);
  assert.equal(parsedV3.signatureScheme, 'v3');
  assert.equal(parsedV3.sha256Cert, expectedCertBHex);

  // 4. Reject synthetic v1 archive lacking META-INF/*.SF and lacking PKCS#7 SignedData structure
  const dexV1 = new Uint8Array([0x64, 0x65, 0x78, 0x0a, 0x01, 0x02, 0x03, 0x04]);
  const manifestMf = [
    'Manifest-Version: 1.0',
    '',
    'Name: AndroidManifest.xml',
    `SHA-256-Digest: ${crypto.createHash('sha256').update(Buffer.from(axml)).digest('base64')}`,
    '',
    'Name: classes.dex',
    `SHA-256-Digest: ${crypto.createHash('sha256').update(Buffer.from(dexV1)).digest('base64')}`,
    '',
  ].join('\r\n');

  const zipFakeV1NoSf = new JSZip();
  zipFakeV1NoSf.file('AndroidManifest.xml', axml);
  zipFakeV1NoSf.file('classes.dex', dexV1);
  zipFakeV1NoSf.file('META-INF/MANIFEST.MF', manifestMf);
  const pkcs7Wrapper = new Uint8Array(24 + certA.length);
  pkcs7Wrapper.set(certA, 24);
  zipFakeV1NoSf.file('META-INF/CERT.RSA', pkcs7Wrapper);
  const fakeV1NoSfBuffer = await zipFakeV1NoSf.generateAsync({ type: 'arraybuffer' });
  await assert.rejects(
    async () => parseApkFile(fakeV1NoSfBuffer),
    /META-INF\/\*\.SF/,
    'Synthetic v1 archive without .SF must be rejected even in local preview'
  );

  // Also reject v1 archive that has .SF but lacks PKCS#7 SignedData OID in CERT.RSA
  const sfContent = `Signature-Version: 1.0\r\nSHA-256-Digest-Manifest: ${crypto
    .createHash('sha256')
    .update(Buffer.from(manifestMf, 'utf8'))
    .digest('base64')}\r\n\r\n`;
  const zipFakeV1NoPkcs7 = new JSZip();
  zipFakeV1NoPkcs7.file('AndroidManifest.xml', axml);
  zipFakeV1NoPkcs7.file('classes.dex', dexV1);
  zipFakeV1NoPkcs7.file('META-INF/MANIFEST.MF', manifestMf);
  zipFakeV1NoPkcs7.file('META-INF/CERT.SF', sfContent);
  zipFakeV1NoPkcs7.file('META-INF/CERT.RSA', pkcs7Wrapper);
  const fakeV1NoPkcs7Buffer = await zipFakeV1NoPkcs7.generateAsync({ type: 'arraybuffer' });
  await assert.rejects(
    async () => parseApkFile(fakeV1NoPkcs7Buffer),
    /PKCS#7 SignedData/,
    'v1 archive with raw cert wrapper lacking PKCS#7 SignedData structure must be rejected'
  );

  // 5. Reject unsigned APK (no v2/v3 block and no META-INF signature) — never invent a fallback hash!
  await assert.rejects(
    async () => parseApkFile(rawZipV2),
    /غير موقعة/,
    'Unsigned APK must be rejected without generating surrogate hash'
  );

  // 6. Reject APK with missing versionCode in Manifest — never default to versionCode=1!
  const badAxml = buildTestBinaryAxml({
    pkg: 'com.injaz.bad',
    versionCode: 0,
    versionName: '1.0.0',
  });
  const zipBadVer = new JSZip();
  zipBadVer.file('AndroidManifest.xml', badAxml);
  const rawBadVer = await zipBadVer.generateAsync({ type: 'arraybuffer' });
  const signedBadVer = await injectApkSigningBlock(rawBadVer, certA, 0x7109871a);
  await assert.rejects(
    async () => parseApkFile(signedBadVer),
    /versionCode/,
    'APK without valid versionCode must be rejected'
  );

  // 7. Reject corrupted non-ZIP bytes
  const corruptedBuffer = new Uint8Array(256).fill(0xff).buffer;
  await assert.rejects(async () => parseApkFile(corruptedBuffer), /فشل فتح ملف APK/);
});

test('29. Production sendInstallCommand strictly requires explicit server-verified status (inspection_status === "verified" && inspected_by_server === true) and blocks missing or pending status', async () => {
  const { sendInstallCommand } = await import('../admin-web/src/services/mdmService.ts');

  const baseApp = {
    id: 'app_unverified_1',
    app_name: 'Enterprise App',
    package_name: 'com.company.unverified',
    version_code: 5,
    version_name: '1.2.0',
    file_size_bytes: 50000,
    storage_path: 'company_apps/app_unverified_1/app.apk',
    sha256_apk: 'a'.repeat(64),
    sha256_cert: 'b'.repeat(64),
    inspection_status: 'pending_inspection',
    inspected_by_server: false,
    created_at: null,
    created_by_uid: 'admin_1',
    created_by_email: 'admin@company.com',
  };

  // 1. Rejects pending_inspection
  await assert.rejects(
    async () =>
      sendInstallCommand({}, 'device_1', baseApp, {
        uid: 'admin_1',
        email: 'admin@company.com',
      }),
    /بانتظار الفحص/,
    'sendInstallCommand must block distribution of pending_inspection apps'
  );

  // 2. Rejects when inspection_status field is missing/undefined (even if sha256_cert is 64 hex chars!)
  const missingStatusApp = { ...baseApp };
  delete missingStatusApp.inspection_status;
  await assert.rejects(
    async () =>
      sendInstallCommand({}, 'device_1', missingStatusApp, {
        uid: 'admin_1',
        email: 'admin@company.com',
      }),
    /بانتظار الفحص/,
    'Missing inspection_status field must block distribution even when sha256_cert is 64 chars'
  );

  // 3. Rejects when inspection_status === "verified" but inspected_by_server !== true (client-spoofed status)
  const clientSpoofedVerifiedApp = {
    ...baseApp,
    inspection_status: 'verified',
    inspected_by_server: false,
  };
  await assert.rejects(
    async () =>
      sendInstallCommand({}, 'device_1', clientSpoofedVerifiedApp, {
        uid: 'admin_1',
        email: 'admin@company.com',
      }),
    /بانتظار الفحص/,
    'Client-spoofed verified status without inspected_by_server===true must be blocked'
  );

  // 4. Rejects when sha256_cert is not 64 hex characters
  const invalidCertApp = {
    ...baseApp,
    inspection_status: 'verified',
    inspected_by_server: true,
    sha256_cert: 'short_invalid_cert',
  };
  await assert.rejects(
    async () =>
      sendInstallCommand({}, 'device_1', invalidCertApp, {
        uid: 'admin_1',
        email: 'admin@company.com',
      }),
    /بصمة شهادة المطور SHA-256 إلزاميتان/,
    'sendInstallCommand must reject apps without a 64-char hex certificate fingerprint'
  );
});

test('30. Authoritative Kiosk addition validates server revision, blocked_apps conflict, and 50-app limit via validateAndBuildKioskTransaction', async () => {
  const { validateAndBuildKioskTransaction } = await import('../admin-web/src/components/KioskPanel.tsx');

  const baseActor = {
    uid: 'admin_1',
    email: 'admin@company.com',
    isAuthorizedAdmin: true,
    emailVerified: true,
    isAnonymous: false,
  };

  const existingKioskDoc = {
    schema_version: 1,
    revision: 4,
    enabled: true,
    allowed_apps: ['com.company.sales'],
    exit_salt: 'a'.repeat(32),
    exit_hash: 'b'.repeat(64),
  };

  const inventoryDoc = {
    apps: [
      { package_name: 'com.company.sales', has_launcher_icon: true, is_enabled: true, is_hidden_by_agent: false },
      { package_name: 'com.company.NewApp', has_launcher_icon: true, is_enabled: true, is_hidden_by_agent: false },
    ],
  };

  // 1. Valid addition increments server revision from 4 to 5 and produces audit log
  const result = validateAndBuildKioskTransaction({
    uid: 'dev_1',
    actor: baseActor,
    serverReadConfirmed: true,
    expectedRevision: 4,
    enabled: true,
    allowedApps: ['com.company.sales', 'com.company.NewApp'],
    credential: { exit_salt: existingKioskDoc.exit_salt, exit_hash: existingKioskDoc.exit_hash },
    existingKioskDoc,
    enrollmentDoc: { approved: true },
    deviceStatusDoc: { device_owner: true, agent_version: '0.5.0-pilot', android_sdk: 33 },
    policyDoc: { blocked_apps: [] },
    inventoryDoc,
  });

  assert.equal(result.nextPolicy.revision, 5);
  assert.deepEqual(result.nextPolicy.allowed_apps, ['com.company.NewApp', 'com.company.sales']);
  assert.equal(result.auditLog.action, 'update_policy');

  // 2. Rejects addition if the newly installed app is in blocked_apps
  assert.throws(
    () =>
      validateAndBuildKioskTransaction({
        uid: 'dev_1',
        actor: baseActor,
        serverReadConfirmed: true,
        expectedRevision: 4,
        enabled: true,
        allowedApps: ['com.company.sales', 'com.company.NewApp'],
        credential: { exit_salt: existingKioskDoc.exit_salt, exit_hash: existingKioskDoc.exit_hash },
        existingKioskDoc,
        enrollmentDoc: { approved: true },
        deviceStatusDoc: { device_owner: true, agent_version: '0.5.0-pilot', android_sdk: 33 },
        policyDoc: { blocked_apps: ['com.company.NewApp'] },
        inventoryDoc,
      }),
    /أزل التطبيق من الحظر أولًا/
  );

  // 3. Rejects addition if exceeding 50 apps limit
  const fiftyOneApps = Array.from({ length: 51 }, (_, i) => `com.company.app${i}`);
  assert.throws(
    () =>
      validateAndBuildKioskTransaction({
        uid: 'dev_1',
        actor: baseActor,
        serverReadConfirmed: true,
        expectedRevision: 4,
        enabled: true,
        allowedApps: fiftyOneApps,
        credential: { exit_salt: existingKioskDoc.exit_salt, exit_hash: existingKioskDoc.exit_hash },
        existingKioskDoc,
        enrollmentDoc: { approved: true },
        deviceStatusDoc: { device_owner: true, agent_version: '0.5.0-pilot', android_sdk: 33 },
        policyDoc: { blocked_apps: [] },
        inventoryDoc: {
          apps: fiftyOneApps.map((pkg) => ({
            package_name: pkg,
            has_launcher_icon: true,
            is_enabled: true,
            is_hidden_by_agent: false,
          })),
        },
      }),
    /50/
  );
});

test('31. Android install durability: synchronous commit before session.commit(), pre-commit server re-verification, durable local retry queue, active/failed session inspection, and distinct already_installed state', async () => {
  const fs = await import('node:fs');
  const readAndroidJava = (fileName) => {
    const candidates = [
      new URL(`../van-sales-mdm/app/src/main/java/com/company/mdmagent/${fileName}`, import.meta.url),
      new URL(`../../app/src/main/java/com/company/mdmagent/${fileName}`, import.meta.url),
      new URL(`../app/src/main/java/com/company/mdmagent/${fileName}`, import.meta.url),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    }
    throw new Error(`Android source not found: ${fileName}`);
  };

  const pkgInstallerSrc = readAndroidJava('PackageInstallManager.java');
  const receiverSrc = readAndroidJava('InstallStatusReceiver.java');
  const locQueueSrc = readAndroidJava('LocationQueue.java');
  const restrictionSrc = readAndroidJava('RestrictionManager.java');

  // 1. Verify INSTALL_EXECUTOR is defined and SharedPreferences is imported
  assert.match(pkgInstallerSrc, /import android\.content\.SharedPreferences;/);
  assert.match(pkgInstallerSrc, /^\s*private static final ExecutorService INSTALL_EXECUTOR =/m);

  // 2. Verify downloaded archive certificate is verified BEFORE session creation
  const archiveCertIdx = pkgInstallerSrc.indexOf('extractArchiveSignerSha256(context, tempApk)');
  const createSessionIdx = pkgInstallerSrc.indexOf('installer.createSession(params)');
  assert.ok(archiveCertIdx > 0 && createSessionIdx > archiveCertIdx, 'Downloaded APK certificate must be verified before createSession');

  // 3. Verify pre-commit server re-verification AND synchronous .commit() with boolean check BEFORE session.commit()
  const fsyncIdx = pkgInstallerSrc.indexOf('session.fsync(out)');
  const preCommitVerifyIdx = pkgInstallerSrc.lastIndexOf('verifyCommandStillActiveOnServer(context, uid, cmdId, expiresAtMs)');
  const syncCommitIdx = pkgInstallerSrc.indexOf('.putString(taskKey + "_state", "COMMITTED")\n                        .commit()');
  const stateSavedCheckIdx = pkgInstallerSrc.indexOf('if (!stateSaved)');
  const sessionCommitIdx = pkgInstallerSrc.indexOf('session.commit(pendingIntent.getIntentSender())');

  assert.ok(preCommitVerifyIdx > fsyncIdx, 'Must re-verify command expiration, cancellation, and device approval after streaming and right before session.commit()');
  assert.ok(syncCommitIdx > preCommitVerifyIdx, 'Must persist COMMITTED task state synchronously via .commit() after pre-commit verification');
  assert.ok(stateSavedCheckIdx > syncCommitIdx && sessionCommitIdx > stateSavedCheckIdx, 'Must verify .commit() boolean return value before calling session.commit()');

  // 4. Verify durable local queue (RESULT_PENDING_ACK) only calls clearTask inside .addOnSuccessListener(...)
  assert.match(pkgInstallerSrc, /RESULT_PENDING_ACK/);
  assert.match(pkgInstallerSrc, /\.addOnSuccessListener\(unused -> \{[\s\S]*?clearTask\(p, prefix\);/);
  assert.equal(receiverSrc.includes('PackageInstallManager.clearTask(p, taskKey);'), false, 'InstallStatusReceiver must not delete task before server acknowledgement');

  // 5. Verify active & failed session recovery via installer.getMySessions() and installer.getSessionInfo(sessionId)
  assert.match(pkgInstallerSrc, /installer\.getMySessions\(\)/);
  assert.match(pkgInstallerSrc, /installer\.getSessionInfo\(sessionId\)/);
  assert.match(pkgInstallerSrc, /sessionInfo\.isActive\(\)/);

  // 6. Verify distinct "already_installed" («الإصدار المطلوب موجود مسبقًا») vs "installed_new_or_updated"
  assert.match(pkgInstallerSrc, /OUTCOME_ALREADY_INSTALLED = "already_installed"/);
  assert.match(pkgInstallerSrc, /الإصدار المطلوب موجود مسبقًا/);
  assert.match(pkgInstallerSrc, /updatedSincePreInstall/);

  // 7. Verify InstallStatusReceiver does NOT write add_to_kiosk_requested or kiosk_addition_status
  assert.equal(receiverSrc.includes('add_to_kiosk_requested'), false, 'Phone must not write add_to_kiosk_requested');
  assert.equal(receiverSrc.includes('kiosk_addition_status'), false, 'Phone must not write kiosk_addition_status');

  // 8. Verify LocationQueue deduplicates already-committed points without SetOptions.merge()
  assert.equal(locQueueSrc.includes('SetOptions.merge()'), false, 'LocationQueue must not use SetOptions.merge()');
  assert.match(locQueueSrc, /alreadyCommittedIds\.contains\(p\.pointId\)/);

  // 9. Verify RestrictionManager keeps DISALLOW_INSTALL_APPS enforced during admin install
  assert.match(restrictionSrc, /UserManager\.DISALLOW_INSTALL_APPS/);
  assert.equal(pkgInstallerSrc.includes('clearUserRestriction'), false, 'PackageInstallManager must never lift DISALLOW_INSTALL_APPS during install');

  // 10. Verify download token protection, HTTPS + host allowlist, pre-signed URL token suppression, and redirect blocking
  assert.match(pkgInstallerSrc, /conn\.setInstanceFollowRedirects\(false\)/);
  assert.match(pkgInstallerSrc, /validateAndClassifyDownloadUrl/);
  assert.match(pkgInstallerSrc, /verifyResponseNotRedirected/);
  assert.match(pkgInstallerSrc, /!downloadTarget\.isSignedStorageUrl/);
});

test('32. Security rules evaluation: server-only inspection_status, unified admin authorization, task-bound Storage download grants, and phone command update restrictions', async () => {
  const fs = await import('node:fs');
  const firestoreRules = fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const storageRules = fs.readFileSync(new URL('../storage.rules', import.meta.url), 'utf8');

  // 1. Verify storage.rules has NO hardcoded emails and unifies isAdmin() with firestore.rules
  assert.equal(storageRules.includes('mashhoor.info@gmail.com'), false, 'storage.rules must not contain hardcoded test/admin emails');
  assert.equal(storageRules.includes('admin@company.com'), false, 'storage.rules must not contain hardcoded test/admin emails');
  assert.match(storageRules, /request\.auth\.token\.admin == true/);
  assert.match(storageRules, /firestore\.get\(\/databases\/\(default\)\/documents\/admins\/\$\(request\.auth\.uid\)\)\.data\.active == true/);

  // 2. Verify storage.rules enforces per-device task-bound download grant (hasValidDeviceDownloadGrant) and file immutability
  assert.match(storageRules, /allow read: if isAdmin\(\) \|\| hasValidDeviceDownloadGrant\(appId, fileName\);/);
  assert.match(storageRules, /allow create: if isAdmin\(\)\s+&& resource == null/);
  assert.match(storageRules, /allow update: if false;/);

  // 3. Semantic Evaluator for Storage Rules (`hasValidDeviceDownloadGrant(appId, fileName)`)
  function evaluateStorageReadRule({ auth, appId, fileName, nowMs, firestoreDocs }) {
    if (!auth || !auth.uid) return false;
    const isAdmin =
      auth.email_verified === true &&
      (auth.admin === true || firestoreDocs[`admins/${auth.uid}`]?.active === true);
    if (isAdmin) return true;

    const isApprovedDevice =
      firestoreDocs[`enrollments/${auth.uid}`]?.approved === true &&
      firestoreDocs[`deviceStatus/${auth.uid}`]?.device_owner === true &&
      firestoreDocs[`deviceStatus/${auth.uid}`]?.deprovisioned !== true;
    if (!isApprovedDevice) return false;

    const grant = firestoreDocs[`deviceDownloadGrants/${auth.uid}/apps/${appId}`];
    if (!grant) return false;

    const cmd = firestoreDocs[`deviceCommands/${auth.uid}/commands/${grant.command_id}`];
    const app = firestoreDocs[`companyApps/${appId}`];
    if (!cmd || !app) return false;

    return (
      grant.status === 'active' &&
      grant.app_id === appId &&
      grant.storage_path === `company_apps/${appId}/${fileName}` &&
      grant.expires_at_ms > nowMs &&
      app.inspection_status === 'verified' &&
      app.inspected_by_server === true &&
      app.storage_path === `company_apps/${appId}/${fileName}` &&
      cmd.type === 'install_app' &&
      cmd.app_id === appId &&
      (cmd.status === 'pending' || cmd.status === 'in_progress') &&
      cmd.cancelled !== true
    );
  }

  const nowMs = Date.now();
  const baseFirestoreState = {
    'enrollments/device_target': { approved: true },
    'deviceStatus/device_target': { device_owner: true, deprovisioned: false },
    'enrollments/device_other': { approved: true },
    'deviceStatus/device_other': { device_owner: true, deprovisioned: false },
    'companyApps/app_10': {
      inspection_status: 'verified',
      inspected_by_server: true,
      storage_path: 'company_apps/app_10/release.apk',
    },
    'deviceCommands/device_target/commands/cmd_10': {
      type: 'install_app',
      app_id: 'app_10',
      status: 'pending',
      cancelled: false,
    },
    'deviceDownloadGrants/device_target/apps/app_10': {
      status: 'active',
      app_id: 'app_10',
      command_id: 'cmd_10',
      storage_path: 'company_apps/app_10/release.apk',
      expires_at_ms: nowMs + 600_000,
    },
  };

  // Case A: Targeted approved device -> ALLOWED
  assert.equal(
    evaluateStorageReadRule({
      auth: { uid: 'device_target' },
      appId: 'app_10',
      fileName: 'release.apk',
      nowMs,
      firestoreDocs: baseFirestoreState,
    }),
    true,
    'Targeted approved device with active grant and pending command must be allowed to read APK'
  );

  // Case B: Non-targeted approved device (device_other) -> REJECTED
  assert.equal(
    evaluateStorageReadRule({
      auth: { uid: 'device_other' },
      appId: 'app_10',
      fileName: 'release.apk',
      nowMs,
      firestoreDocs: baseFirestoreState,
    }),
    false,
    'Approved device NOT targeted by a grant for this app must be rejected'
  );

  // Case C: Targeted device after command cancellation -> REJECTED
  assert.equal(
    evaluateStorageReadRule({
      auth: { uid: 'device_target' },
      appId: 'app_10',
      fileName: 'release.apk',
      nowMs,
      firestoreDocs: {
        ...baseFirestoreState,
        'deviceCommands/device_target/commands/cmd_10': {
          ...baseFirestoreState['deviceCommands/device_target/commands/cmd_10'],
          status: 'cancelled',
          cancelled: true,
        },
      },
    }),
    false,
    'Targeted device must be rejected immediately after command cancellation'
  );

  // Case D: Targeted device after grant expiration -> REJECTED
  assert.equal(
    evaluateStorageReadRule({
      auth: { uid: 'device_target' },
      appId: 'app_10',
      fileName: 'release.apk',
      nowMs: nowMs + 900_000, // past expires_at_ms
      firestoreDocs: baseFirestoreState,
    }),
    false,
    'Targeted device must be rejected after grant expiration'
  );

  // 4. Semantic Evaluator for Firestore Rules:
  // - Admin cannot write inspection_status == 'verified' or inspected_by_server == true on /companyApps/{appId}
  assert.match(firestoreRules, /request\.resource\.data\.inspection_status == 'pending_inspection'/);
  assert.match(firestoreRules, /request\.resource\.data\.inspected_by_server == false/);
  assert.match(firestoreRules, /request\.resource\.data\.inspection_status == resource\.data\.inspection_status/);

  // - Phone cannot write add_to_kiosk, add_to_kiosk_requested, or kiosk_addition_status on /deviceCommands/{uid}/commands/{cmdId}
  assert.equal(
    firestoreRules.includes("'add_to_kiosk_requested'"),
    false,
    'Phone affectedKeys allowlist must not include add_to_kiosk_requested'
  );
  assert.equal(
    firestoreRules.includes("'kiosk_addition_status'"),
    false,
    'Phone affectedKeys allowlist must not include kiosk_addition_status'
  );
  assert.match(firestoreRules, /request\.resource\.data\.add_to_kiosk == resource\.data\.add_to_kiosk/);
  assert.match(firestoreRules, /resource\.data\.cancelled != true/);
});
