import type { Timestamp } from 'firebase/firestore';

export const TARGET_FIREBASE_PROJECT_ID = 'vansales-mdm';
export const TARGET_FIRESTORE_DATABASE_ID = '(default)';
export const MDM_AGENT_PACKAGE_NAME = 'com.company.mdmagent';

/**
 * enrollments/{uid}
 * Extracted from SyncEngine.java & firestore.rules
 */
export interface EnrollmentDoc {
  approved: boolean;
  isCorrupted?: boolean;
  corruptionReason?: string;
  rawData?: Record<string, unknown>;
}

/**
 * policies/{uid}
 * Extracted from Policy.java & PolicyTest.java
 */
export interface PolicyDoc {
  schema_version: number;
  revision: number;
  block_tethering: boolean;
  blocked_apps: string[];
  isCorrupted?: boolean;
  corruptionErrors?: string[];
  rawData?: Record<string, unknown>;
}

/**
 * deviceStatus/{uid}
 * Extracted from SyncEngine.java (lines 53-64) & firestore.rules (lines 20-32)
 */
export interface DeviceStatusDoc {
  device_owner: boolean;
  applied_revision: number;
  tethering_restricted: boolean;
  last_seen: Timestamp | null;
  model: string;
  android_sdk: number;
  battery_percent: number;
  error: string;
  agent_version: string;
  isCorrupted?: boolean;
  corruptionErrors?: string[];
}

/**
 * deviceMetadata/{uid}
 * Separate admin-only metadata collection so editing device/rep names
 * never touches or overwrites enrollments, policies, or deviceStatus.
 */
export interface DeviceMetadataDoc {
  device_name: string;
  rep_name: string;
  updated_at: Timestamp | null;
  updated_by_uid: string;
  updated_by_email: string;
}

export type AuditActionType =
  | 'approve_device'
  | 'revoke_approval'
  | 'create_policy'
  | 'update_policy'
  | 'update_metadata';

/**
 * auditLogs/{logId}
 * Append-only administrative audit record (protected from modification/deletion by rules,
 * though rules do not force every admin write to create a corresponding audit record).
 */
export interface AuditLogDoc {
  id: string;
  actor_uid: string;
  actor_email: string;
  target_uid: string;
  action: AuditActionType;
  summary: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  created_at: Timestamp | null;
}

export type ApprovalState =
  | 'approved'
  | 'pending_approval'
  | 'missing_enrollment'
  | 'corrupted_enrollment';

export type EnforcementState =
  | 'applied'
  | 'pending'
  | 'error'
  | 'no_policy'
  | 'corrupted_policy';

/**
 * Aggregated record per UID across enrollments, policies, deviceStatus, and deviceMetadata.
 * Handles devices that exist in one collection without existing in the others.
 */
export interface MergedDeviceRecord {
  uid: string;
  enrollment: EnrollmentDoc | null;
  policy: PolicyDoc | null;
  status: DeviceStatusDoc | null;
  metadata: DeviceMetadataDoc | null;
  // Computed states
  approvalState: ApprovalState;
  enforcementState: EnforcementState;
  enforcementDetail: string;
  isStaleConnection: boolean;
  lastSeenMs: number | null;
  presentInCollections: {
    enrollments: boolean;
    policies: boolean;
    deviceStatus: boolean;
    deviceMetadata: boolean;
  };
}

export interface FirebaseWebConfigInput {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
  databaseId?: string;
}

/**
 * Detailed server check diagnosis for /admins/{uid} document
 */
export type AdminDocCheckStatus =
  | 'not_checked_unverified_email'
  | 'granted'
  | 'missing_or_inactive'
  | 'permission_denied'
  | 'network_or_unavailable';

export interface AdminIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  isAnonymous: boolean;
  hasCustomAdminClaim: boolean;
  hasAdminDocRecord: boolean;
  adminDocCheckStatus: AdminDocCheckStatus;
  adminDocCheckDetail: string;
  isAuthorizedAdmin: boolean;
  signInProvider: string;
}

/**
 * Single item inside a device's reported application inventory.
 */
export interface DeviceAppItem {
  package_name: string;
  app_name: string;
  has_launcher_icon: boolean;
  is_system_app: boolean;
  is_protected: boolean;
  protection_reason?: string;
  is_hidden_by_agent: boolean;
  is_enabled?: boolean;
  reported_at_ms?: number;
}

/**
 * deviceAppInventory/{uid} or deviceAppInventory/{uid}/batches/{batchId}
 * Versioned app inventory chunk published by Android agent (version 0.3.1+).
 */
export interface DeviceAppInventoryDoc {
  schema_version: number;
  batch_id: string;
  batch_index: number;
  total_batches: number;
  reported_at: Timestamp | null;
  agent_version: string;
  apps: DeviceAppItem[];
  isCorrupted?: boolean;
  corruptionErrors?: string[];
}

/**
 * Bulk actions supported for multi-device management.
 */
export type BulkActionType =
  | 'block_apps'
  | 'allow_apps'
  | 'set_tethering';

export interface BulkActionPlanItem {
  uid: string;
  deviceName: string;
  repName: string;
  eligible: boolean;
  skipReason?: string;
  currentRevision: number | null;
  currentBlockTethering: boolean;
  currentBlockedApps: string[];
  nextBlockTethering: boolean;
  nextBlockedApps: string[];
  hasActualChanges: boolean;
}

export type BulkDeviceExecutionStatus =
  | 'pending'
  | 'in_progress'
  | 'saved_pending_phone'
  | 'applied'
  | 'conflict'
  | 'error'
  | 'skipped';

export interface BulkDeviceExecutionResult {
  uid: string;
  deviceName: string;
  repName: string;
  status: BulkDeviceExecutionStatus;
  message: string;
  savedRevision?: number;
  error?: string;
}

