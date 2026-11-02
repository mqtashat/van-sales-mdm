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


test('kiosk requires explicit valid fields and maintenance verifier', async()=>{
 const {validateKiosk,passwordVerifier}=await import('../src/components/KioskPanel.tsx');
 const credential=await passwordVerifier('A-long-test-password!');
 const p={schema_version:1,revision:1,enabled:true,allowed_apps:['com.whatsapp'],...credential};
 assert.equal(validateKiosk(p),true);
 assert.equal(validateKiosk({...p,enabled:'false'}),false);
 assert.equal(validateKiosk({...p,allowed_apps:[]}),false);
 assert.equal(validateKiosk({...p,exit_hash:''}),false);
 assert.equal(validateKiosk({...p,enabled:false,allowed_apps:[]}),true);
 const {pbkdf2Sync}=await import('node:crypto');
 assert.equal(pbkdf2Sync('A-long-test-password!',Buffer.from(credential.exit_salt,'hex'),120000,32,'sha256').toString('hex'),credential.exit_hash);
});
