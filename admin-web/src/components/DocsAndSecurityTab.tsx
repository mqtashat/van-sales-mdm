import React, { useState } from 'react';
import { Shield, Copy, Check, Database, AlertTriangle, FileText } from 'lucide-react';

export const PROPOSED_RULES_TEXT = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Global default-deny safety net
    match /{document=**} {
      allow read, write: if false;
    }

    function isValidId(id) {
      return id is string && id.size() >= 1 && id.size() <= 128 && id.matches('^[a-zA-Z0-9_\\\\-]+$');
    }

    function own(uid) {
      return request.auth != null && request.auth.uid == uid;
    }

    function approved(uid) {
      return own(uid)
        && exists(/databases/$(database)/documents/enrollments/$(uid))
        && get(/databases/$(database)/documents/enrollments/$(uid)).data.approved == true;
    }

    function isNamedVerifiedUser() {
      return request.auth != null
        && (!('firebase' in request.auth.token) || request.auth.token.firebase.sign_in_provider != 'anonymous')
        && request.auth.token.email is string
        && request.auth.token.email.size() > 3
        && request.auth.token.email.size() <= 254
        && request.auth.token.email_verified == true;
    }

    // Administrator authorization requires a named, email-verified user AND either:
    // 1. A trusted Custom Claim (request.auth.token.admin == true) set via Firebase Admin SDK, OR
    // 2. An active record in /admins/{uid} provisioned via Firebase Console / Admin SDK (client writes forbidden).
    function isAdmin() {
      return isNamedVerifiedUser() && (
        (request.auth.token.keys().hasAny(['admin']) && request.auth.token.admin == true)
        || (
          exists(/databases/$(database)/documents/admins/$(request.auth.uid))
          && get(/databases/$(database)/documents/admins/$(request.auth.uid)).data.active == true
        )
      );
    }

    function isValidEnrollment(data) {
      return data.keys().hasAll(['approved'])
        && data.keys().hasOnly(['approved'])
        && data.approved is bool;
    }

    // Round-trip equality rejects non-strings and separator injection without 50 function calls.
    function validJoinedApps(apps) {
      let joined = apps.join(',');
      return joined.split(',') == apps
        && joined.matches('^[A-Za-z][A-Za-z0-9_]*(\\\\.[A-Za-z][A-Za-z0-9_]*)+(,[A-Za-z][A-Za-z0-9_]*(\\\\.[A-Za-z][A-Za-z0-9_]*)+)*$')
        && joined.matches('^[^,]{3,150}(,[^,]{3,150})*$');
    }
    function areAllBlockedAppsValid(apps) {
      return apps is list && apps.size() <= 50
        && !apps.hasAny(['com.company.mdmagent','com.android.settings','com.android.systemui','com.google.android.gms','com.google.android.gsf','com.android.vending'])
        && (apps.size() == 0 || validJoinedApps(apps));
    }

    function isValidPolicy(data) {
      return data.keys().hasAll(['schema_version', 'revision', 'block_tethering', 'blocked_apps'])
        && data.keys().hasOnly(['schema_version', 'revision', 'block_tethering', 'blocked_apps'])
        && data.schema_version is int
        && data.schema_version == 1
        && data.revision is int
        && data.revision >= 1
        && data.block_tethering is bool
        && areAllBlockedAppsValid(data.blocked_apps);
    }

    function isValidDeviceStatus(data) {
      return data.keys().hasAll(['device_owner', 'applied_revision', 'tethering_restricted', 'last_seen', 'model', 'android_sdk', 'battery_percent', 'error', 'agent_version'])
        && data.keys().hasOnly(['device_owner', 'applied_revision', 'tethering_restricted', 'last_seen', 'model', 'android_sdk', 'battery_percent', 'error', 'agent_version'])
        && data.device_owner is bool
        && data.applied_revision is int
        && data.applied_revision >= 0
        && data.tethering_restricted is bool
        && data.last_seen == request.time
        && data.model is string && data.model.size() <= 200
        && data.android_sdk is int
        && data.battery_percent is int
        && data.error is string && data.error.size() <= 1000
        && data.agent_version is string && data.agent_version.size() <= 40;
    }

    function isValidDeviceMetadata(data) {
      return data.keys().hasAll(['device_name', 'rep_name', 'updated_at', 'updated_by_uid', 'updated_by_email'])
        && data.keys().hasOnly(['device_name', 'rep_name', 'updated_at', 'updated_by_uid', 'updated_by_email', 'archived', 'archived_at', 'archived_by_uid', 'archived_by_email'])
        && data.device_name is string && data.device_name.size() <= 120
        && data.rep_name is string && data.rep_name.size() <= 120
        && data.updated_at == request.time
        && data.updated_by_uid is string && data.updated_by_uid == request.auth.uid
        && data.updated_by_email is string && data.updated_by_email == request.auth.token.email
        && (!('archived' in data) || (
          data.archived is bool
          && ((request.method == 'update' && !data.diff(resource.data).affectedKeys().hasAny(['archived', 'archived_at', 'archived_by_uid', 'archived_by_email'])) || (
          (!('archived_at' in data) || data.archived_at == null || data.archived_at == request.time)
          && (!('archived_by_uid' in data) || data.archived_by_uid == null || (data.archived_by_uid is string && data.archived_by_uid == request.auth.uid))
          && (!('archived_by_email' in data) || data.archived_by_email == null || (data.archived_by_email is string && data.archived_by_email == request.auth.token.email))))
        ));
    }

    function isValidAuditLog(data) {
      return data.keys().hasAll(['actor_uid', 'actor_email', 'target_uid', 'action', 'summary', 'before', 'after', 'created_at'])
        && data.keys().hasOnly(['actor_uid', 'actor_email', 'target_uid', 'action', 'summary', 'before', 'after', 'created_at'])
        && data.actor_uid is string && data.actor_uid == request.auth.uid
        && data.actor_email is string && data.actor_email == request.auth.token.email
        && data.target_uid is string && isValidId(data.target_uid)
        && data.action is string && data.action in ['approve_device', 'revoke_approval', 'create_policy', 'update_policy', 'update_metadata', 'archive_device', 'restore_device']
        && data.summary is string && data.summary.size() >= 1 && data.summary.size() <= 500
        && data.before is map
        && data.after is map
        && data.created_at == request.time;
    }

    // 1. Device Enrollment Records
    match /enrollments/{uid} {
      allow get: if isValidId(uid) && (own(uid) || isAdmin());
      allow list: if isAdmin();
      allow create, update: if isValidId(uid) && isValidEnrollment(request.resource.data) && isAdmin();
      allow delete: if false;
    }

    // 2. Device Policies (Contract with Android Agent com.company.mdmagent)
    match /policies/{uid} {
      allow get: if isValidId(uid) && (approved(uid) || isAdmin());
      allow list: if isAdmin();
      allow create: if isValidId(uid) && isValidPolicy(request.resource.data) && isAdmin();
      allow update: if isValidId(uid)
        && isValidPolicy(request.resource.data)
        && request.resource.data.revision > resource.data.revision
        && isAdmin();
      allow delete: if false;
    }

    // 3. Self-Reported Device Execution Status (Written by Approved Device Only; Read by Device & Admin)
    match /deviceStatus/{uid} {
      allow get: if isValidId(uid) && (approved(uid) || isAdmin());
      allow list: if isAdmin();
      allow create, update: if isValidId(uid) && isValidDeviceStatus(request.resource.data) && approved(uid);
      allow delete: if false;
    }

    // 4. Separate Administrative Metadata (Device Label & Sales Representative Name)
    match /deviceMetadata/{uid} {
      allow get: if isValidId(uid) && (approved(uid) || isAdmin());
      allow list: if isAdmin();
      allow create, update: if isValidId(uid) && isValidDeviceMetadata(request.resource.data) && isAdmin();
      allow delete: if false;
    }

    // 5. Append-Only Administrative Audit Log (Protected from modification/deletion, though rules do not force every admin write to create a log)
    match /auditLogs/{logId} {
      allow get: if isValidId(logId) && isAdmin();
      allow list: if isAdmin();
      allow create: if isValidId(logId) && isValidAuditLog(request.resource.data) && isAdmin();
      allow update, delete: if false;
    }

    // 6. Server-Managed Administrator Registry (Read-Only for Verification; Never Client-Writable)
    match /admins/{uid} {
      allow get: if isValidId(uid) && ((isNamedVerifiedUser() && own(uid)) || isAdmin());
      allow list: if isAdmin();
      allow create, update, delete: if false;
    }

    function validKioskStatus(d) {
      return d.keys().hasAll(['configured_revision','active','install_blocked','maintenance','error','reported_at'])
        && d.keys().hasOnly(['configured_revision','active','install_blocked','maintenance','error','reported_at'])
        && d.configured_revision is int && d.configured_revision >= 0
        && d.active is bool && d.install_blocked is bool && d.maintenance is bool
        && d.error is string && d.error.size() <= 1000 && d.reported_at == request.time;
    }
    match /kioskStatus/{uid} {
      allow get: if approved(uid) || isAdmin();
      allow list: if isAdmin();
      allow create, update: if approved(uid) && validKioskStatus(request.resource.data);
      allow delete: if false;
    }
    function validKiosk(d) {
      return d.keys().hasAll(['schema_version','revision','enabled','allowed_apps','exit_salt','exit_hash'])
        && d.keys().hasOnly(['schema_version','revision','enabled','allowed_apps','exit_salt','exit_hash'])
        && d.schema_version == 1 && d.revision is int && d.revision > 0 && d.enabled is bool
        && areAllBlockedAppsValid(d.allowed_apps) && (!d.enabled || d.allowed_apps.size() > 0)
        && d.exit_salt is string && d.exit_salt.matches('^[a-f0-9]{32}$')
        && d.exit_hash is string && d.exit_hash.matches('^[a-f0-9]{64}$');
    }
    match /kioskPolicies/{uid} {
      allow get: if approved(uid) || isAdmin();
      allow list: if isAdmin();
      allow create: if isAdmin() && validKiosk(request.resource.data);
      allow update: if isAdmin() && validKiosk(request.resource.data) && request.resource.data.revision > resource.data.revision;
      allow delete: if false;
    }

    // 7. Device Application Inventory (Published by approved Android Agent 0.3.1+; Read by Device & Admin)
    match /deviceAppInventory/{uid} {
      allow get: if isValidId(uid) && (approved(uid) || isAdmin());
      allow list: if isAdmin();
      allow create, update: if isValidId(uid) && approved(uid);
      allow delete: if false;

      match /batches/{batchId} {
        allow get: if isValidId(uid) && (approved(uid) || isAdmin());
        allow list: if isAdmin();
        allow create, update: if isValidId(uid) && isValidId(batchId) && approved(uid);
        allow delete: if false;
      }
    }
  }
}`;

export const DocsAndSecurityTab: React.FC = () => {
  const [copiedRules, setCopiedRules] = useState(false);

  const handleCopyRules = () => {
    navigator.clipboard.writeText(PROPOSED_RULES_TEXT);
    setCopiedRules(true);
    setTimeout(() => setCopiedRules(false), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 flex items-start gap-4">
        <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-800 flex items-center justify-center shrink-0">
          <AlertTriangle className="w-5 h-5" />
        </div>
        <div className="space-y-2 text-sm text-amber-900">
          <h3 className="font-bold text-base">تشخيص خطأ صلاحيات «شاشة الشركة» (Missing or insufficient permissions)</h3>
          <p className="leading-relaxed">
            عند ظهور رسالة <span className="font-semibold">«تعذر قراءة حالة الشاشة بسبب صلاحيات قاعدة البيانات»</span> داخل تبويب شاشة الشركة، فهذا يعني أن ملف القواعد المنشور حاليًا في مشروع Firebase (<code className="font-mono text-xs bg-amber-100 px-1.5 py-0.5 rounded">vansales-mdm</code>) يسبق تحديث <strong>0.4.0-pilot</strong> ولا يتضمن بعد تصاريح القراءة والكتابة لمساري <code className="font-mono text-xs bg-amber-100 px-1.5 py-0.5 rounded">kioskPolicies/&#123;uid&#125;</code> و <code className="font-mono text-xs bg-amber-100 px-1.5 py-0.5 rounded">kioskStatus/&#123;uid&#125;</code>.
          </p>
          <p className="leading-relaxed font-medium">
            الحل الآمن: انسخ نص قواعد الأمان الكامل أدناه وانشره في <strong>Firebase Console &rarr; Firestore Database &rarr; Rules</strong> (أو عبر CLI) مع الحفاظ على قصر القراءة والكتابة الإدارية على <code className="font-mono text-xs bg-amber-100 px-1.5 py-0.5 rounded">isAdmin()</code> والجهاز المعتمد <code className="font-mono text-xs bg-amber-100 px-1.5 py-0.5 rounded">approved(uid)</code> دون فتح أي وصول عام.
          </p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Shield className="w-5 h-5 text-blue-600" />
            <div>
              <h3 className="text-base font-bold text-slate-900">ملف قواعد الأمان الكامل (firestore.rules — 0.4.0-pilot)</h3>
              <p className="text-xs text-slate-500">يشمل حماية الأجهزة، السياسات، سجل التطبيقات، وشاشة الشركة (Kiosk Mode)</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCopyRules}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition-colors cursor-pointer"
          >
            {copiedRules ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            {copiedRules ? 'تم نسخ القواعد بالكامل' : 'نسخ ملف firestore.rules'}
          </button>
        </div>
        <div className="p-4 bg-slate-950 text-slate-100 overflow-x-auto max-h-[460px]">
          <pre className="text-xs font-mono leading-relaxed" dir="ltr">{PROPOSED_RULES_TEXT}</pre>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200/90 p-5 shadow-xs space-y-2">
          <div className="flex items-center gap-2 text-slate-900 font-bold text-sm">
            <Database className="w-4 h-4 text-blue-600" />
            <span>مسارات البيانات المعتمدة في 0.4.0-pilot</span>
          </div>
          <ul className="text-xs text-slate-600 space-y-1.5 leading-relaxed list-disc list-inside">
            <li>الاعتماد والتسجيل: <code className="font-mono text-slate-800" dir="ltr">enrollments/&#123;uid&#125;</code></li>
            <li>سياسة الحظر ومشاركة الإنترنت: <code className="font-mono text-slate-800" dir="ltr">policies/&#123;uid&#125;</code></li>
            <li>تقرير حالة الجهاز: <code className="font-mono text-slate-800" dir="ltr">deviceStatus/&#123;uid&#125;</code></li>
            <li>جرد تطبيقات الهاتف الفعلي: <code className="font-mono text-slate-800" dir="ltr">deviceAppInventory/&#123;uid&#125;</code></li>
            <li>إعدادات وحالة شاشة الشركة: <code className="font-mono text-slate-800" dir="ltr">kioskPolicies/&#123;uid&#125;</code> و <code className="font-mono text-slate-800" dir="ltr">kioskStatus/&#123;uid&#125;</code></li>
          </ul>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200/90 p-5 shadow-xs space-y-2">
          <div className="flex items-center gap-2 text-slate-900 font-bold text-sm">
            <FileText className="w-4 h-4 text-emerald-600" />
            <span>شروط الأمان الملزمة</span>
          </div>
          <ul className="text-xs text-slate-600 space-y-1.5 leading-relaxed list-disc list-inside">
            <li>التحقق من البريد المؤكد للمسؤول ووجود وثيقة نشطة في <code className="font-mono text-slate-800" dir="ltr">admins/&#123;uid&#125;</code>.</li>
            <li>منع حظر الحزم الأساسية للنظام أو وكيل الإدارة.</li>
            <li>اشتراط زيادة رقم الإصدار (<code className="font-mono text-slate-800" dir="ltr">revision</code>) عند كل تحديث سياسة أو شاشة شركة.</li>
            <li>حفظ كلمة مرور صيانة شاشة الشركة كـ PBKDF2-HMAC-SHA256 (<code className="font-mono text-slate-800" dir="ltr">exit_salt</code> + <code className="font-mono text-slate-800" dir="ltr">exit_hash</code>).</li>
          </ul>
        </div>
      </div>
    </div>
  );
};
