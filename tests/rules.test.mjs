import { before, after, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, collection, getDoc, getDocs, setDoc, serverTimestamp } from 'firebase/firestore';

let env;
before(async () => {
  env = await initializeTestEnvironment({projectId: 'demo-mdm', firestore: {
    rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')
  }});
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'enrollments/a'), {approved: true});
    await setDoc(doc(db, 'enrollments/b'), {approved: true});
    await setDoc(doc(db, 'policies/a'), {schema_version: 1, revision: 1, block_tethering: true});
    await setDoc(doc(db, 'policies/b'), {schema_version: 1, revision: 1, block_tethering: true});
  });
});
const status = () => ({device_owner: true, applied_revision: 1, tethering_restricted: true,
  last_seen: serverTimestamp(), model: 'TECNO POVA 5', android_sdk: 33, battery_percent: 70,
  error: '', agent_version: '0.1.0-pilot'});
test('approved device reads only its own policy, cannot list or alter policies', async () => {
  const db = env.authenticatedContext('a').firestore();
  await assertSucceeds(getDoc(doc(db, 'policies/a')));
  await assertFails(getDoc(doc(db, 'policies/b')));
  await assertFails(getDocs(collection(db, 'policies')));
  await assertFails(setDoc(doc(db, 'policies/a'), {block_tethering: false}));
});
test('anonymous identity is not approval; enrollment cannot be self-approved', async () => {
  const db = env.authenticatedContext('unapproved').firestore();
  await assertSucceeds(getDoc(doc(db, 'enrollments/unapproved')));
  await assertFails(setDoc(doc(db, 'enrollments/unapproved'), {approved: true}));
  await assertFails(getDoc(doc(db, 'policies/unapproved')));
  await assertFails(setDoc(doc(db, 'deviceStatus/unapproved'), status()));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'policies/a')));
});
test('telemetry is scoped and cannot carry policy or extra fields', async () => {
  const db = env.authenticatedContext('a').firestore();
  await assertSucceeds(setDoc(doc(db, 'deviceStatus/a'), status()));
  await assertFails(setDoc(doc(db, 'deviceStatus/b'), status()));
  await assertFails(setDoc(doc(db, 'deviceStatus/a'), {...status(), block_tethering: false}));
  await assertFails(setDoc(doc(db, 'deviceStatus/a'), {...status(), last_seen: null}));
});
test('revoking approval removes server access', async () => {
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'enrollments/a'), {approved: false}));
  const db = env.authenticatedContext('a').firestore();
  await assertFails(getDoc(doc(db, 'policies/a')));
  await assertFails(setDoc(doc(db, 'deviceStatus/a'), status()));
});

