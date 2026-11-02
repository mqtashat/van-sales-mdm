import React from 'react';
import { ShieldCheck, Lock, FileText, AlertTriangle } from 'lucide-react';
import type { AuditActionType, AuditLogDoc } from '../types/mdm';
import { formatTimestampAr } from '../utils/validation';

interface AuditLogTabProps {
  logs: AuditLogDoc[];
  onSelectDevice: (uid: string) => void;
}

const ACTION_LABELS: Record<AuditActionType, { label: string; colorClass: string }> = {
  approve_device: {
    label: 'اعتماد جهاز',
    colorClass: 'text-emerald-800 bg-emerald-50 border-emerald-200',
  },
  revoke_approval: {
    label: 'إلغاء اعتماد جهاز',
    colorClass: 'text-amber-800 bg-amber-50 border-amber-200',
  },
  create_policy: {
    label: 'إنشاء سياسة أولى',
    colorClass: 'text-blue-800 bg-blue-50 border-blue-200',
  },
  update_policy: {
    label: 'تحديث سياسة جهاز',
    colorClass: 'text-indigo-800 bg-indigo-50 border-indigo-200',
  },
  update_metadata: {
    label: 'تعديل اسم الجهاز/المندوب',
    colorClass: 'text-slate-800 bg-slate-100 border-slate-200',
  },
};

export const AuditLogTab: React.FC<AuditLogTabProps> = ({ logs, onSelectDevice }) => {
  return (
    <div className="space-y-6">
      {/* Accurate Architectural Disclosure on Audit Log Security & Client Boundaries */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
        <div className="flex items-start gap-3">
          <Lock className="w-5 h-5 text-blue-700 shrink-0 mt-0.5" />
          <div className="space-y-1.5 text-xs text-slate-700 leading-relaxed">
            <h3 className="text-sm font-bold text-slate-900">
              سجل الإجراءات الإدارية (auditLogs) — الحماية وحدود الضمان الحالية
            </h3>
            <p>
              تكتب هذه اللوحة سجل تدقيق في مجموعة{' '}
              <code className="font-mono">auditLogs/{'{logId}'}</code> ضمن نفس المعاملة (
              <code className="font-mono">runTransaction</code>) عند تنفيذ أي إجراء من داخل الواجهة.
            </p>
            <ul className="list-disc list-inside space-y-1 text-slate-600">
              <li>
                <strong>ما تحميه القواعد الحالية:</strong> تمنع قواعد{' '}
                <code className="font-mono">firestore.rules</code> أجهزة Android والمستخدمين غير
                المصرحين من قراءة أو كتابة السجل، وتمنع أي تعديل أو حذف للسجلات المكتوبة (
                <code className="font-mono">allow update, delete: if false;</code>)، وتلزم عند
                إنشاء سجل بتطابق <code className="font-mono">actor_uid == request.auth.uid</code> و
                <code className="font-mono">actor_email == request.auth.token.email</code> و
                <code className="font-mono">created_at == request.time</code>.
              </li>
              <li className="text-amber-900 font-medium">
                <strong>الحد الأمني الذي يجب الانتباه إليه:</strong> السجل الحالي{' '}
                <strong>ليس شاملًا بشكل غير قابل للتجاوز على مستوى القواعد</strong>؛ فالقواعد على{' '}
                <code className="font-mono">enrollments</code> و{' '}
                <code className="font-mono">policies</code> و{' '}
                <code className="font-mono">deviceMetadata</code> لا تُلزم كل كتابة إدارية بإنشاء
                وثيقة سجل مقابلة. أي أن مسؤولًا يملك صلاحية <code className="font-mono">isAdmin()</code>{' '}
                ويمكنه استدعاء Firestore SDK مباشرة من خارج واجهة اللوحة يستطيع تعديل سياسة دون
                إرسال كتابة إلى <code className="font-mono">auditLogs</code>.
              </li>
              <li>
                <strong>الحل المقترح لتدقيق إلزامي كامل:</strong> استخدام{' '}
                <strong>Cloud Functions (onDocumentWritten)</strong> في بيئة خادم موثوقة لتسجيل كل
                تغيير تلقائيًا مع قفل كتابة العميل على <code className="font-mono">auditLogs</code>{' '}
                نهائيًا.
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* Audit Logs Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-slate-600" />
            <h3 className="text-sm font-bold text-slate-900">
              أحدث الإجراءات المسجلة ({logs.length})
            </h3>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
              <span>محمي من الحذف والتعديل</span>
            </span>
            <span className="inline-flex items-center gap-1 text-amber-700">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>يُسجّل عبر معاملات الواجهة</span>
            </span>
          </div>
        </div>

        {logs.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            لا توجد إجراءات مسجلة في <code className="font-mono">auditLogs</code> حتى الآن. ستظهر
            جميع عمليات الاعتماد وتعديل السياسات المنفذة من اللوحة هنا.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                  <th className="py-3 px-4">الوقت (Server Time)</th>
                  <th className="py-3 px-4">المسؤول المنفذ</th>
                  <th className="py-3 px-4">نوع الإجراء</th>
                  <th className="py-3 px-4">الجهاز المستهدف (UID)</th>
                  <th className="py-3 px-4">ملخص التغيير</th>
                  <th className="py-3 px-4">قبل / بعد (JSON)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs align-top">
                {logs.map((log) => {
                  const createdMs =
                    log.created_at && typeof log.created_at.toMillis === 'function'
                      ? log.created_at.toMillis()
                      : null;
                  const timeInfo = formatTimestampAr(createdMs);
                  const badgeInfo = ACTION_LABELS[log.action] || {
                    label: log.action,
                    colorClass: 'text-slate-800 bg-slate-100 border-slate-200',
                  };

                  return (
                    <tr key={log.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-3.5 px-4 whitespace-nowrap font-mono tabular-nums">
                        <div className="font-semibold text-slate-900">{timeInfo.relative}</div>
                        <div className="text-[10px] text-slate-500">{timeInfo.formatted}</div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-slate-900 font-mono text-[11px]">
                          {log.actor_email || 'غير معروف'}
                        </div>
                        <div className="text-[10px] font-mono text-slate-500">
                          UID: {log.actor_uid}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-md border text-[11px] font-semibold ${badgeInfo.colorClass}`}
                        >
                          {badgeInfo.label}
                        </span>
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => onSelectDevice(log.target_uid)}
                          className="font-mono text-[11px] font-bold text-blue-700 hover:underline bg-blue-50 px-2 py-0.5 rounded"
                          dir="ltr"
                        >
                          {log.target_uid}
                        </button>
                      </td>

                      <td className="py-3.5 px-4 max-w-xs leading-relaxed text-slate-800">
                        {log.summary}
                      </td>

                      <td className="py-3.5 px-4 min-w-[240px]">
                        <details className="text-[11px]">
                          <summary className="cursor-pointer font-semibold text-slate-600 hover:text-slate-900">
                            عرض الفروقات (قبل ← بعد)
                          </summary>
                          <div
                            dir="ltr"
                            className="mt-1.5 p-2.5 bg-slate-900 text-slate-100 rounded-md font-mono text-[10px] space-y-1.5 overflow-x-auto"
                          >
                            <div>
                              <span className="text-amber-300">Before: </span>
                              {JSON.stringify(log.before)}
                            </div>
                            <div>
                              <span className="text-emerald-300">After: </span>
                              {JSON.stringify(log.after)}
                            </div>
                          </div>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
