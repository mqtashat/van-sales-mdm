'use strict';
const {initializeApp} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const {getMessaging} = require('firebase-admin/messaging');
const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onDocumentWritten} = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');
const {validateRegistration, endpointChanged, dispatch} = require('./push');
initializeApp();
const db = getFirestore();
const options = {region: 'us-central1', maxInstances: 2, memory: '256MiB', timeoutSeconds: 60};

exports.registerMdmPush = onCall(options, async request => {
  const error = validateRegistration(request.auth, request.data);
  if (error) throw new HttpsError(error, 'Authenticated device and valid registration required.');
  const uid = request.auth.uid; // Never accept a caller-selected UID.
  const ref = db.doc(`devicePush/${uid}`);
  await db.runTransaction(async tx => {
    const enrollment = await tx.get(db.doc(`enrollments/${uid}`));
    if (enrollment.data()?.approved !== true) throw new HttpsError('permission-denied', 'Device is not approved.');
    tx.set(ref, {
      token: request.data.token,
      notifications_enabled: request.data.notifications_enabled,
      agent_version: request.data.agent_version,
      updated_at: FieldValue.serverTimestamp()
    });
  });
  return {registered: true};
});

const deps = {
  async read(uid) {
    const [enrollment, endpoint] = await db.getAll(db.doc(`enrollments/${uid}`), db.doc(`devicePush/${uid}`));
    return {approved: enrollment.data()?.approved === true, endpoint: endpoint.data()};
  },
  send: message => getMessaging().send(message),
  async removeIfCurrent(uid, token) {
    const ref = db.doc(`devicePush/${uid}`);
    await db.runTransaction(async tx => {
      const current = await tx.get(ref);
      if (current.data()?.token === token) tx.delete(ref);
    });
  }
};
async function wake(event) {
  // Firestore delivery is at least once and unordered. Always re-read current approval/token;
  // Android re-reads current policy. Duplicate hints are safe and collapse while offline.
  if (Date.now() - Date.parse(event.time) > 60 * 60 * 1000) {
    logger.warn('push_event_expired');
    return;
  }
  try {
    const outcome = await dispatch(event.params.uid, deps);
    logger.info('policy_push_dispatch', {eventId: event.id, outcome});
  } catch (error) {
    logger.error('policy_push_failed', {eventId: event.id, code: error.code || 'unknown'});
    // Retry transient delivery failures; never log tokens or payloads.
    throw new Error('Policy push dispatch failed');
  }
}
exports.mdmPolicyChanged = onDocumentWritten({...options, document: 'policies/{uid}', retry: true}, wake);
exports.mdmEnrollmentChanged = onDocumentWritten({...options, document: 'enrollments/{uid}', retry: true}, async event => {
  // Approved devices get a catch-up wake after re-approval. Revoked devices do not receive pushes;
  // the existing listener/periodic path observes revocation and preserves applied restrictions.
  if (event.data?.after.data()?.approved === true) await wake(event);
});
exports.mdmPushRegistered = onDocumentWritten({...options, document: 'devicePush/{uid}', retry: true}, async event => {
  // Updating heartbeat/agent_version does not generate an endless sync/register/push loop.
  if (endpointChanged(event.data?.before.data(), event.data?.after.data())) await wake(event);
});
