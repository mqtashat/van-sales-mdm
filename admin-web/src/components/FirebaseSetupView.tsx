import React, { useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Copy,
  Check,
  Database,
  KeyRound,
  Trash2,
} from 'lucide-react';
import {
  TARGET_FIREBASE_PROJECT_ID,
  TARGET_FIRESTORE_DATABASE_ID,
  type FirebaseWebConfigInput,
} from '../types/mdm';
import {
  type ConfigResolution,
  parseFirebaseConfigSnippet,
  saveRuntimeFirebaseConfig,
  clearRuntimeFirebaseConfig,
  resetFirebaseServices,
} from '../services/firebaseClient';

interface FirebaseSetupViewProps {
  resolution: ConfigResolution;
  onConfigSaved: () => void;
  onNavigateDocs: () => void;
}

export const FirebaseSetupView: React.FC<FirebaseSetupViewProps> = ({
  resolution,
  onConfigSaved,
  onNavigateDocs,
}) => {
  const [snippet, setSnippet] = useState('');
  const [apiKey, setApiKey] = useState(resolution.config?.apiKey || '');
  const [authDomain, setAuthDomain] = useState(
    resolution.config?.authDomain || `${TARGET_FIREBASE_PROJECT_ID}.firebaseapp.com`
  );
  const [projectId, setProjectId] = useState(
    resolution.config?.projectId || TARGET_FIREBASE_PROJECT_ID
  );
  const [storageBucket, setStorageBucket] = useState(
    resolution.config?.storageBucket || `${TARGET_FIREBASE_PROJECT_ID}.firebasestorage.app`
  );
  const [messagingSenderId, setMessagingSenderId] = useState(
    resolution.config?.messagingSenderId || ''
  );
  const [appId, setAppId] = useState(resolution.config?.appId || '');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copiedEnv, setCopiedEnv] = useState(false);

  const handleParseSnippet = () => {
    setFormError(null);
    const parsed = parseFirebaseConfigSnippet(snippet);
    if (parsed.error || !parsed.config) {
      setFormError(parsed.error || 'تعذر قراءة الكائن.');
      return;
    }
    setApiKey(parsed.config.apiKey);
    setAuthDomain(parsed.config.authDomain);
    setProjectId(parsed.config.projectId);
    setStorageBucket(parsed.config.storageBucket || '');
    setMessagingSenderId(parsed.config.messagingSenderId || '');
    setAppId(parsed.config.appId);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const payload: FirebaseWebConfigInput = {
        apiKey,
        authDomain,
        projectId,
        storageBucket,
        messagingSenderId,
        appId,
        databaseId: TARGET_FIRESTORE_DATABASE_ID,
      };
      const res = saveRuntimeFirebaseConfig(payload);
      if (!res.ok) {
        setFormError(res.error || 'بيانات غير صالحة.');
        return;
      }
      // Safely tear down any previous FirebaseApp instance so new settings apply immediately
      await resetFirebaseServices();
      onConfigSaved();
    } finally {
      setSaving(false);
    }
  };

  const handleClearRuntime = async () => {
    clearRuntimeFirebaseConfig();
    await resetFirebaseServices();
    onConfigSaved();
  };

  const envTemplate = `VITE_FIREBASE_API_KEY="${apiKey || 'YOUR_WEB_API_KEY'}"
VITE_FIREBASE_AUTH_DOMAIN="${authDomain || 'vansales-mdm.firebaseapp.com'}"
VITE_FIREBASE_PROJECT_ID="vansales-mdm"
VITE_FIREBASE_STORAGE_BUCKET="${storageBucket || 'vansales-mdm.firebasestorage.app'}"
VITE_FIREBASE_MESSAGING_SENDER_ID="${messagingSenderId || 'YOUR_SENDER_ID'}"
VITE_FIREBASE_APP_ID="${appId || 'YOUR_WEB_APP_ID'}"
VITE_FIREBASE_DATABASE_ID="(default)"`;

  const copyEnvTemplate = () => {
    void navigator.clipboard.writeText(envTemplate);
    setCopiedEnv(true);
    setTimeout(() => setCopiedEnv(false), 2000);
  };

  const envItems = [
    { key: 'VITE_FIREBASE_API_KEY', ok: resolution.envStatus.VITE_FIREBASE_API_KEY, required: true },
    { key: 'VITE_FIREBASE_AUTH_DOMAIN', ok: resolution.envStatus.VITE_FIREBASE_AUTH_DOMAIN, required: true },
    { key: 'VITE_FIREBASE_PROJECT_ID', ok: resolution.envStatus.VITE_FIREBASE_PROJECT_ID, required: true },
    { key: 'VITE_FIREBASE_APP_ID', ok: resolution.envStatus.VITE_FIREBASE_APP_ID, required: true },
    { key: 'VITE_FIREBASE_STORAGE_BUCKET', ok: resolution.envStatus.VITE_FIREBASE_STORAGE_BUCKET, required: false },
    { key: 'VITE_FIREBASE_MESSAGING_SENDER_ID', ok: resolution.envStatus.VITE_FIREBASE_MESSAGING_SENDER_ID, required: false },
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Main Institutional Notice */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h2 className="text-xl font-bold text-slate-900">
              إعدادات مشروع Firebase Web — {TARGET_FIREBASE_PROJECT_ID}
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              هذه اللوحة تتصل حصريًا بمشروع Firebase القائم{' '}
              <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">
                {TARGET_FIREBASE_PROJECT_ID}
              </code>{' '}
              وقاعدة بيانات{' '}
              <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">
                {TARGET_FIRESTORE_DATABASE_ID}
              </code>
              . عند تعديل الإعدادات وحفظها يتم إعادة تهيئة خدمات Firebase فورًا بالإعدادات الجديدة.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onNavigateDocs}
              className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              عرض عقد البيانات وقواعد Firestore
            </button>
          </div>
        </div>

        {resolution.validationError && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3 text-red-900 text-sm">
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">خطأ في التحقق من إعدادات المشروع المستهدف</p>
              <p className="mt-1">{resolution.validationError}</p>
            </div>
          </div>
        )}

        {/* Environment Variables Status Grid */}
        <div className="mt-5">
          <h3 className="text-sm font-semibold text-slate-800 mb-3 flex items-center gap-2">
            <Database className="w-4 h-4 text-slate-600" />
            <span>حالة متغيرات البيئة (VITE_FIREBASE_*) في البناء الحالي</span>
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {envItems.map((item) => (
              <div
                key={item.key}
                className="flex items-center justify-between px-3 py-2 rounded-lg border border-slate-200 bg-slate-50"
              >
                <code className="text-xs font-mono text-slate-800">{item.key}</code>
                {item.ok ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>متوفر</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                    <XCircle className="w-3.5 h-3.5" />
                    <span>{item.required ? 'غير مضبوط' : 'اختياري'}</span>
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Two-Column Setup Options */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Column 1: Interactive firebaseConfig input */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-blue-700" />
                <span>إدخال أو تحديث إعدادات تطبيق الويب (firebaseConfig)</span>
              </h3>
              <p className="text-xs text-slate-600 mt-1">
                يمكنك لصق كائن <code className="font-mono">firebaseConfig</code> المستخرج من
                إعدادات مشروع <code className="font-mono">vansales-mdm</code> أو وضعه في ملف{' '}
                <code className="font-mono">.env</code>.
              </p>
            </div>
            {resolution.source === 'runtime_storage' && (
              <button
                type="button"
                onClick={() => void handleClearRuntime()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>مسح الإعداد المحلي</span>
              </button>
            )}
          </div>

          {/* Snippet parser */}
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5">
            <label className="block text-xs font-semibold text-slate-700">
              لصق سريع لكائن firebaseConfig من Firebase Console (اختياري):
            </label>
            <textarea
              dir="ltr"
              rows={4}
              value={snippet}
              onChange={(e) => setSnippet(e.target.value)}
              placeholder={`const firebaseConfig = {\n  apiKey: "AIza...",\n  authDomain: "vansales-mdm.firebaseapp.com",\n  projectId: "vansales-mdm",\n  appId: "1:..."\n};`}
              className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            <button
              type="button"
              onClick={handleParseSnippet}
              className="px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-md transition-colors"
            >
              استخراج الحقول تلقائيًا من النص
            </button>
          </div>

          {formError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 font-medium">
              {formError}
            </div>
          )}

          <form onSubmit={(e) => void handleSave(e)} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Project ID (ثابت للمشروع المستهدف) *
                </label>
                <input
                  dir="ltr"
                  type="text"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  required
                  className="w-full px-3 py-2 text-xs font-mono bg-slate-100 border border-slate-300 rounded-lg text-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Web API Key (apiKey) *
                </label>
                <input
                  dir="ltr"
                  type="text"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="AIzaSy..."
                  required
                  className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Auth Domain (authDomain) *
                </label>
                <input
                  dir="ltr"
                  type="text"
                  value={authDomain}
                  onChange={(e) => setAuthDomain(e.target.value)}
                  placeholder="vansales-mdm.firebaseapp.com"
                  required
                  className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  App ID (appId) *
                </label>
                <input
                  dir="ltr"
                  type="text"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  placeholder="1:1234567890:web:abcdef..."
                  required
                  className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Storage Bucket (اختياري)
                </label>
                <input
                  dir="ltr"
                  type="text"
                  value={storageBucket}
                  onChange={(e) => setStorageBucket(e.target.value)}
                  placeholder="vansales-mdm.firebasestorage.app"
                  className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Messaging Sender ID (اختياري)
                </label>
                <input
                  dir="ltr"
                  type="text"
                  value={messagingSenderId}
                  onChange={(e) => setMessagingSenderId(e.target.value)}
                  placeholder="1234567890"
                  className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>

            <div className="pt-2 flex items-center justify-between gap-4">
              <span className="text-xs text-slate-500">
                ملاحظة: إعدادات Web API Key هي معرفات عميل عامة وليست مفاتيح Service Account خاصة.
              </span>
              <button
                type="submit"
                disabled={saving}
                className="px-5 py-2.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                {saving ? 'جارٍ تطبيق الإعدادات...' : 'حفظ الإعدادات وتطبيقها فورًا'}
              </button>
            </div>
          </form>
        </div>

        {/* Column 2: How to get firebaseConfig & .env template */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4">
          <h3 className="text-base font-bold text-slate-900">
            خطوات استخراج الإعدادات من مشروع vansales-mdm
          </h3>
          <ol className="list-decimal list-inside space-y-2.5 text-xs text-slate-700 leading-relaxed">
            <li>
              افتح{' '}
              <span className="font-semibold text-slate-900">Firebase Console</span> واختر المشروع{' '}
              <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">vansales-mdm</code>.
            </li>
            <li>
              من القائمة الجانبية افتح{' '}
              <span className="font-semibold text-slate-900">Project settings (إعدادات المشروع)</span>{' '}
              ← تبويب <span className="font-semibold text-slate-900">General</span>.
            </li>
            <li>
              في قسم <span className="font-semibold text-slate-900">Your apps</span>، اختر تطبيق
              الويب المسجل أو أنشئ تطبيق ويب جديدًا.
            </li>
            <li>
              انسخ قيم <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">firebaseConfig</code>{' '}
              وضعها في ملف <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">.env</code>{' '}
              محليًا أو في متغيرات البيئة على <span className="font-semibold">Vercel</span>.
            </li>
          </ol>

          <div className="pt-2">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-slate-700">
                قالب ملف .env جاهز للنسخ:
              </span>
              <button
                type="button"
                onClick={copyEnvTemplate}
                className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900"
              >
                {copiedEnv ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    <span className="text-emerald-700">تم النسخ</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>نسخ .env</span>
                  </>
                )}
              </button>
            </div>
            <pre
              dir="ltr"
              className="p-3 bg-slate-900 text-slate-100 rounded-lg text-[11px] font-mono overflow-x-auto leading-relaxed"
            >
              {envTemplate}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
