import React, { useState } from 'react';
import {
  Settings,
  ShieldCheck,
  FileCode2,
  Database,
  Layers,
  BookOpen,
} from 'lucide-react';
import type { ConfigResolution } from '../services/firebaseClient';
import { FirebaseSetupView } from './FirebaseSetupView';
import { DocsAndSecurityTab } from './DocsAndSecurityTab';

interface SettingsTabProps {
  resolution: ConfigResolution;
  onConfigSaved: () => void;
}

type SettingsSubTab = 'firebase' | 'security' | 'inventory_spec';

export const SettingsTab: React.FC<SettingsTabProps> = ({
  resolution,
  onConfigSaved,
}) => {
  const [subTab, setSubTab] = useState<SettingsSubTab>('firebase');

  return (
    <div className="space-y-6">
      {/* Sub-tabs Navigation */}
      <div className="bg-white border border-slate-200 rounded-xl p-2 flex flex-wrap items-center gap-2 text-xs font-bold">
        <button
          type="button"
          onClick={() => setSubTab('firebase')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg transition-colors whitespace-nowrap ${
            subTab === 'firebase'
              ? 'bg-blue-700 text-white'
              : 'text-slate-700 hover:bg-slate-100'
          }`}
        >
          <Database className="w-4 h-4" />
          <span>إعدادات اتصال Firebase</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('security')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg transition-colors whitespace-nowrap ${
            subTab === 'security'
              ? 'bg-blue-700 text-white'
              : 'text-slate-700 hover:bg-slate-100'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>العقد وقواعد الأمان (Firestore Rules)</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('inventory_spec')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg transition-colors whitespace-nowrap ${
            subTab === 'inventory_spec'
              ? 'bg-blue-700 text-white'
              : 'text-slate-700 hover:bg-slate-100'
          }`}
        >
          <Layers className="w-4 h-4" />
          <span>مواصفات جرد التطبيقات (وكيل 0.3.1+)</span>
        </button>
      </div>

      {/* Sub-tab 1: Firebase Configuration */}
      {subTab === 'firebase' && (
        <FirebaseSetupView
          resolution={resolution}
          onConfigSaved={onConfigSaved}
          onNavigateDocs={() => setSubTab('security')}
        />
      )}

      {/* Sub-tab 2: Security & Deployment Docs */}
      {subTab === 'security' && <DocsAndSecurityTab />}

      {/* Sub-tab 3: App Inventory Specification for Android 0.3.1 */}
      {subTab === 'inventory_spec' && (
        <div className="space-y-6 text-xs text-slate-800 leading-relaxed">
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <span className="p-2 bg-blue-50 text-blue-800 rounded-lg shrink-0">
                <FileCode2 className="w-6 h-6" />
              </span>
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  مواصفات امتداد جرد التطبيقات (App Inventory Specification v1)
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  امتداد منفصل ومحدد الإصدار بعيدًا عن <code className="font-mono">policies</code> و{' '}
                  <code className="font-mono">deviceStatus</code>، مصمم لوكيل أندرويد 0.3.1+ الداعم لـ FCM.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                <h4 className="font-bold text-slate-900 text-sm">مسار التخزين وصلاحيات الأمان</h4>
                <p>
                  المجموعة: <code className="font-mono font-bold">deviceAppInventory/{'{uid}'}</code>
                </p>
                <p>
                  أو الدفعات: <code className="font-mono font-bold">deviceAppInventory/{'{uid}'}/batches/{'{batchId}'}</code>
                </p>
                <ul className="list-disc list-inside space-y-1 text-slate-600 text-[11px] pt-1">
                  <li>الجهاز المعتمد (<code className="font-mono">approved(uid)</code>) يكتب جرده الخاص فقط.</li>
                  <li>لا يستطيع الجهاز الكتابة لجهاز آخر أو اعتماد نفسه.</li>
                  <li>المسؤول المصرح له (<code className="font-mono">isAdmin()</code>) يملك صلاحية القراءة فقط.</li>
                  <li>الحذف وتعديل سجلات الأجهزة الأخرى ممنوعان بالقواعد.</li>
                </ul>
              </div>

              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                <h4 className="font-bold text-slate-900 text-sm">حقول وثيقة الجرد والأنواع</h4>
                <ul className="list-disc list-inside space-y-1 text-slate-600 text-[11px]">
                  <li><code className="font-mono">schema_version</code>: عدد صحيح (1).</li>
                  <li><code className="font-mono">batch_id</code>: نص معرّف دفعة الجرد (UUID).</li>
                  <li><code className="font-mono">batch_index</code>: رقم الدفعة يبدأ من 0.</li>
                  <li><code className="font-mono">total_batches</code>: إجمالي الدفعات.</li>
                  <li><code className="font-mono">reported_at</code>: طابع زمني لخادم Firebase.</li>
                  <li><code className="font-mono">agent_version</code>: نص إصدار الوكيل (0.3.1+).</li>
                  <li><code className="font-mono">apps</code>: مصفوفة كائنات التطبيقات (بحد أقصى 70 تطبيقاً للدفعة لمنع تجاوز حجم الوثيقة 1MB).</li>
                </ul>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
              <h4 className="font-bold text-slate-900 text-sm">حقول كل تطبيق في مصفوفة apps:</h4>
              <pre className="p-3 bg-slate-900 text-slate-100 rounded-lg font-mono text-[11px] overflow-x-auto" dir="ltr">
{`{
  "package_name": "com.zhiliaoapp.musically",       // String (مطلوب)
  "app_name": "تيك توك",                             // String (الاسم المعروض)
  "has_launcher_icon": true,                        // Boolean (له أيقونة تشغيل)
  "is_system_app": false,                           // Boolean (FLAG_SYSTEM)
  "is_protected": false,                            // Boolean (محمي من الحظر)
  "protection_reason": "",                          // String (اختياري عند الحماية)
  "is_hidden_by_agent": false                       // Boolean (مخفي بواسطة الوكيل)
}`}
              </pre>
            </div>

            <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-2 text-blue-950">
              <h4 className="font-bold text-sm">توقيت وإرسال الجرد في وكيل أندرويد 0.3.1+:</h4>
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li>يُجمع الجرد عند أول اعتماد، وعند ورود رسالة FCM مخصصة، وبعد تطبيق سياسة حظر بنجاح.</li>
                <li>يتم دمج الأحداث ومنع حلقات المزامنة عبر JobScheduler أو WorkManager.</li>
                <li>فشل رفع الجرد لا يمنع تطبيق السياسة أو إرسال تقرير الحالة الأساسي (<code className="font-mono">deviceStatus</code>).</li>
                <li>تستخدم استعلامات <code className="font-mono">PackageManager.getInstalledApplications</code> مع فئة <code className="font-mono">&lt;queries&gt;</code> المناسبة في Manifest.</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
