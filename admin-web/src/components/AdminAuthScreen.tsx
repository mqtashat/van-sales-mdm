import React, { useState } from 'react';
import {
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  type Auth,
} from 'firebase/auth';
import {
  ShieldCheck,
  LogIn,
  RefreshCw,
  LogOut,
  Copy,
  Check,
  CheckCircle2,
  XCircle,
  Mail,
  AlertTriangle,
  Database,
  ChevronDown,
} from 'lucide-react';
import type { AdminDocCheckStatus, AdminIdentity } from '../types/mdm';
import { sendVerificationEmailAr } from '../services/mdmService';

interface AdminAuthScreenProps {
  auth: Auth;
  adminIdentity: AdminIdentity | null;
  authLoading: boolean;
  onReloadAndVerify: () => Promise<void>;
  onOpenDocs: () => void;
  onOpenFirebaseSetup: () => void;
}

function renderAdminDocStatusBadge(
  hasCustomClaim: boolean,
  status: AdminDocCheckStatus
) {
  if (hasCustomClaim) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-md">
        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
        <span>مصرح عبر Custom Claim (admin = true)</span>
      </span>
    );
  }

  switch (status) {
    case 'granted':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-md">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>مصرح عبر وثيقة admins/{'{uid}'}</span>
        </span>
      );
    case 'not_checked_unverified_email':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-md">
          <AlertTriangle className="w-4 h-4 text-slate-500 shrink-0" />
          <span>لم يُجرَ الفحص بعد (بانتظار توثيق البريد أولًا)</span>
        </span>
      );
    case 'missing_or_inactive':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-900 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-md">
          <XCircle className="w-4 h-4 text-amber-600 shrink-0" />
          <span>الوثيقة غير موجودة أو غير فعالة في admins/{'{uid}'}</span>
        </span>
      );
    case 'permission_denied':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-800 bg-red-50 border border-red-200 px-2.5 py-1 rounded-md">
          <XCircle className="w-4 h-4 text-red-600 shrink-0" />
          <span>رُفض الوصول (permission-denied — القواعد لم تُنشر بعد)</span>
        </span>
      );
    case 'network_or_unavailable':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-800 bg-red-50 border border-red-200 px-2.5 py-1 rounded-md">
          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
          <span>تعذر الاتصال بالخادم أثناء الفحص</span>
        </span>
      );
  }
}

export const AdminAuthScreen: React.FC<AdminAuthScreenProps> = ({
  auth,
  adminIdentity,
  authLoading,
  onReloadAndVerify,
  onOpenDocs,
  onOpenFirebaseSetup,
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Email verification & reload states
  const [sendingVerification, setSendingVerification] = useState(false);
  const [verificationFeedback, setVerificationFeedback] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [verifyingNow, setVerifyingNow] = useState(false);
  const [verifyFeedback, setVerifyFeedback] = useState<string | null>(null);

  // Copy states
  const [copiedUid, setCopiedUid] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [copiedScript, setCopiedScript] = useState(false);

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      if (
        code === 'auth/invalid-credential' ||
        code === 'auth/wrong-password' ||
        code === 'auth/user-not-found'
      ) {
        setErrorMsg('البريد الإلكتروني أو كلمة المرور غير صحيحة.');
      } else if (code === 'auth/operation-not-allowed') {
        setErrorMsg(
          'تسجيل الدخول بالبريد وكلمة المرور غير مفعّل في Firebase Console (Authentication → Sign-in method).'
        );
      } else if (code === 'auth/too-many-requests') {
        setErrorMsg('تم حظر المحاولات مؤقتًا بسبب تكرار الفشل. يرجى الانتظار قليلًا.');
      } else {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(auth, provider);
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/popup-closed-by-user') {
        setErrorMsg('تم إغلاق نافذة تسجيل الدخول قبل إتمام العملية.');
      } else if (code === 'auth/unauthorized-domain') {
        setErrorMsg(
          'هذا النطاق (Domain) غير مضاف في القائمة المعتمدة داخل Firebase Console → Authentication → Settings → Authorized domains.'
        );
      } else {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendVerificationEmail = async () => {
    if (!auth.currentUser || sendingVerification) return;
    setSendingVerification(true);
    setVerificationFeedback(null);
    setVerifyFeedback(null);
    try {
      const result = await sendVerificationEmailAr(auth.currentUser);
      setVerificationFeedback(result);
    } finally {
      setSendingVerification(false);
    }
  };

  const handleReloadAndCheck = async () => {
    if (verifyingNow) return;
    setVerifyingNow(true);
    setVerifyFeedback(null);
    try {
      await onReloadAndVerify();
      setVerifyFeedback(
        'تم إعادة تحميل حالة الحساب وتجديد الرمز (ID Token) وإعادة فحص الصلاحية من الخادم.'
      );
    } catch (err) {
      setVerifyFeedback(
        `تعذر التحقق من الخادم: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setVerifyingNow(false);
    }
  };

  if (authLoading) {
    return (
      <div className="max-w-lg mx-auto my-12 bg-white border border-slate-200 rounded-xl p-8 text-center space-y-3">
        <div className="w-8 h-8 border-2 border-blue-700 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-sm font-semibold text-slate-800">
          جارٍ التحقق من جلسة المسؤول وصلاحيات Firebase...
        </p>
      </div>
    );
  }

  // Case 1: User is signed in, but lacks verified administrator privilege
  if (adminIdentity && !adminIdentity.isAuthorizedAdmin) {
    const adminEmailDisplay = adminIdentity.email || 'mashhoor.info@gmail.com';
    const adminDocPath = `admins/${adminIdentity.uid}`;

    // Note: No emailVerified=true via Admin SDK per requirement 1
    const adminSdkSnippet = `// بديل سطر الأوامر (يُشغّل من جهاز المسؤول الموثوق فقط — لا ترفع Service Account للويب)
// يحافظ على أي Custom Claims أخرى ويضبط admin: true فقط دون تعديل emailVerified
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

initializeApp({ credential: applicationDefault(), projectId: 'vansales-mdm' });

const auth = getAuth();
const user = await auth.getUser('${adminIdentity.uid}');
const existingClaims = user.customClaims || {};
await auth.setCustomUserClaims('${adminIdentity.uid}', { ...existingClaims, admin: true });
console.log('Granted custom claim admin=true to ${adminEmailDisplay}');`;

    return (
      <div className="max-w-3xl mx-auto my-6 bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 mb-1">
              <ShieldCheck className="w-4 h-4" />
              <span>إعداد وصول المسؤول الأول — مشروع vansales-mdm</span>
            </span>
            <h2 className="text-xl font-bold text-slate-900">
              أكمل الخطوات الثلاث لفتح لوحة الإدارة
            </h2>
            <p className="text-xs text-slate-600 mt-1">
              تم تسجيل دخولك بنجاح بحساب مسمى، ويتبقى تأكيد البريد الإلكتروني واعتماد حساب المسؤول
              في Firebase Console.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void signOut(auth)}
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>تسجيل الخروج</span>
          </button>
        </div>

        {/* Account Identity Bar (Clear, readable font) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-1">
            <span className="text-xs font-semibold text-slate-500">
              البريد الإلكتروني لحساب المسؤول الحالي
            </span>
            <p
              dir="ltr"
              className="text-sm font-mono font-bold text-slate-900 break-all"
            >
              {adminIdentity.email}
            </p>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-500">
                معرّف حساب المسؤول (Admin Auth UID)
              </span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(adminIdentity.uid);
                  setCopiedUid(true);
                  setTimeout(() => setCopiedUid(false), 2000);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-md transition-colors"
              >
                {copiedUid ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    <span className="text-emerald-700">تم نسخ UID</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>نسخ UID المسؤول</span>
                  </>
                )}
              </button>
            </div>
            <p
              dir="ltr"
              className="text-sm font-mono font-bold text-slate-900 select-all break-all"
            >
              {adminIdentity.uid}
            </p>
            <p className="text-[11px] text-slate-500">
              تنبيه: هذا هو معرّف حسابك في Authentication، وليس UID هاتف التجربة (Android).
            </p>
          </div>
        </div>

        {/* Step-by-Step Practical Workflow */}
        <div className="space-y-4">
          {/* STEP 1: Verify Email */}
          <div
            className={`p-5 rounded-xl border space-y-3 ${
              adminIdentity.emailVerified
                ? 'bg-emerald-50/50 border-emerald-200'
                : 'bg-white border-slate-300'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-slate-900 text-white text-xs flex items-center justify-center font-mono">
                  1
                </span>
                <span>الخطوة الأولى: تأكيد البريد الإلكتروني</span>
              </h3>
              {adminIdentity.emailVerified ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800 bg-emerald-100 px-2.5 py-1 rounded-md">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>البريد موثق (email_verified = true)</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-800 bg-amber-100 px-2.5 py-1 rounded-md">
                  <XCircle className="w-4 h-4 text-amber-600" />
                  <span>البريد غير موثق بعد</span>
                </span>
              )}
            </div>

            {!adminIdentity.emailVerified ? (
              <div className="space-y-3">
                <p className="text-xs text-slate-700 leading-relaxed">
                  تشترط قواعد الأمان توثيق بريدك الإلكتروني أولًا. اضغط زر «إرسال رسالة تأكيد
                  البريد»، ثم افتح الرسالة الواردة إلى{' '}
                  <code className="font-mono font-semibold">{adminIdentity.email}</code> واضغط رابط
                  التأكيد، ثم اضغط «أكدت بريدي — تحقق الآن».
                </p>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={sendingVerification}
                    onClick={() => void handleSendVerificationEmail()}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg transition-colors"
                  >
                    <Mail className="w-4 h-4" />
                    <span>
                      {sendingVerification
                        ? 'جارٍ الإرسال...'
                        : 'إرسال رسالة تأكيد البريد'}
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={verifyingNow}
                    onClick={() => void handleReloadAndCheck()}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold text-slate-900 bg-slate-100 hover:bg-slate-200 border border-slate-300 disabled:opacity-50 rounded-lg transition-colors"
                  >
                    <RefreshCw className={`w-4 h-4 ${verifyingNow ? 'animate-spin' : ''}`} />
                    <span>
                      {verifyingNow ? 'جارٍ التحديث...' : 'أكدت بريدي — تحقق الآن'}
                    </span>
                  </button>
                </div>

                {verificationFeedback && (
                  <div
                    className={`p-3 rounded-lg border text-xs font-medium leading-relaxed ${
                      verificationFeedback.ok
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                        : 'bg-red-50 border-red-200 text-red-900'
                    }`}
                  >
                    {verificationFeedback.message}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-emerald-800">
                تم التحقق من بريدك الإلكتروني بنجاح. انتقل الآن إلى الخطوة الثانية لاعتماد حساب
                المسؤول.
              </p>
            )}
          </div>

          {/* STEP 2: Approve Admin in Firebase Console */}
          <div className="p-5 rounded-xl border border-slate-300 bg-white space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-slate-900 text-white text-xs flex items-center justify-center font-mono">
                  2
                </span>
                <span>الخطوة الثانية: اعتماد المسؤول في Firebase Console</span>
              </h3>
              {renderAdminDocStatusBadge(
                adminIdentity.hasCustomAdminClaim,
                adminIdentity.adminDocCheckStatus
              )}
            </div>

            {/* Detailed Server Diagnosis Message */}
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 leading-relaxed">
              <span className="font-bold text-slate-900">نتيجة فحص الخادم: </span>
              {adminIdentity.adminDocCheckDetail}
            </div>

            <div className="space-y-2.5 text-xs text-slate-700 leading-relaxed">
              <p className="font-semibold text-slate-900">
                ينفّذ مالك المشروع هذا الإجراء يدويًا من Firebase Console (الواجهة لا تنشئ وثيقة
                المسؤول تلقائيًا):
              </p>
              <ol className="list-decimal list-inside space-y-2">
                <li>
                  في <span className="font-semibold text-slate-900">Firebase Console</span> لمشروع{' '}
                  <code className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">vansales-mdm</code>
                  ، افتح <span className="font-semibold text-slate-900">Firestore Database</span>{' '}
                  (قاعدة <code className="font-mono">(default)</code>).
                </li>
                <li>
                  أنشئ مجموعة باسم <code className="font-mono font-bold">admins</code> وأضف بداخلها
                  وثيقة بمعرّف يساوي <strong>UID حساب المسؤول الحالي</strong>:
                  <div className="mt-1.5 flex items-center justify-between gap-2 p-2.5 bg-slate-900 text-slate-100 rounded-lg font-mono text-xs" dir="ltr">
                    <span>{adminDocPath}</span>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(adminIdentity.uid);
                        setCopiedPath(true);
                        setTimeout(() => setCopiedPath(false), 2000);
                      }}
                      className="px-2 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-blue-300 rounded"
                    >
                      {copiedPath ? 'تم نسخ UID' : 'نسخ Document ID'}
                    </button>
                  </div>
                </li>
                <li>
                  أضف داخل الوثيقة الحقلين التاليين بالأنواع المحددة:
                  <pre
                    dir="ltr"
                    className="mt-1.5 p-3 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto"
                  >
                    {`active: true                     // نوع الحقل: boolean\nemail: "${adminEmailDisplay}"  // نوع الحقل: string`}
                  </pre>
                </li>
                <li>
                  <strong>نشر قواعد Firestore:</strong> تأكد من نسخ قواعد ملف{' '}
                  <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">firestore.rules</code>{' '}
                  المحدث من هذا المشروع ونشرها (<strong>Publish</strong>) في تبويب{' '}
                  <span className="font-semibold text-slate-900">Firestore Database → Rules</span>{' '}
                  حتى تعمل آلية <code className="font-mono">admins/{'{uid}'}</code>.
                </li>
              </ol>
            </div>
          </div>

          {/* STEP 3: Open Admin Dashboard */}
          <div className="p-5 rounded-xl border border-slate-300 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-blue-700 text-white text-xs flex items-center justify-center font-mono">
                  3
                </span>
                <span>الخطوة الثالثة: فتح لوحة الإدارة</span>
              </h3>
              <p className="text-xs text-slate-600">
                بعد تأكيد البريد وإنشاء وثيقة <code className="font-mono">admins/{'{uid}'}</code>{' '}
                ونشر القواعد، اضغط الزر للتحقق الفوري والدخول للوحة.
              </p>
            </div>

            <button
              type="button"
              disabled={verifyingNow}
              onClick={() => void handleReloadAndCheck()}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-bold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-4 h-4 ${verifyingNow ? 'animate-spin' : ''}`} />
              <span>
                {verifyingNow
                  ? 'جارٍ التحقق من الخادم...'
                  : 'تحقق من الصلاحية وافتح لوحة الإدارة'}
              </span>
            </button>
          </div>

          {verifyFeedback && (
            <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-950 font-medium">
              {verifyFeedback}
            </div>
          )}
        </div>

        {/* Collapsible Advanced Technical Details & Admin SDK Alternative */}
        <details className="group border border-slate-200 rounded-xl bg-slate-50 overflow-hidden">
          <summary className="px-4 py-3 cursor-pointer flex items-center justify-between text-xs font-bold text-slate-700 hover:text-slate-900 select-none">
            <span className="flex items-center gap-2">
              <Database className="w-4 h-4 text-slate-500" />
              <span>تفاصيل تقنية متقدمة وبديل سطر الأوامر (Firebase Admin SDK Custom Claims)</span>
            </span>
            <ChevronDown className="w-4 h-4 text-slate-500 transition-transform group-open:rotate-180" />
          </summary>

          <div className="p-4 border-t border-slate-200 bg-white space-y-3 text-xs text-slate-600">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
              <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                <span className="text-slate-500 block">مزود الدخول</span>
                <span className="font-mono font-bold text-slate-800">
                  {adminIdentity.signInProvider}
                </span>
              </div>
              <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                <span className="text-slate-500 block">Custom Claim (admin)</span>
                <span className="font-mono font-bold text-slate-800">
                  {String(adminIdentity.hasCustomAdminClaim)}
                </span>
              </div>
              <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                <span className="text-slate-500 block">حالة فحص admins/{'{uid}'}</span>
                <span className="font-mono font-bold text-slate-800">
                  {adminIdentity.adminDocCheckStatus}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <span className="font-semibold text-slate-800">
                بديل منح Custom Claim عبر scripts/grant-admin.mjs (من بيئة محلية موثوقة):
              </span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(adminSdkSnippet);
                  setCopiedScript(true);
                  setTimeout(() => setCopiedScript(false), 2000);
                }}
                className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900"
              >
                {copiedScript ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedScript ? 'تم النسخ' : 'نسخ الكود'}</span>
              </button>
            </div>

            <pre
              dir="ltr"
              className="p-3 bg-slate-900 text-slate-100 rounded-lg text-[11px] font-mono overflow-x-auto leading-relaxed"
            >
              {adminSdkSnippet}
            </pre>

            <p className="text-[11px] text-slate-500 leading-relaxed">
              ملاحظة: السكربت لا يضبط <code className="font-mono">emailVerified=true</code>، ويحافظ
              على أي Custom Claims أخرى موجودة على الحساب. كما أن إلغاء الـ Claim وحده لا يلغي
              الصلاحية إذا كانت وثيقة <code className="font-mono">admins/{'{uid}'}</code> فعالة.
            </p>
          </div>
        </details>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <button
            type="button"
            onClick={onOpenDocs}
            className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
          >
            عرض ملف firestore.rules للنشر في Console
          </button>
          <button
            type="button"
            onClick={onOpenFirebaseSetup}
            className="text-xs text-slate-500 hover:text-slate-800 hover:underline"
          >
            مراجعة إعدادات مشروع Firebase
          </button>
        </div>
      </div>
    );
  }

  // Case 2: Not signed in yet
  return (
    <div className="max-w-md mx-auto my-8 bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-6">
      <div className="space-y-1.5 border-b border-slate-200 pb-4">
        <div className="inline-flex items-center gap-2 text-blue-700 text-xs font-semibold">
          <ShieldCheck className="w-4 h-4" />
          <span>مشروع Firebase: vansales-mdm</span>
        </div>
        <h2 className="text-xl font-bold text-slate-900">تسجيل دخول مسؤول الإدارة</h2>
        <p className="text-xs text-slate-600 leading-relaxed">
          سجّل الدخول بحساب المسؤول المسمّى (<code className="font-mono">mashhoor.info@gmail.com</code>).
          تسجيل الدخول المجهول (Anonymous) مخصص لوكيل أجهزة Android فقط.
        </p>
      </div>

      {errorMsg && (
        <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 font-medium leading-relaxed">
          {errorMsg}
        </div>
      )}

      <form onSubmit={(e) => void handleEmailSignIn(e)} className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">
            البريد الإلكتروني للمسؤول
          </label>
          <input
            dir="ltr"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="mashhoor.info@gmail.com"
            className="w-full px-3.5 py-2.5 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">
            كلمة المرور
          </label>
          <input
            dir="ltr"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="w-full px-3.5 py-2.5 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg transition-colors"
        >
          <LogIn className="w-4 h-4" />
          <span>{submitting ? 'جارٍ تسجيل الدخول...' : 'تسجيل الدخول بالبريد الإلكتروني'}</span>
        </button>
      </form>

      <div className="relative flex py-1 items-center">
        <div className="grow border-t border-slate-200" />
        <span className="shrink mx-3 text-xs text-slate-400">أو</span>
        <div className="grow border-t border-slate-200" />
      </div>

      <button
        type="button"
        onClick={() => void handleGoogleSignIn()}
        disabled={submitting}
        className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-lg transition-colors"
      >
        <span>تسجيل الدخول بحساب Google المؤسسي</span>
      </button>

      <div className="pt-2 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
        <button
          type="button"
          onClick={onOpenFirebaseSetup}
          className="text-blue-700 hover:underline font-medium"
        >
          مراجعة إعدادات الاتصال
        </button>
        <button
          type="button"
          onClick={onOpenDocs}
          className="text-slate-600 hover:underline font-medium"
        >
          دليل القواعد وصلاحيات المسؤول
        </button>
      </div>
    </div>
  );
};
