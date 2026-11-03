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
  device_owner_protected?: boolean;
  deprovisioned?: boolean;
  block_app_installs?: boolean;
  location_policy_enabled?: boolean;
  location_switch_on?: boolean;
  location_service_running?: boolean;
  error: string;
  agent_version: string;
  isCorrupted?: boolean;
  corruptionErrors?: string[];
}

/**
 * appInstallPolicies/{uid}
 * Independent enterprise install blocking policy
 */
export interface AppInstallPolicyDoc {
  schema_version: number;
  revision: number;
  block_app_installs: boolean;
  updated_at?: Timestamp | null;
  updated_by_uid?: string;
  updated_by_email?: string;
}

/**
 * locationPolicies/{uid}
 * Enterprise device location tracking policy
 */
export interface LocationPolicyDoc {
  schema_version: number;
  revision: number;
  enabled: boolean;
  mode: 'continuous' | 'work_hours';
  start_time: string;
  end_time: string;
  work_days: number[];
  sampling_interval_seconds: number;
  updated_at?: Timestamp | null;
  updated_by_uid?: string;
  updated_by_email?: string;
}

/**
 * companyApps/{appId}
 * Enterprise APK distribution catalog
 */
export interface CompanyAppDoc {
  id: string;
  package_name: string;
  app_name: string;
  version_code: number;
  version_name: string;
  file_size_bytes: number;
  sha256_apk: string; // raw 64-char hex without colons
  sha256_cert: string; // raw 64-char hex without colons
  signature_scheme?: 'v1' | 'v2' | 'v3' | 'v2+v3';
  inspection_status?: 'pending_inspection' | 'verified' | 'failed';
  inspected_by_server?: boolean;
  inspection_error?: string | null;
  inspected_at?: Timestamp | null;
  storage_path?: string;
  storage_generation?: string;
  download_url?: string;
  description?: string;
  created_at: Timestamp | null;
  created_by_uid: string;
  created_by_email: string;
}

export interface DeviceCommandDoc {
  id: string;
  uid: string;
  type: 'install_app' | 'refresh_location' | 'deprovision';
  status: 'pending' | 'in_progress' | 'executed' | 'failed' | 'cancelled';
  cancelled?: boolean;
  app_id?: string;
  package_name?: string;
  app_name?: string;
  version_code?: number;
  storage_path?: string | null;
  download_url?: string;
  sha256_apk?: string;
  sha256_cert?: string;
  add_to_kiosk?: boolean;
  add_to_kiosk_requested?: boolean;
  kiosk_addition_status?:
    | 'not_requested'
    | 'installed_pending_server_policy'
    | 'waiting_for_inventory'
    | 'added'
    | 'failed';
  kiosk_addition_error?: string | null;
  kiosk_addition_message?: string | null;
  kiosk_added_revision?: number;
  kiosk_added_for_version?: number;
  installed_version?: number;
  install_outcome?: 'installed_new_or_updated' | 'already_installed';
  progress?: string;
  error?: string | null;
  error_code?: number;
  expires_at?: string;
  created_at: Timestamp | null;
  started_at?: Timestamp | null;
  completed_at?: Timestamp | null;
  created_by_uid: string;
  created_by_email: string;
}

/**
 * installRequests/{requestId}
 * Enterprise application approval requests from field devices
 */
export interface InstallRequestDoc {
  id: string;
  device_uid: string;
  package_name: string;
  app_name: string;
  version_code: number;
  requested_by_rep: string;
  status: 'pending' | 'approved' | 'rejected' | 'installed' | 'failed';
  reason?: string;
  admin_notes?: string;
  created_at: Timestamp | null;
  reviewed_at?: Timestamp | null;
  reviewed_by_uid?: string;
  reviewed_by_email?: string;
}

/**
 * deviceLocations/{uid}/points/{pointId}
 * Historical breadcrumb point
 */
export interface DeviceLocationPoint {
  point_id: string;
  latitude: number;
  longitude: number;
  accuracy_meters: number;
  speed_mps: number;
  battery_percent: number;
  recorded_at: Timestamp | null;
  received_at: Timestamp | null;
  is_delayed_sync: boolean;
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
  archived?: boolean;
  archived_at?: Timestamp | null;
  archived_by_uid?: string | null;
  archived_by_email?: string | null;
}

export type AuditActionType =
  | 'approve_device'
  | 'revoke_approval'
  | 'create_policy'
  | 'update_policy'
  | 'update_metadata'
  | 'archive_device'
  | 'restore_device'
  | 'update_install_policy'
  | 'update_location_policy'
  | 'deprovision_device'
  | 'approve_install_request'
  | 'reject_install_request'
  | 'add_company_app'
  | 'send_install_command'
  | 'cancel_install_command'
  | 'clean_locations';

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
  isArchived: boolean;
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

