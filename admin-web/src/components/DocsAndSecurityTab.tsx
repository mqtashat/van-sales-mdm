import React, { useState } from 'react';
import {
  Copy,
  Check,
  Database,
  ShieldCheck,
  Terminal,
  Rocket,
  CheckCircle2,
  Clock,
} from 'lucide-react';

const PROPOSED_RULES_TEXT = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
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

    function isValidPkg(pkg) {
      return pkg is string
        && pkg.size() >= 3
        && pkg.size() <= 150
        && pkg.matches('^[A-Za-z][A-Za-z0-9_]*(\\\\.[A-Za-z][A-Za-z0-9_]*)+$')
        && !(pkg in [
          'com.company.mdmagent',
          'com.android.settings',
          'com.android.systemui',
          'com.google.android.gms',
          'com.google.android.gsf',
          'com.android.vending'
        ]);
    }

    function validPkgAt(apps, idx) {
      return apps.size() <= idx || isValidPkg(apps[idx]);
    }

    function validAppsBatch(apps, offset) {
      return validPkgAt(apps, offset + 0)
        && validPkgAt(apps, offset + 1)
        && validPkgAt(apps, offset + 2)
        && validPkgAt(apps, offset + 3)
        && validPkgAt(apps, offset + 4)
        && validPkgAt(apps, offset + 5)
        && validPkgAt(apps, offset + 6)
        && validPkgAt(apps, offset + 7)
        && validPkgAt(apps, offset + 8)
        && validPkgAt(apps, offset + 9);
    }

    function areAllBlockedAppsValid(apps) {
      return apps is list
        && apps.size() <= 50
        && validAppsBatch(apps, 0)
        && validAppsBatch(apps, 10)
        && validAppsBatch(apps, 20)
        && validAppsBatch(apps, 30)
        && validAppsBatch(apps, 40);
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
        && data.keys().hasOnly(['device_name', 'rep_name', 'updated_at', 'updated_by_uid', 'updated_by_email'])
        && data.device_name is string && data.device_name.size() <= 120
        && data.rep_name is string && data.rep_name.size() <= 120
        && data.updated_at == request.time
        && data.updated_by_uid is string && data.updated_by_uid == request.auth.uid
        && data.updated_by_email is string && data.updated_by_email == request.auth.token.email;
    }

    function isValidAuditLog(data) {
      return data.keys().hasAll(['actor_uid', 'actor_email', 'target_uid', 'action', 'summary', 'before', 'after', 'created_at'])
        && data.keys().hasOnly(['actor_uid', 'actor_email', 'target_uid', 'action', 'summary', 'before', 'after', 'created_at'])
        && data.actor_uid is string && data.actor_uid == request.auth.uid
        && data.actor_email is string && data.actor_email == request.auth.token.email
        && data.target_uid is string && isValidId(data.target_uid)
        && data.action is string && data.action in ['approve_device', 'revoke_approval', 'create_policy', 'update_policy', 'update_metadata']
        && data.summary is string && data.summary.size() >= 1 && data.summary.size() <= 500
        && data.before is map
        && data.after is map
        && data.created_at == request.time;
    }

    match /enrollments/{uid} {
      allow get: if isValidId(uid) && (own(uid) || isAdmin());
      allow list: if isAdmin();
      allow create, update: if isValidId(uid) && isValidEnrollment(request.resource.data) && isAdmin();
      allow delete: if false;
    }

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

    match /deviceStatus/{uid} {
      allow get: if isValidId(uid) && (approved(uid) || isAdmin());
      allow list: if isAdmin();
      allow create, update: if isValidId(uid) && isValidDeviceStatus(request.resource.data) && approved(uid);
      allow delete: if false;
    }

    match /deviceMetadata/{uid} {
      allow get: if isValidId(uid) && isAdmin();
      allow list: if isAdmin();
      allow create, update: if isValidId(uid) && isValidDeviceMetadata(request.resource.data) && isAdmin();
      allow delete: if false;
    }

    match /auditLogs/{logId} {
      allow get: if isValidId(logId) && isAdmin();
      allow list: if isAdmin();
      allow create: if isValidId(logId) && isValidAuditLog(request.resource.data) && isAdmin();
      allow update, delete: if false;
    }

    match /admins/{uid} {
      allow get: if isValidId(uid) && ((isNamedVerifiedUser() && own(uid)) || isAdmin());
      allow list: if isAdmin();
      allow create, update, delete: if false;
    }
  }
}`;

export const DocsAndSecurityTab: React.FC = () => {
  const [copiedRules, setCopiedRules] = useState(false);

  const handleCopyRules = () => {
    void navigator.clipboard.writeText(PROPOSED_RULES_TEXT);
    setCopiedRules(true);
    setTimeout(() => setCopiedRules(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Section 1: Extracted Data Contract from van-sales-mdm */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
          <Database className="w-5 h-5 text-blue-700" />
          <h3 className="text-base font-bold text-slate-900">
            1. عقد البيانات الفعلي المستخرج من مستودع van-sales-mdm
          </h3>
        </div>

        <p className="text-xs text-slate-600 leading-relaxed">
          تم فحص ملفات المستودع المرفق (<code className="font-mono">README.md</code>،{' '}
          <code className="font-mono">firestore.rules</code>،{' '}
          <code className="font-mono">SyncEngine.java</code>،{' '}
          <code className="font-mono">Policy.java</code>،{' '}
          <code className="font-mono">AppRestrictions.java</code>،{' '}
          <code className="font-mono">MainActivity.java</code>) والتقيد التام بالتحقق الصارم من
          الأنواع (دون تحويل النصوص مثل <code className="font-mono">&quot;false&quot;</code> إلى{' '}
          <code className="font-mono">true</code> ودون تصفير الحقول التالفة بصمت):
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
            <h4 className="font-bold text-slate-900 font-mono" dir="ltr">
              1. enrollments/{'{uid}'}
            </h4>
            <p className="text-slate-600">
              يقرؤه الهاتف عبر <code className="font-mono">Source.SERVER</code> قبل أي مزامنة.
            </p>
            <pre dir="ltr" className="p-2.5 bg-slate-900 text-slate-100 rounded text-[11px] font-mono">
              {`{\n  "approved": true // boolean صريح فقط\n}`}
            </pre>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
            <h4 className="font-bold text-slate-900 font-mono" dir="ltr">
              2. policies/{'{uid}'}
            </h4>
            <p className="text-slate-600">
              يتحقق منه <code className="font-mono">Policy.parse()</code> وقواعد Firestore لجميع
              عناصر <code className="font-mono">blocked_apps</code> حتى الحد الأقصى (50 عنصرًا).
            </p>
            <pre dir="ltr" className="p-2.5 bg-slate-900 text-slate-100 rounded text-[11px] font-mono">
              {`{\n  "schema_version": 1,      // int == 1\n  "revision": 1,            // int >= 1\n  "block_tethering": false, // bool\n  "blocked_apps": []        // string[] (0..50)\n}`}
            </pre>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
            <h4 className="font-bold text-slate-900 font-mono" dir="ltr">
              3. deviceStatus/{'{uid}'}
            </h4>
            <p className="text-slate-600">
              يكتبه الهاتف فقط بعد التحقق من <code className="font-mono">DevicePolicyManager</code>.
            </p>
            <pre
              dir="ltr"
              className="p-2.5 bg-slate-900 text-slate-100 rounded text-[11px] font-mono overflow-x-auto"
            >
              {`{\n  "device_owner": true,         // bool\n  "applied_revision": 1,        // int >= 0\n  "tethering_restricted": true, // bool\n  "last_seen": SERVER_TIME,     // timestamp\n  "model": "TECNO POVA 5",      // string <= 200\n  "android_sdk": 33,            // int\n  "battery_percent": 70,        // int\n  "error": "",                  // string <= 1000\n  "agent_version": "0.1.0-pilot"// string <= 40\n}`}
            </pre>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
            <h4 className="font-bold text-slate-900 font-mono" dir="ltr">
              4. admins/{'{ADMIN_AUTH_UID}'}
            </h4>
            <p className="text-slate-600">
              تُنشأ يدويًا من مالك المشروع في Firebase Console بمعرّف حساب المسؤول في Authentication
              (وليس UID الهاتف):
            </p>
            <pre
              dir="ltr"
              className="p-2.5 bg-slate-900 text-slate-100 rounded text-[11px] font-mono overflow-x-auto"
            >
              {`// admins/{ADMIN_AUTH_UID}\n{\n  "active": true,\n  "email": "mashhoor.info@gmail.com"\n}`}
            </pre>
          </div>
        </div>
      </div>

      {/* Section 2: Proposed Firestore Rules */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-700" />
            <h3 className="text-base font-bold text-slate-900">
              2. قواعد Firestore المحلية المحدثة (firestore.rules) — يجب نشرها في Console
            </h3>
          </div>
          <button
            type="button"
            onClick={handleCopyRules}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
          >
            {copiedRules ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedRules ? 'تم نسخ القواعد' : 'نسخ firestore.rules'}</span>
          </button>
        </div>

        <p className="text-xs text-slate-600 leading-relaxed">
          <strong>تنبيه مهم:</strong> القواعد أدناه محفوظة محليًا في ملف{' '}
          <code className="font-mono">firestore.rules</code> ولم يتم نشرها تلقائيًا على الإنتاج. يجب
          نسخها ولصقها في <strong>Firebase Console → Firestore Database → Rules → Publish</strong>{' '}
          حتى تعمل آلية <code className="font-mono">admins/{'{uid}'}</code> وصلاحيات لوحة الإدارة.
        </p>

        <pre
          dir="ltr"
          className="p-4 bg-slate-900 text-slate-100 rounded-xl text-[11px] font-mono overflow-x-auto max-h-96 leading-relaxed"
        >
          {PROPOSED_RULES_TEXT}
        </pre>

        <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-xs">
          <div className="font-bold text-slate-900 flex items-center gap-2">
            <Terminal className="w-4 h-4 text-slate-700" />
            <span>تشغيل اختبارات المحاكي (Firestore Emulator Tests):</span>
          </div>
          <pre dir="ltr" className="p-2.5 bg-slate-900 text-slate-100 rounded text-[11px] font-mono">
            {`firebase emulators:exec --only firestore "node --test tests/rules.test.mjs"`}
          </pre>
        </div>
      </div>

      {/* Section 3: Vercel Deployment Instructions */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
          <Rocket className="w-5 h-5 text-blue-700" />
          <h3 className="text-base font-bold text-slate-900">
            3. تعليمات النشر على Vercel وإعداد النطاقات المعتمدة
          </h3>
        </div>

        <ol className="list-decimal list-inside space-y-2 text-xs text-slate-700 leading-relaxed">
          <li>
            ارفع المستودع إلى GitHub (مع التأكد من عدم رفع أي ملف <code className="font-mono">.env</code>{' '}
            أو مفاتيح Service Account).
          </li>
          <li>
            في <span className="font-semibold text-slate-900">Vercel</span> اختر{' '}
            <span className="font-semibold">Add New Project</span> واستورد المستودع (
            <code className="font-mono">Framework: Vite</code>،{' '}
            <code className="font-mono">Build: npm run build</code>،{' '}
            <code className="font-mono">Output: dist</code>).
          </li>
          <li>
            أضف متغيرات <code className="font-mono">VITE_FIREBASE_*</code> في Environment Variables
            داخل Vercel.
          </li>
          <li>
            أضف نطاق Vercel النهائي في{' '}
            <span className="font-semibold text-slate-900">
              Firebase Console → Authentication → Settings → Authorized domains
            </span>
            .
          </li>
        </ol>
      </div>

      {/* Section 4: Clear Report */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <h3 className="text-sm font-bold text-emerald-900 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>ما تم تنفيذه وإصلاحه في الكود</span>
          </h3>
          <ul className="list-disc list-inside space-y-1.5 text-xs text-slate-700 leading-relaxed">
            <li>
              إضافة زر «إرسال رسالة تأكيد البريد» (<code className="font-mono">sendEmailVerification</code>)
              وزر «أكدت بريدي — تحقق الآن» (<code className="font-mono">reload</code> + تجديد
              التوكن + إعادة تقييم الصلاحية).
            </li>
            <li>
              تشخيص دقيق لوثيقة <code className="font-mono">admins/{'{uid}'}</code> عبر{' '}
              <code className="font-mono">getDocFromServer</code> يميز بين عدم وجود الوثيقة، و
              <code className="font-mono">permission-denied</code>، وانقطاع الشبكة، وعدم توثيق
              البريد.
            </li>
            <li>
              إعادة تهيئة خدمات Firebase فعليًا عند تغيير الإعدادات وإزالة قراءة{' '}
              <code className="font-mono">test/connection</code>.
            </li>
            <li>
              التحقق الصارم من الأنواع دون <code className="font-mono">Boolean(value)</code>، وكشف
              تعارض التعديل المتزامن بين المسؤولين، وفحص جميع الـ 50 عنصرًا في{' '}
              <code className="font-mono">blocked_apps</code> داخل <code className="font-mono">firestore.rules</code>.
            </li>
          </ul>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <h3 className="text-sm font-bold text-amber-900 flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-600" />
            <span>الإجراءات اليدوية المطلوبة منك في Firebase Console</span>
          </h3>
          <ul className="list-disc list-inside space-y-1.5 text-xs text-slate-700 leading-relaxed">
            <li>
              <strong>نشر القواعد:</strong> نسخ محتوى <code className="font-mono">firestore.rules</code>{' '}
              ونشره في Firebase Console لمشروع <code className="font-mono">vansales-mdm</code>.
            </li>
            <li>
              <strong>تأكيد البريد الإلكتروني:</strong> الضغط على «إرسال رسالة تأكيد البريد» من
              الشاشة وتفعيل الرابط المرسل إلى <code className="font-mono">mashhoor.info@gmail.com</code>.
            </li>
            <li>
              <strong>إنشاء وثيقة المسؤول:</strong> إنشاء المستند{' '}
              <code className="font-mono">admins/{'{ADMIN_AUTH_UID}'}</code> في Firestore بالحقلين{' '}
              <code className="font-mono">active: true</code> (boolean) و{' '}
              <code className="font-mono">email: &quot;mashhoor.info@gmail.com&quot;</code>.
            </li>
            <li>
              <strong>حدود سجل التدقيق الحالية:</strong> القواعد تمنع تعديل أو حذف{' '}
              <code className="font-mono">auditLogs</code>، لكنها لا تُلزم كل كتابة إدارية خارج
              الواجهة بإنشاء سجل مقابل (يتطلب ذلك Cloud Functions لتدقيق خادمي كامل).
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
};
