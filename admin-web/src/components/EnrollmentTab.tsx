import React, { useState } from 'react';
import {
  UserCheck,
  AlertTriangle,
  CheckCircle2,
  Sliders,
  PlusCircle,
  Ban,
} from 'lucide-react';
import type { MergedDeviceRecord } from '../types/mdm';
import { sanitizeManualUid } from '../utils/validation';
import { ApprovalBadge } from './StatusBadges';

interface EnrollmentTabProps {
  devices: MergedDeviceRecord[];
  onApproveDevice: (
    uid: string,
    approved: boolean,
    optionalMetadata?: { device_name: string; rep_name: string }
  ) => Promise<void>;
  onOpenPolicy: (uid: string) => void;
}

export const EnrollmentTab: React.FC<EnrollmentTabProps> = ({
  devices,
  onApproveDevice,
  onOpenPolicy,
}) => {
  const [manualUid, setManualUid] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [repName, setRepName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
    uid?: string;
  } | null>(null);
  const [rowBusyUid, setRowBusyUid] = useState<string | null>(null);

  const pendingDevices = devices.filter((d) => d.approvalState !== 'approved');
  const approvedDevices = devices.filter((d) => d.approvalState === 'approved');

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    // Requirement 4: "عند إدخال UID يدويًا استخدم النص كما هو مع إزالة الفراغات الطرفية فقط؛ لا تغير حالة الأحرف."
    const sanitized = sanitizeManualUid(manualUid);
    if (!sanitized.valid) {
      setFeedback({ type: 'error', message: sanitized.error || 'معرّف UID غير صالح.' });
      return;
    }

    setSubmitting(true);
    try {
      await onApproveDevice(sanitized.uid, true, {
        device_name: deviceName,
        rep_name: repName,
      });
      setFeedback({
        type: 'success',
        message: `تم اعتماد الجهاز (${sanitized.uid}) وتحديث enrollments/${sanitized.uid}.approved = true بنجاح. يمكنك الآن إنشاء أو مراجعة سياسته.`,
        uid: sanitized.uid,
      });
      setManualUid('');
      setDeviceName('');
      setRepName('');
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRowApproval = async (uid: string, approved: boolean) => {
    setRowBusyUid(uid);
    setFeedback(null);
    try {
      await onApproveDevice(uid, approved);
      setFeedback({
        type: 'success',
        message: approved
          ? `تم اعتماد الجهاز (${uid}) في enrollments/${uid}.`
          : `تم إلغاء اعتماد الجهاز (${uid}). ملاحظة: القيود المطبقة مسبقًا على الهاتف تبقى سارية ولا تفك تلقائيًا.`,
        uid: approved ? uid : undefined,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRowBusyUid(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Important Security & Operational Warning about Revoking Approval */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
        <div className="text-xs text-amber-950 space-y-1 leading-relaxed">
          <p className="font-bold">
            ضوابط الاعتماد وإلغاء الاعتماد في وكيل Android (SyncEngine.java &amp; firestore.rules)
          </p>
          <ul className="list-disc list-inside space-y-0.5 text-amber-900">
            <li>
              يسجّل تطبيق Android بهوية <code className="font-mono">Anonymous</code> منفصلة ويعرض{' '}
              <code className="font-mono">UID</code> على شاشة الهاتف لنسخه. لا يُسمح للجهاز باعتماد
              نفسه.
            </li>
            <li>
              لا يتم اعتماد أي جهاز تلقائيًا؛ يجب على المسؤول اعتماد كل جهاز بشكل فردي بتحديث{' '}
              <code className="font-mono">enrollments/{'{uid}'}.approved = true</code>.
            </li>
            <li>
              <strong>تحذير هام:</strong> إلغاء الاعتماد (<code className="font-mono">approved = false</code>)
              يمنع الجهاز من قراءة السياسات أو إرسال حالته للخادم، لكنه{' '}
              <strong>لا يزيل صلاحية Device Owner ولا يفك القيود المطبقة على الهاتف</strong>. لفك
              منع مشاركة الإنترنت أو إظهار التطبيقات المخفية، يجب أن يكون الجهاز معتمدًا ومتصلًا،
              ثم إرسال سياسة جديدة بإصدار (<code className="font-mono">revision</code>) أعلى.
            </li>
          </ul>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-4 rounded-xl border text-xs font-medium flex flex-wrap items-center justify-between gap-4 ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          <span>{feedback.message}</span>
          {feedback.uid && (
            <button
              type="button"
              onClick={() => onOpenPolicy(feedback.uid!)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors"
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>الانتقال لسياسة الجهاز ({feedback.uid})</span>
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Manual UID Approval Form */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="border-b border-slate-200 pb-3">
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <PlusCircle className="w-4 h-4 text-blue-700" />
              <span>اعتماد جهاز محدد بمعرّف UID</span>
            </h3>
            <p className="text-xs text-slate-600 mt-1">
              انسخ <code className="font-mono">UID</code> من شاشة تطبيق «إنجاز» على هاتف المندوب
              وألصقه كما هو (تُزال الفراغات الطرفية فقط دون تغيير حالة الأحرف الكبيرة أو الصغيرة).
            </p>
          </div>

          <form onSubmit={(e) => void handleManualSubmit(e)} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                معرّف تسجيل الجهاز (Device UID) *
              </label>
              <input
                dir="ltr"
                type="text"
                required
                value={manualUid}
                onChange={(e) => setManualUid(e.target.value)}
                placeholder="مثال: 7kP9xLm2..."
                className="w-full px-3.5 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              {manualUid && (
                <p className="text-[11px] font-mono text-slate-500 mt-1" dir="ltr">
                  UID المطبق حرفيًا: &quot;{manualUid.trim()}&quot;
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                الاسم الإداري للجهاز (اختياري — يُحفظ في deviceMetadata)
              </label>
              <input
                type="text"
                maxLength={120}
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="مثال: جهاز المبيعات 04 — POVA 5"
                className="w-full px-3.5 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                اسم المندوب (اختياري — يُحفظ في deviceMetadata)
              </label>
              <input
                type="text"
                maxLength={120}
                value={repName}
                onChange={(e) => setRepName(e.target.value)}
                placeholder="مثال: خالد الدوسري"
                className="w-full px-3.5 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg transition-colors"
            >
              <UserCheck className="w-4 h-4" />
              <span>
                {submitting
                  ? 'جارٍ اعتماد الجهاز...'
                  : 'اعتماد الجهاز وتعيين enrollments/{uid}.approved = true'}
              </span>
            </button>
          </form>
        </div>

        {/* Pending Requests & Existing Enrollments List */}
        <div className="lg:col-span-7 space-y-6">
          {/* Pending Approval Requests */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  طلبات التسجيل والأجهزة غير المعتمدة ({pendingDevices.length})
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  الأجهزة التي وُجد لها سجل بانتظار الاعتماد (<code className="font-mono">approved = false</code>)
                  أو ظهرت في مجموعات أخرى دون اعتماد.
                </p>
              </div>
            </div>

            {pendingDevices.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                لا توجد طلبات معلقة حاليًا. لاعتماد هاتف جديد، انسخ UID من شاشة تطبيق المندوب وأدخله
                في النموذج المجاور.
              </div>
            ) : (
              <div className="divide-y divide-slate-200">
                {pendingDevices.map((item) => (
                  <div
                    key={item.uid}
                    className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <code
                          dir="ltr"
                          className="font-mono text-xs font-bold text-slate-900 bg-slate-100 px-2 py-0.5 rounded"
                        >
                          {item.uid}
                        </code>
                        <ApprovalBadge state={item.approvalState} />
                      </div>
                      <div className="text-xs text-slate-600">
                        {item.metadata?.device_name || item.status?.model || 'بدون اسم إداري'} ·{' '}
                        {item.metadata?.rep_name ? `المندوب: ${item.metadata.rep_name}` : 'بدون مندوب'}
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={rowBusyUid === item.uid}
                      onClick={() => void handleRowApproval(item.uid, true)}
                      className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      <span>اعتماد هذا الجهاز</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Currently Approved Devices Summary */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200">
              <h3 className="text-sm font-bold text-slate-900">
                الأجهزة المعتمدة حاليًا ({approvedDevices.length})
              </h3>
            </div>

            {approvedDevices.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                لا توجد أجهزة معتمدة بعد.
              </div>
            ) : (
              <div className="divide-y divide-slate-200 max-h-80 overflow-y-auto">
                {approvedDevices.map((item) => (
                  <div
                    key={item.uid}
                    className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <code
                          dir="ltr"
                          className="font-mono text-xs font-semibold text-slate-900 bg-slate-100 px-2 py-0.5 rounded"
                        >
                          {item.uid}
                        </code>
                        <ApprovalBadge state={item.approvalState} />
                      </div>
                      <div className="text-xs text-slate-600">
                        {item.metadata?.device_name || item.status?.model || 'بدون اسم إداري'} ·{' '}
                        {item.metadata?.rep_name ? `المندوب: ${item.metadata.rep_name}` : 'بدون مندوب'}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onOpenPolicy(item.uid)}
                        className="px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                      >
                        سياسة الجهاز
                      </button>
                      <button
                        type="button"
                        disabled={rowBusyUid === item.uid}
                        onClick={() => void handleRowApproval(item.uid, false)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors disabled:opacity-50"
                      >
                        <Ban className="w-3.5 h-3.5" />
                        <span>إلغاء الاعتماد</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
