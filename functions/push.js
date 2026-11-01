'use strict';

function validateRegistration(auth, data) {
  if (!auth?.uid) return 'unauthenticated';
  if (!data || Object.keys(data).some(k => !['token', 'notifications_enabled', 'agent_version'].includes(k))
      || typeof data.token !== 'string' || data.token.length < 20 || data.token.length > 4096
      || /\s/.test(data.token) || typeof data.notifications_enabled !== 'boolean'
      || typeof data.agent_version !== 'string' || data.agent_version.length > 40) return 'invalid-argument';
  return null;
}
function endpointChanged(before, after) {
  return !!after && (before?.token !== after.token || before?.notifications_enabled !== after.notifications_enabled);
}
function makeMessage(uid, endpoint) {
  return {
    token: endpoint.token,
    // No notification payload: Android must call onMessageReceived even in background.
    data: {type: 'policy_sync', uid},
    android: {
      priority: endpoint.notifications_enabled === true ? 'high' : 'normal',
      ttl: 60 * 60 * 1000,
      collapseKey: 'mdm-policy-sync',
      restrictedPackageName: 'com.company.mdmagent'
    }
  };
}
const INVALID_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

// Dependencies injected so tests execute actual dispatch control flow, not a parallel model.
async function dispatch(uid, deps) {
  const {approved, endpoint} = await deps.read(uid);
  if (!approved) return 'unapproved';
  if (!endpoint?.token) return 'no-token';
  try {
    await deps.send(makeMessage(uid, endpoint));
    return 'accepted-by-fcm'; // NOT device delivery or policy application.
  } catch (error) {
    if (!INVALID_TOKEN.has(error.code)) throw error;
    // A stale event must not delete a newer token registered while send was in flight.
    await deps.removeIfCurrent(uid, endpoint.token);
    return 'invalid-token-removed';
  }
}
module.exports = {validateRegistration, endpointChanged, makeMessage, dispatch};
