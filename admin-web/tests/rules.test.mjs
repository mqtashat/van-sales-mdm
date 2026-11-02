import { before, after, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-mdm',
    firestore: {
      rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')
    }
  });
});

after(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'enrollments/a'), { approved: true });
    await setDoc(doc(db, 'enrollments/b'), { approved: true });
    await setDoc(doc(db, 'policies/a'), {
      schema_version: 1,
      revision: 1,
      block_tethering: true,
      blocked_apps: []
    });
    await setDoc(doc(db, 'policies/b'), {
      schema_version: 1,
      revision: 1,
      block_tethering: true,
      blocked_apps: []
    });
    await setDoc(doc(db, 'admins/consoleAdmin'), {
      active: true,
      email: 'mashhoor.info@gmail.com'
    });
  });
});

const status = () => ({
  device_owner: true,
  applied_revision: 1,
  tethering_restricted: true,
  last_seen: serverTimestamp(),
  model: 'TECNO POVA 5',
  android_sdk: 33,
  battery_percent: 70,
  error: '',
  agent_version: '0.1.0-pilot'
});

test('1. approved device reads only its own policy, cannot list or alter policies', async () => {
  const db = env.authenticatedContext('a', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
  await assertSucceeds(getDoc(doc(db, 'policies/a')));
  await assertFails(getDoc(doc(db, 'policies/b')));
  await assertFails(getDocs(collection(db, 'policies')));
  await assertFails(setDoc(doc(db, 'policies/a'), {
    schema_version: 1,
    revision: 2,
    block_tethering: false,
    blocked_apps: []
  }));
});

test('2. anonymous identity is not approval; enrollment cannot be self-approved', async () => {
  const db = env.authenticatedContext('unapproved', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
  await assertSucceeds(getDoc(doc(db, 'enrollments/unapproved')));
  await assertFails(setDoc(doc(db, 'enrollments/unapproved'), { approved: true }));
  await assertFails(getDoc(doc(db, 'policies/unapproved')));
  await assertFails(setDoc(doc(db, 'deviceStatus/unapproved'), status()));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'policies/a')));
});

test('3. telemetry is scoped and cannot carry policy or extra fields', async () => {
  const db = env.authenticatedContext('a', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
  await assertSucceeds(setDoc(doc(db, 'deviceStatus/a'), status()));
  await assertFails(setDoc(doc(db, 'deviceStatus/b'), status()));
  await assertFails(setDoc(doc(db, 'deviceStatus/a'), { ...status(), block_tethering: false }));
  await assertFails(setDoc(doc(db, 'deviceStatus/a'), { ...status(), last_seen: null }));
});

test('4. revoking approval removes server access', async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'enrollments/a'), { approved: false }));
  const db = env.authenticatedContext('a', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
  await assertFails(getDoc(doc(db, 'policies/a')));
  await assertFails(setDoc(doc(db, 'deviceStatus/a'), status()));
});

test('5. unverified email user is denied even if custom claim admin=true or admins/{uid} exists', async () => {
  const unverifiedClaimDb = env.authenticatedContext('consoleAdmin', {
    email: 'mashhoor.info@gmail.com',
    email_verified: false,
    admin: true,
    firebase: { sign_in_provider: 'password' }
  }).firestore();

  await assertFails(getDocs(collection(unverifiedClaimDb, 'enrollments')));
  await assertFails(getDoc(doc(unverifiedClaimDb, 'policies/a')));
  await assertFails(setDoc(doc(unverifiedClaimDb, 'enrollments/newDevice'), { approved: true }));
});

test('6. verified user without admin claim or /admins record cannot read or write MDM data or self-promote', async () => {
  const db = env.authenticatedContext('regularUser', {
    email: 'rep@company.com',
    email_verified: true,
    firebase: { sign_in_provider: 'password' }
  }).firestore();

  await assertFails(getDocs(collection(db, 'enrollments')));
  await assertFails(getDoc(doc(db, 'policies/a')));
  await assertFails(getDocs(collection(db, 'deviceStatus')));
  await assertFails(setDoc(doc(db, 'enrollments/newDevice'), { approved: true }));
  await assertFails(setDoc(doc(db, 'policies/a'), {
    schema_version: 1,
    revision: 2,
    block_tethering: false,
    blocked_apps: []
  }));
  // Cannot self-promote in /admins
  await assertFails(setDoc(doc(db, 'admins/regularUser'), { active: true, email: 'rep@company.com' }));
});

test('7. authorized admin (custom claim admin=true) can manage enrollments, policies, metadata, and append-only audit logs', async () => {
  const adminDb = env.authenticatedContext('claimAdmin', {
    email: 'admin@company.com',
    email_verified: true,
    admin: true,
    firebase: { sign_in_provider: 'password' }
  }).firestore();

  // Can list and read collections
  await assertSucceeds(getDocs(collection(adminDb, 'enrollments')));
  await assertSucceeds(getDocs(collection(adminDb, 'policies')));
  await assertSucceeds(getDocs(collection(adminDb, 'deviceStatus')));

  // Can approve a new device
  await assertSucceeds(setDoc(doc(adminDb, 'enrollments/deviceC'), { approved: true }));

  // Can create initial policy (revision 1)
  await assertSucceeds(setDoc(doc(adminDb, 'policies/deviceC'), {
    schema_version: 1,
    revision: 1,
    block_tethering: true,
    blocked_apps: ['com.zhiliaoapp.musically']
  }));

  // Can update policy ONLY when revision strictly increases
  await assertSucceeds(updateDoc(doc(adminDb, 'policies/a'), {
    schema_version: 1,
    revision: 2,
    block_tethering: false,
    blocked_apps: []
  }));

  // Stale or equal revision update is rejected
  await assertFails(updateDoc(doc(adminDb, 'policies/a'), {
    schema_version: 1,
    revision: 2,
    block_tethering: true,
    blocked_apps: []
  }));

  // Deleting policies or enrollments is forbidden
  await assertFails(deleteDoc(doc(adminDb, 'policies/a')));
  await assertFails(deleteDoc(doc(adminDb, 'enrollments/a')));

  // Admin cannot forge deviceStatus (only the device itself writes deviceStatus)
  await assertFails(setDoc(doc(adminDb, 'deviceStatus/a'), status()));

  // Admin can save separate administrative metadata
  await assertSucceeds(setDoc(doc(adminDb, 'deviceMetadata/a'), {
    device_name: 'جهاز خط شمال الرياض 01',
    rep_name: 'أحمد العتيبي',
    updated_at: serverTimestamp(),
    updated_by_uid: 'claimAdmin',
    updated_by_email: 'admin@company.com'
  }));

  // Admin can create an audit log entry, but cannot update or delete it
  await assertSucceeds(setDoc(doc(adminDb, 'auditLogs/log_001'), {
    actor_uid: 'claimAdmin',
    actor_email: 'admin@company.com',
    target_uid: 'a',
    action: 'update_policy',
    summary: 'إلغاء منع مشاركة الإنترنت (الإصدار 2)',
    before: { revision: 1, block_tethering: true },
    after: { revision: 2, block_tethering: false },
    created_at: serverTimestamp()
  }));
  await assertFails(updateDoc(doc(adminDb, 'auditLogs/log_001'), { summary: 'تزوير السجل' }));
  await assertFails(deleteDoc(doc(adminDb, 'auditLogs/log_001')));
});

test('8. authorized admin via /admins/{uid} document also has verified admin permissions', async () => {
  const consoleAdminDb = env.authenticatedContext('consoleAdmin', {
    email: 'mashhoor.info@gmail.com',
    email_verified: true,
    firebase: { sign_in_provider: 'password' }
  }).firestore();

  await assertSucceeds(getDocs(collection(consoleAdminDb, 'enrollments')));
  await assertSucceeds(setDoc(doc(consoleAdminDb, 'enrollments/deviceD'), { approved: true }));
});

test('9. firestore.rules validates all 50 elements of blocked_apps including index 1 (2nd element) and index 49 (50th element)', async () => {
  const adminDb = env.authenticatedContext('claimAdmin', {
    email: 'admin@company.com',
    email_verified: true,
    admin: true,
    firebase: { sign_in_provider: 'password' }
  }).firestore();

  // Invalid package at index 1 (second element) must fail
  await assertFails(updateDoc(doc(adminDb, 'policies/a'), {
    schema_version: 1,
    revision: 2,
    block_tethering: true,
    blocked_apps: ['com.valid.app0', 'invalid_package_at_index_1']
  }));

  // Protected package at index 1 (second element) must fail
  await assertFails(updateDoc(doc(adminDb, 'policies/a'), {
    schema_version: 1,
    revision: 2,
    block_tethering: true,
    blocked_apps: ['com.valid.app0', 'com.company.mdmagent']
  }));

  // 50 valid packages succeed
  const fiftyValidApps = Array.from({ length: 50 }, (_, i) => `com.example.validapp${i}`);
  await assertSucceeds(updateDoc(doc(adminDb, 'policies/a'), {
    schema_version: 1,
    revision: 2,
    block_tethering: true,
    blocked_apps: fiftyValidApps
  }));

  // Invalid package at index 49 (the 50th / last element) must fail
  const invalidAt49 = [...fiftyValidApps];
  invalidAt49[49] = 'not a valid package at 49';
  await assertFails(updateDoc(doc(adminDb, 'policies/a'), {
    schema_version: 1,
    revision: 3,
    block_tethering: true,
    blocked_apps: invalidAt49
  }));

  // Protected package at index 49 (the 50th / last element) must fail
  const protectedAt49 = [...fiftyValidApps];
  protectedAt49[49] = 'com.android.settings';
  await assertFails(updateDoc(doc(adminDb, 'policies/a'), {
    schema_version: 1,
    revision: 3,
    block_tethering: true,
    blocked_apps: protectedAt49
  }));
});

test('9. deviceAppInventory: approved device writes own inventory; foreign/unapproved fails; admin reads', async () => {
  const deviceA = env.authenticatedContext('a', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
  const deviceB = env.authenticatedContext('b', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
  const unapproved = env.authenticatedContext('unapproved', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
  const adminDb = env.authenticatedContext('consoleAdmin', {
    email: 'mashhoor.info@gmail.com',
    email_verified: true,
    admin: true
  }).firestore();

  const validInventory = {
    version: 1,
    scanned_at: serverTimestamp(),
    agent_version: '0.3.1-pilot',
    total_apps_count: 1,
    apps: [
      { packageName: 'com.whatsapp', appName: 'WhatsApp', isSystem: false }
    ]
  };

  // Approved device 'a' writes its own inventory document
  await assertSucceeds(setDoc(doc(deviceA, 'deviceAppInventory/a'), validInventory));

  // Device 'a' CANNOT write device 'b's inventory
  await assertFails(setDoc(doc(deviceA, 'deviceAppInventory/b'), validInventory));

  // Unapproved device CANNOT write inventory
  await assertFails(setDoc(doc(unapproved, 'deviceAppInventory/unapproved'), validInventory));

  // Device 'a' CANNOT delete its inventory
  await assertFails(deleteDoc(doc(deviceA, 'deviceAppInventory/a')));

  // Admin reads inventory
  await assertSucceeds(getDoc(doc(adminDb, 'deviceAppInventory/a')));

  // Device 'a' CANNOT read device 'b's inventory
  await assertFails(getDoc(doc(deviceA, 'deviceAppInventory/b')));
});


const kiosk = (revision=1) => ({schema_version:1,revision,enabled:true,allowed_apps:['com.whatsapp'],exit_salt:'a'.repeat(32),exit_hash:'b'.repeat(64)});
test('kiosk policy is admin-only, revisioned and cannot be deleted to unlock', async()=>{
 const admin=env.authenticatedContext('consoleAdmin',{email:'mashhoor.info@gmail.com',email_verified:true,firebase:{sign_in_provider:'password'}}).firestore();
 const phone=env.authenticatedContext('a').firestore();
 await assertSucceeds(setDoc(doc(admin,'kioskPolicies/a'),kiosk()));
 await assertSucceeds(getDoc(doc(phone,'kioskPolicies/a')));
 await assertFails(getDoc(doc(phone,'kioskPolicies/b')));
 await assertFails(setDoc(doc(phone,'kioskPolicies/a'),kiosk(2)));
 await assertFails(setDoc(doc(admin,'kioskPolicies/a'),kiosk()));
 await assertFails(deleteDoc(doc(admin,'kioskPolicies/a')));
 await assertFails(setDoc(doc(admin,'kioskPolicies/a'),{...kiosk(2),allowed_apps:[]}));
 await assertFails(setDoc(doc(admin,'kioskPolicies/a'),{...kiosk(2),enabled:'false'}));
 await assertSucceeds(setDoc(doc(admin,'kioskPolicies/a'),{...kiosk(2),enabled:false}));
});
test('only approved device reports its kiosk execution status', async()=>{
 const phone=env.authenticatedContext('a').firestore();
 const state={configured_revision:1,active:true,install_blocked:true,maintenance:false,error:'',reported_at:serverTimestamp()};
 await assertSucceeds(setDoc(doc(phone,'kioskStatus/a'),state));
 await assertFails(setDoc(doc(phone,'kioskStatus/b'),state));
 await assertFails(setDoc(doc(phone,'kioskStatus/a'),{...state,active:'true'}));
 await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(),'kioskStatus/a'),state));
});

test('package validation rejects separator injection, nonstrings and long names and accepts 50 kiosk apps',async()=>{
 const db=env.authenticatedContext('consoleAdmin',{email:'mashhoor.info@gmail.com',email_verified:true,firebase:{sign_in_provider:'password'}}).firestore();
 for(const apps of [['com.valid.app,com.android.settings'],[42],[true],[null],[{package:'com.valid.app'}],['com.'+'a'.repeat(151)],Array.from({length:51},(_,i)=>`com.app.x${i}`)]){
  await assertFails(setDoc(doc(db,'kioskPolicies/a'),{...kiosk(),allowed_apps:apps}));
 }
 await assertSucceeds(setDoc(doc(db,'kioskPolicies/a'),{...kiosk(),allowed_apps:Array.from({length:50},(_,i)=>`com.app.x${i}`)}));
});
