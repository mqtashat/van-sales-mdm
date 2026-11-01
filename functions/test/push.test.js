'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {registerEndpoint, validateRegistration, endpointChanged, makeMessage, dispatch} = require('../push');
const token = 'a'.repeat(150);
const valid = {token, notifications_enabled: true, agent_version: '0.3.0-pilot'};
test('registration requires auth and strict types and rejects caller selected UID', () => {
  assert.equal(validateRegistration(null, valid), 'unauthenticated');
  assert.equal(validateRegistration({uid: 'own'}, valid), null);
  for (const data of [{...valid, uid: 'other'}, {...valid, notifications_enabled: 'true'}, {...valid, token: ''}, {...valid, token: 'x '.repeat(30)}]) {
    assert.equal(validateRegistration({uid: 'own'}, data), 'invalid-argument');
  }
});
test('refresh heartbeat does not trigger a push loop, token rotation does', () => {
  assert.equal(endpointChanged(valid, {...valid, updated_at: 123}), false);
  assert.equal(endpointChanged(valid, {...valid, token: 'new'}), true);
  assert.equal(endpointChanged(undefined, valid), true);
  assert.equal(endpointChanged(valid, undefined), false);
});
test('only visible update notifications get high priority; payload is a hint, not policy', () => {
  const message = makeMessage('uid', valid);
  assert.equal(message.android.priority, 'high');
  assert.equal(makeMessage('uid', {...valid, notifications_enabled: false}).android.priority, 'normal');
  assert.deepEqual(message.data, {type: 'policy_sync', uid: 'uid'});
  assert.equal(message.notification, undefined);
  assert.equal(message.android.restrictedPackageName, 'com.company.mdmagent');
});
test('unapproved/missing token causes no FCM send', async () => {
  for (const state of [{approved: false, endpoint: valid}, {approved: true}]) {
    let sent = false;
    await dispatch('uid', {read: async () => state, send: async () => {sent = true;}});
    assert.equal(sent, false);
  }
});
test('dispatch reads current state and accepted-by-fcm is not applied', async () => {
  let sent;
  const outcome = await dispatch('uid', {read: async () => ({approved: true, endpoint: valid}), send: async m => {sent = m;}});
  assert.equal(sent.token, token);
  assert.equal(outcome, 'accepted-by-fcm');
});
test('transient errors propagate for retry; do not delete registration', async () => {
  let removed = false;
  await assert.rejects(dispatch('uid', {
    read: async () => ({approved: true, endpoint: valid}),
    send: async () => {throw Object.assign(new Error(), {code: 'messaging/server-unavailable'});},
    removeIfCurrent: async () => {removed = true;}
  }));
  assert.equal(removed, false);
});
test('invalid token passes exact attempted token for race-safe cleanup', async () => {
  let removed;
  const outcome = await dispatch('uid', {
    read: async () => ({approved: true, endpoint: valid}),
    send: async () => {throw Object.assign(new Error(), {code: 'messaging/registration-token-not-registered'});},
    removeIfCurrent: async (uid, t) => {removed = {uid, token: t};}
  });
  assert.deepEqual(removed, {uid: 'uid', token});
  assert.equal(outcome, 'invalid-token-removed');
});

test('actual registration transaction checks approval and writes only authenticated UID', async () => {
  let approved = false;
  let written;
  const db = {
    doc: path => path,
    runTransaction: fn => fn({
      get: async path => { assert.equal(path, 'enrollments/device1'); return {data: () => ({approved})}; },
      set: (path, value) => {written = {path, value};}
    })
  };
  await assert.rejects(registerEndpoint({uid: 'device1'}, valid, db, () => 123), {code: 'permission-denied'});
  assert.equal(written, undefined);
  approved = true;
  assert.deepEqual(await registerEndpoint({uid: 'device1'}, valid, db, () => 123), {registered: true});
  assert.deepEqual(written, {path: 'devicePush/device1', value: {...valid, updated_at: 123}});
});
test('unauthenticated and forged UID registrations cannot start any transaction', async () => {
  const db = {runTransaction: () => {throw Error('must not access DB');}};
  await assert.rejects(registerEndpoint(null, valid, db, () => 0), {code: 'unauthenticated'});
  await assert.rejects(registerEndpoint({uid: 'own'}, {...valid, uid: 'victim'}, db, () => 0), {code: 'invalid-argument'});
});
