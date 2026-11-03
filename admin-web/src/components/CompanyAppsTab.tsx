import React, { useState, useEffect, useRef } from 'react';
import type { Firestore } from 'firebase/firestore';
import { collection, doc, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import {
  ref as storageRef,
  uploadBytesResumable,
  type FirebaseStorage,
} from 'firebase/storage';
import type {
  AdminIdentity,
  CompanyAppDoc,
  DeviceCommandDoc,
  InstallRequestDoc,
  MergedDeviceRecord,
} from '../types/mdm.ts';
import {
  subscribeToCompanyApps,
  addCompanyApp,
  requestServerApkInspection,
  subscribeToInstallRequests,
  reviewInstallRequest,
  sendInstallCommand,
  cancelInstallCommand,
  addInstalledAppToServerKioskPolicy,
} from '../services/mdmService.ts';
import {
  parseApkFile,
  formatFingerprintWithColons,
  normalizeHexDigest,
  type ParsedApkInfo,
} from '../utils/apkParser.ts';
import {
  UploadCloud,
  FileUp,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Package,
  ShieldCheck,
  Send,
  Smartphone,
  Users,
  RefreshCw,
  Clock,
  Lock,
  XCircle,
} from 'lucide-react';

interface CompanyAppsTabProps {
  db: Firestore;
  adminIdentity: AdminIdentity | null;
  devices: MergedDeviceRecord[];
  storage?: FirebaseStorage;
}

export const CompanyAppsTab: React.FC<CompanyAppsTabProps> = ({
  db,
  adminIdentity,
  devices,
  storage,
}) => {
  const [apps, setApps] = useState<CompanyAppDoc[]>([]);
  const [requests, setRequests] = useState<InstallRequestDoc[]>([]);
  const [recentCommands, setRecentCommands] = useState<DeviceCommandDoc[]>([]);
  const [activeSubTab, setActiveSubTab] = useState<'catalog' | 'commands' | 'requests'>('catalog');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isDeployModalOpen, setIsDeployModalOpen] = useState(false);
  const [selectedAppForDeploy, setSelectedAppForDeploy] = useState<CompanyAppDoc | null>(null);

  // Deployment modal state
  const [deployTargetType, setDeployTargetType] = useState<'single' | 'all_active'>('single');
  const [selectedDeviceUid, setSelectedDeviceUid] = useState<string>('');
  const [addToKiosk, setAddToKiosk] = useState<boolean>(true);
  const [deploying, setDeploying] = useState(false);

  const [statusMessage, setStatusMessage] = useState<string>('');
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null);
  const [inspectingAppId, setInspectingAppId] = useState<string | null>(null);

  // Form states for adding new company app (Local preview only; server sets verified)
  const [formData, setFormData] = useState({
    pendingAppId: '',
    appName: '',
    packageName: '',
    versionCode: 0,
    versionName: '',
    fileSizeBytes: 0,
    sha256Apk: '',
    sha256Cert: '',
    signatureScheme: '' as 'v1' | 'v2' | 'v3' | 'v2+v3' | '',
    storagePath: '',
    description: '',
    iconDataUrl: '' as string | null,
  });

  // Drag-and-drop & local preview state
  const [isDragging, setIsDragging] = useState(false);
  const [parsingApk, setParsingApk] = useState(false);
  const [parsedInfo, setParsedInfo] = useState<ParsedApkInfo | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [showTechnicalDrawer, setShowTechnicalDrawer] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Uploading state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    const unsubApps = subscribeToCompanyApps(
      db,
      (list) => setApps(list),
      {
        onError: (err) => {
          if (
            (err as { code?: string })?.code === 'permission-denied' ||
            err.message?.includes('Missing or insufficient permissions')
          ) {
            setPermissionNotice(
              'سجل تطبيقات الشركة وطلبات التثبيت بانتظار تفعيل قواعد أمان Firestore أو اعتماد الصلاحيات.'
            );
          }
        },
      }
    );
    const unsubReqs = subscribeToInstallRequests(
      db,
      (reqs) => setRequests(reqs),
      {
        onError: (err) => {
          if (
            (err as { code?: string })?.code === 'permission-denied' ||
            err.message?.includes('Missing or insufficient permissions')
          ) {
            setPermissionNotice(
              'سجل تطبيقات الشركة وطلبات التثبيت بانتظار تفعيل قواعد أمان Firestore أو اعتماد الصلاحيات.'
            );
          }
        },
      }
    );
    return () => {
      unsubApps();
      unsubReqs();
    };
  }, [db]);

  // Subscribe to commands across active devices and reconcile Kiosk policy ONLY when admin requested add_to_kiosk === true
  useEffect(() => {
    if (!adminIdentity?.isAuthorizedAdmin || devices.length === 0) return;

    const unsubs: Array<() => void> = [];
    const activeList = devices.filter((d) => !d.isArchived).slice(0, 25);

    for (const dev of activeList) {
      const q = query(
        collection(db, 'deviceCommands', dev.uid, 'commands'),
        orderBy('created_at', 'desc'),
        limit(10)
      );

      const unsub = onSnapshot(
        q,
        (snap) => {
          const devCmds: DeviceCommandDoc[] = [];
          snap.docs.forEach((docSnap) => {
            const data = docSnap.data();
            const cmd: DeviceCommandDoc = {
              id: docSnap.id,
              uid: dev.uid,
              ...(data as Omit<DeviceCommandDoc, 'id' | 'uid'>),
            };
            devCmds.push(cmd);

            // Authoritative server-side kiosk policy increment:
            // Strictly checks the admin's immutable decision `cmd.add_to_kiosk === true` (never phone's add_to_kiosk_requested)
            if (
              cmd.status === 'executed' &&
              cmd.cancelled !== true &&
              cmd.add_to_kiosk === true &&
              cmd.kiosk_addition_status !== 'added' &&
              cmd.kiosk_addition_status !== 'failed' &&
              cmd.kiosk_addition_status !== 'waiting_for_inventory' &&
              cmd.package_name
            ) {
              void addInstalledAppToServerKioskPolicy(
                db,
                dev.uid,
                cmd.package_name,
                cmd.id,
                { uid: adminIdentity.uid, email: adminIdentity.email }
              );
            }
          });

          setRecentCommands((prev) => {
            const filtered = prev.filter((c) => c.uid !== dev.uid);
            return [...filtered, ...devCmds].sort((a, b) => {
              const tA = a.created_at?.toMillis ? a.created_at.toMillis() : 0;
              const tB = b.created_at?.toMillis ? b.created_at.toMillis() : 0;
              return tB - tA;
            });
          });
        },
        () => {
          // Ignore permission errors on commands if rules not deployed yet
        }
      );

      unsubs.push(unsub);
    }

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [db, devices, adminIdentity]);

  // Automatically retry waiting_for_inventory Kiosk additions whenever deviceAppInventory/{uid} updates
  useEffect(() => {
    if (!adminIdentity?.isAuthorizedAdmin) return;
    const waitingCommands = recentCommands.filter(
      (c) =>
        c.type === 'install_app' &&
        c.status === 'executed' &&
        c.cancelled !== true &&
        c.add_to_kiosk === true &&
        c.kiosk_addition_status === 'waiting_for_inventory' &&
        Boolean(c.package_name)
    );
    if (waitingCommands.length === 0) return;

    const uniqueUids = Array.from(new Set(waitingCommands.map((c) => c.uid)));
    const unsubs: Array<() => void> = [];

    for (const uid of uniqueUids) {
      const invRef = doc(db, 'deviceAppInventory', uid);
      const unsub = onSnapshot(
        invRef,
        (invSnap) => {
          if (!invSnap.exists()) return;
          const apps = Array.isArray(invSnap.data()?.apps) ? invSnap.data().apps : [];
          for (const cmd of waitingCommands.filter((w) => w.uid === uid)) {
            if (cmd.package_name && apps.some((a: { package_name?: string }) => a?.package_name === cmd.package_name)) {
              void addInstalledAppToServerKioskPolicy(
                db,
                uid,
                cmd.package_name,
                cmd.id,
                { uid: adminIdentity.uid, email: adminIdentity.email }
              );
            }
          }
        },
        () => {}
      );
      unsubs.push(unsub);
    }

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [db, recentCommands, adminIdentity]);

  const activeDevices = devices.filter((d) => !d.isArchived);
  const archivedCount = devices.length - activeDevices.length;

  const copyToClipboard = (text: string, key: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    }
  };

  const resetForm = () => {
    setFormData({
      pendingAppId: `app_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      appName: '',
      packageName: '',
      versionCode: 0,
      versionName: '',
      fileSizeBytes: 0,
      sha256Apk: '',
      sha256Cert: '',
      signatureScheme: '',
      storagePath: '',
      description: '',
      iconDataUrl: null,
    });
    setParsedInfo(null);
    setParseError(null);
    setSelectedFile(null);
    setUploadProgress(null);
    setUploadError(null);
    setUploadSuccess(false);
    setShowTechnicalDrawer(false);
  };

  const handleProcessApkFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.apk')) {
      setParseError('الملف المختار ليس بصيغة APK صالحة (.apk)');
      return;
    }

    setParsingApk(true);
    setParseError(null);
    setSelectedFile(file);
    setUploadProgress(null);
    setUploadError(null);
    setUploadSuccess(false);

    const nextAppId =
      formData.pendingAppId || `app_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    try {
      // Browser inspection is strictly a LOCAL PREVIEW; server inspection is required for 'verified'
      const info = await parseApkFile(file);
      setParsedInfo(info);
      const cleanFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const targetStoragePath = `company_apps/${nextAppId}/${cleanFileName}`;

      setFormData((prev) => ({
        ...prev,
        pendingAppId: nextAppId,
        appName: info.appName,
        packageName: info.packageName,
        versionCode: info.versionCode,
        versionName: info.versionName,
        fileSizeBytes: info.fileSizeBytes,
        sha256Apk: normalizeHexDigest(info.sha256Apk),
        sha256Cert: normalizeHexDigest(info.sha256Cert),
        signatureScheme: info.signatureScheme,
        storagePath: targetStoragePath,
        iconDataUrl: info.iconDataUrl,
      }));

      if (storage) {
        startUploadToStorage(file, nextAppId, targetStoragePath);
      }
    } catch (err) {
      console.error('APK local preview failed:', err);
      setParsedInfo(null);
      setFormData((prev) => ({
        ...prev,
        pendingAppId: nextAppId,
        fileSizeBytes: file.size,
      }));
      setParseError(
        'فشلت المعاينة الأولية لحزمة APK: ' +
          (err instanceof Error ? err.message : String(err)) +
          '. لا يمكن رفع أو اعتماد حزمة غير موقعة أو تم العبث بمحتواها.'
      );
    } finally {
      setParsingApk(false);
    }
  };

  const startUploadToStorage = (file: File, appId: string, storagePath: string) => {
    if (!storage) {
      setUploadError('خدمة Firebase Storage غير متوفرة حاليًا.');
      return;
    }

    setUploadProgress(0);
    setUploadError(null);
    setUploadSuccess(false);

    const pathRef = storageRef(storage, storagePath);

    const uploadTask = uploadBytesResumable(pathRef, file, {
      contentType: 'application/vnd.android.package-archive',
    });

    uploadTask.on(
      'state_changed',
      (snapshot) => {
        const progress = Math.round(
          (snapshot.bytesTransferred / snapshot.totalBytes) * 100
        );
        setUploadProgress(progress);
      },
      (error) => {
        console.error('Storage upload failed:', error);
        setUploadError('فشل رفع الملف إلى مسار التخزين المحمي: ' + error.message);
        setUploadProgress(null);
      },
      () => {
        // Do NOT generate a permanent public getDownloadURL!
        // Devices access the APK exclusively via task-bound authorization & storage_path.
        setFormData((prev) => ({
          ...prev,
          pendingAppId: appId,
          storagePath,
        }));
        setUploadProgress(100);
        setUploadSuccess(true);
      }
    );
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      void handleProcessApkFile(file);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      void handleProcessApkFile(file);
    }
  };

  const handleAddApp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminIdentity?.isAuthorizedAdmin) {
      alert('غير مصرح لك بإضافة تطبيقات الشركة');
      return;
    }

    const cleanApkHex = normalizeHexDigest(formData.sha256Apk);
    const cleanCertHex = normalizeHexDigest(formData.sha256Cert);

    if (!formData.appName || !formData.packageName || !formData.storagePath || cleanApkHex.length !== 64) {
      alert('يرجى رفع ملف APK صالح واستكمال الحقول المطلوبة وبصمة SHA-256 (64 حرف hex)');
      return;
    }

    setSubmitting(true);
    setStatusMessage('');
    try {
      // 1. Save catalog entry strictly as 'pending_inspection' (browser can never set 'verified')
      const createdAppId = await addCompanyApp(
        db,
        {
          app_name: formData.appName.trim(),
          package_name: formData.packageName.trim(),
          version_code: Number(formData.versionCode),
          version_name: formData.versionName.trim(),
          file_size_bytes: Number(formData.fileSizeBytes),
          sha256_apk: cleanApkHex,
          sha256_cert: cleanCertHex,
          signature_scheme: formData.signatureScheme || undefined,
          inspection_status: 'pending_inspection',
          inspected_by_server: false,
          storage_path: formData.storagePath.trim(),
          description: formData.description.trim(),
        },
        { uid: adminIdentity.uid, email: adminIdentity.email },
        formData.pendingAppId || undefined
      );

      setIsAddModalOpen(false);
      resetForm();

      // 2. Request authoritative server-side APK inspection via Cloud Function
      try {
        setInspectingAppId(createdAppId);
        await requestServerApkInspection(createdAppId);
        setStatusMessage(
          'تم رفع الحزمة وإتمام الفحص الخادمي الموثق بنجاح؛ الحزمة جاهزة للتوزيع.'
        );
      } catch {
        setStatusMessage(
          'تم حفظ الحزمة بحالة «بانتظار الفحص»؛ لن يُسمح بالتوزيع حتى اكتمال الفحص الخادمي (inspectCompanyApk).'
        );
      } finally {
        setInspectingAppId(null);
      }
    } catch (err) {
      alert('فشل إضافة التطبيق: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSubmitting(false);
    }
  };

  const handleTriggerServerInspection = async (appId: string) => {
    setInspectingAppId(appId);
    try {
      await requestServerApkInspection(appId);
      setStatusMessage('اكتمل الفحص الخادمي لتوقيع ومحتوى الحزمة وتم اعتمادها للتوزيع.');
    } catch (err) {
      alert(
        'تعذر إتمام الفحص الخادمي للحزمة: ' +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setInspectingAppId(null);
    }
  };

  const handleCancelCommand = async (cmd: DeviceCommandDoc) => {
    if (!adminIdentity?.isAuthorizedAdmin) return;
    try {
      await cancelInstallCommand(db, cmd.uid, cmd.id, cmd.app_id, {
        uid: adminIdentity.uid,
        email: adminIdentity.email,
      });
      setStatusMessage(`تم إلغاء أمر التثبيت (${cmd.app_name || cmd.package_name}) وسحب تفويض التنزيل.`);
    } catch (err) {
      alert('تعذر إلغاء الأمر: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleReviewRequest = async (requestId: string, decision: 'approved' | 'rejected') => {
    if (!adminIdentity?.isAuthorizedAdmin) return;
    const notes = reviewNotes[requestId] || '';
    try {
      await reviewInstallRequest(db, requestId, decision, notes, {
        uid: adminIdentity.uid,
        email: adminIdentity.email,
      });
      setStatusMessage(decision === 'approved' ? 'تمت الموافقة على طلب التثبيت' : 'تم رفض طلب التثبيت');
    } catch (err) {
      alert('خطأ أثناء مراجعة الطلب: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleDeployToDevices = async () => {
    if (!selectedAppForDeploy || !adminIdentity?.isAuthorizedAdmin) return;

    // Strictly require inspection_status === 'verified' AND inspected_by_server === true
    if (
      selectedAppForDeploy.inspection_status !== 'verified' ||
      selectedAppForDeploy.inspected_by_server !== true
    ) {
      alert(
        'لا يمكن توزيع هذا التطبيق إلا بعد اكتمال الفحص الخادمي واعتماده صراحةً (inspection_status === "verified").'
      );
      return;
    }

    const targets: string[] = [];
    if (deployTargetType === 'single') {
      if (!selectedDeviceUid) {
        alert('يرجى تحديد الجهاز المستهدف أولاً');
        return;
      }
      targets.push(selectedDeviceUid);
    } else {
      targets.push(...activeDevices.map((d) => d.uid));
    }

    if (targets.length === 0) {
      alert('لا توجد أجهزة نشطة مستهدفة للإرسال');
      return;
    }

    setDeploying(true);
    let successCount = 0;
    let failCount = 0;

    for (const uid of targets) {
      try {
        await sendInstallCommand(
          db,
          uid,
          selectedAppForDeploy,
          { uid: adminIdentity.uid, email: adminIdentity.email },
          { addToKiosk }
        );
        successCount++;
      } catch (err) {
        console.error(`Failed to send install command to device ${uid}:`, err);
        failCount++;
      }
    }

    setDeploying(false);
    setIsDeployModalOpen(false);

    const summary =
      deployTargetType === 'single'
        ? `تم إرسال أمر التثبيت الصامت وتفويض التنزيل للتطبيق (${selectedAppForDeploy.app_name}) إلى الجهاز المستهدف بنجاح`
        : `تم إرسال أمر التثبيت وتفويض التنزيل بنجاح إلى ${successCount} جهازاً نشطاً${
            failCount > 0 ? ` (وفشل الإرسال لـ ${failCount} جهاز)` : ''
          } مع استبعاد ${archivedCount} جهازاً مؤرشفاً.`;

    setStatusMessage(summary);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <Package className="w-5 h-5 text-indigo-600" />
            <span>تطبيقات الشركة وتوزيع حزم APK الموثقة خادمياً</span>
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            معاينة محلية فورية، واعتماد خادمي حصري يتحقق من سلامة محتوى APK وتوقيع X.509، مع تفويض تنزيل مخصص لكل جهاز ومهمة
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              resetForm();
              setIsAddModalOpen(true);
            }}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-bold transition shadow-sm flex items-center gap-2 cursor-pointer"
          >
            <FileUp className="w-4 h-4" />
            <span>رفع وفحص حزمة APK</span>
          </button>
        </div>
      </div>

      {statusMessage && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{statusMessage}</span>
          </div>
          <button
            onClick={() => setStatusMessage('')}
            className="text-emerald-600 hover:text-emerald-900 font-bold"
          >
            ×
          </button>
        </div>
      )}

      {permissionNotice && (
        <div className="p-4 bg-amber-50 border border-amber-200 text-amber-900 rounded-lg text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>{permissionNotice}</span>
          </div>
          <button
            onClick={() => setPermissionNotice(null)}
            className="text-amber-700 hover:text-amber-950 font-bold"
          >
            ×
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-slate-200 flex gap-4">
        <button
          onClick={() => setActiveSubTab('catalog')}
          className={`pb-3 px-2 text-sm font-bold border-b-2 transition cursor-pointer ${
            activeSubTab === 'catalog'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          دليل تطبيقات الشركة ({apps.length})
        </button>
        <button
          onClick={() => setActiveSubTab('commands')}
          className={`pb-3 px-2 text-sm font-bold border-b-2 transition cursor-pointer flex items-center gap-2 ${
            activeSubTab === 'commands'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <span>حالة أوامر التثبيت وإضافة الكشك ({recentCommands.length})</span>
        </button>
        <button
          onClick={() => setActiveSubTab('requests')}
          className={`pb-3 px-2 text-sm font-bold border-b-2 transition flex items-center gap-2 cursor-pointer ${
            activeSubTab === 'requests'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <span>طلبات الموافقة الميدانية</span>
          {requests.filter((r) => r.status === 'pending').length > 0 && (
            <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full text-xs font-bold">
              {requests.filter((r) => r.status === 'pending').length}
            </span>
          )}
        </button>
      </div>

      {/* Catalog SubTab */}
      {activeSubTab === 'catalog' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {apps.length === 0 ? (
            <div className="col-span-full py-16 text-center bg-white rounded-xl border border-dashed border-slate-300 text-slate-400">
              <UploadCloud className="w-12 h-12 text-slate-300 mx-auto mb-3" />
              <p className="text-base font-bold text-slate-600 mb-1">لم تُضف تطبيقات شركة معتمدة بعد</p>
              <p className="text-xs text-slate-400 mb-4">
                اسحب ملف APK أو اضغط على «رفع وفحص حزمة APK» لمعاينته ورفعه للفحص الخادمي.
              </p>
            </div>
          ) : (
            apps.map((app) => {
              // Strictly require explicit server verification: missing inspection_status is NEVER verified!
              const isVerified =
                app.inspection_status === 'verified' &&
                app.inspected_by_server === true &&
                normalizeHexDigest(app.sha256_apk || '').length === 64 &&
                normalizeHexDigest(app.sha256_cert || '').length === 64;

              return (
                <div
                  key={app.id}
                  className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm flex flex-col justify-between hover:shadow-md transition"
                >
                  <div>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center font-bold text-indigo-700 text-sm">
                          <Package className="w-5 h-5 text-indigo-600" />
                        </div>
                        <div>
                          <h3 className="text-base font-bold text-slate-800 leading-snug">{app.app_name}</h3>
                          <p className="text-xs font-mono text-slate-500 dir-ltr text-right mt-0.5">{app.package_name}</p>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span className="bg-indigo-50 text-indigo-700 text-xs px-2 py-0.5 rounded font-mono font-bold">
                          v{app.version_name} ({app.version_code})
                        </span>
                        {isVerified ? (
                          <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                            <ShieldCheck className="w-3 h-3" />
                            <span>موثّق خادمياً {app.signature_scheme ? `(${app.signature_scheme})` : ''}</span>
                          </span>
                        ) : app.inspection_status === 'failed' ? (
                          <span className="bg-rose-50 text-rose-800 border border-rose-200 text-[10px] px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                            <XCircle className="w-3 h-3" />
                            <span>فشل الفحص الخادمي</span>
                          </span>
                        ) : (
                          <span className="bg-amber-50 text-amber-800 border border-amber-200 text-[10px] px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            <span>بانتظار الفحص</span>
                          </span>
                        )}
                      </div>
                    </div>

                    {app.inspection_error && (
                      <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded text-[11px] text-rose-700">
                        سبب رفض الفحص: {app.inspection_error}
                      </div>
                    )}

                    {app.description && (
                      <p className="text-xs text-slate-600 mt-3 line-clamp-2 leading-relaxed">{app.description}</p>
                    )}

                    <div className="mt-4 pt-3 border-t border-slate-100 space-y-2 text-xs text-slate-600">
                      <div className="flex justify-between items-center">
                        <span className="text-slate-400">حجم الملف:</span>
                        <span className="font-mono font-medium">
                          {(app.file_size_bytes / (1024 * 1024)).toFixed(2)} ميغابايت
                        </span>
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-slate-400">بصمة APK SHA-256 (Hex):</span>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(normalizeHexDigest(app.sha256_apk), `apk_${app.id}`)}
                            className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium inline-flex items-center gap-1"
                          >
                            {copiedKey === `apk_${app.id}` ? (
                              <>
                                <Check className="w-3 h-3 text-emerald-600" />
                                <span className="text-emerald-600">تم النسخ</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                <span>نسخ Hex</span>
                              </>
                            )}
                          </button>
                        </div>
                        <div className="font-mono text-[10px] bg-slate-50 p-1.5 rounded border border-slate-200 break-all dir-ltr select-all text-slate-700">
                          {formatFingerprintWithColons(app.sha256_apk)}
                        </div>
                      </div>

                      {app.sha256_cert && (
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-slate-400">بصمة شهادة المطور SHA-256:</span>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(normalizeHexDigest(app.sha256_cert), `cert_${app.id}`)}
                              className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium inline-flex items-center gap-1"
                            >
                              {copiedKey === `cert_${app.id}` ? (
                                <>
                                  <Check className="w-3 h-3 text-emerald-600" />
                                  <span className="text-emerald-600">تم النسخ</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" />
                                  <span>نسخ Hex</span>
                                </>
                              )}
                            </button>
                          </div>
                          <div className="font-mono text-[10px] bg-slate-50 p-1.5 rounded border border-slate-200 break-all dir-ltr select-all text-slate-700">
                            {formatFingerprintWithColons(app.sha256_cert)}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-slate-400 flex items-center gap-1">
                      <Lock className="w-3 h-3" />
                      <span>تفويض تنزيل مخصص للجهاز</span>
                    </span>
                    <div className="flex items-center gap-1.5">
                      {!isVerified && (
                        <button
                          type="button"
                          disabled={inspectingAppId === app.id}
                          onClick={() => void handleTriggerServerInspection(app.id)}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-indigo-50 hover:bg-indigo-100 text-indigo-700 transition cursor-pointer flex items-center gap-1"
                        >
                          <RefreshCw className={`w-3 h-3 ${inspectingAppId === app.id ? 'animate-spin' : ''}`} />
                          <span>فحص خادمي</span>
                        </button>
                      )}
                      <button
                        disabled={!isVerified}
                        onClick={() => {
                          setSelectedAppForDeploy(app);
                          setDeployTargetType('single');
                          setSelectedDeviceUid('');
                          setAddToKiosk(true);
                          setIsDeployModalOpen(true);
                        }}
                        title={!isVerified ? 'لا يمكن التوزيع قبل اكتمال الفحص الخادمي الموثق' : undefined}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-xs ${
                          isVerified
                            ? 'bg-slate-900 hover:bg-black text-white cursor-pointer'
                            : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                        }`}
                      >
                        <Send className="w-3.5 h-3.5" />
                        <span>{isVerified ? 'توزيع وتثبيت...' : 'بانتظار الفحص'}</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Commands Status SubTab (Separating Install Result from Kiosk Addition Status) */}
      {activeSubTab === 'commands' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead className="bg-slate-50 text-slate-600 text-xs font-semibold border-b border-slate-200">
                <tr>
                  <th className="p-3">التطبيق والحزمة</th>
                  <th className="p-3">الجهاز المستهدف</th>
                  <th className="p-3">نتيجة تثبيت APK على الهاتف</th>
                  <th className="p-3">نتيجة الإضافة لشاشة الشركة (Kiosk)</th>
                  <th className="p-3">تفاصيل أو إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recentCommands.filter((c) => c.type === 'install_app').length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-slate-400">
                      لا توجد أوامر تثبيت مرسلة مؤخراً
                    </td>
                  </tr>
                ) : (
                  recentCommands
                    .filter((c) => c.type === 'install_app')
                    .map((cmd) => {
                      const dev = devices.find((d) => d.uid === cmd.uid);
                      return (
                        <tr key={`${cmd.uid}_${cmd.id}`} className="hover:bg-slate-50">
                          <td className="p-3">
                            <div className="font-bold text-slate-800">{cmd.app_name || 'تطبيق شركة'}</div>
                            <div className="font-mono text-xs text-slate-500 dir-ltr text-right">
                              {cmd.package_name} (v{cmd.version_code})
                            </div>
                          </td>
                          <td className="p-3">
                            <div className="text-slate-800 font-medium">
                              {dev?.metadata?.device_name || 'جهاز مندوب'}
                            </div>
                            <div className="text-xs text-slate-400 font-mono">{cmd.uid.slice(0, 8)}...</div>
                          </td>
                          <td className="p-3">
                            {cmd.status === 'pending' && (
                              <span className="px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-800 font-bold">
                                بانتظار استلام الهاتف
                              </span>
                            )}
                            {cmd.status === 'in_progress' && (
                              <span className="px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-800 font-bold">
                                جارٍ التنزيل والتثبيت...
                              </span>
                            )}
                            {cmd.status === 'executed' && cmd.install_outcome === 'already_installed' && (
                              <span className="px-2 py-0.5 rounded text-xs bg-teal-100 text-teal-800 font-bold">
                                ✓ الإصدار المطلوب موجود مسبقًا (v{cmd.installed_version || cmd.version_code})
                              </span>
                            )}
                            {cmd.status === 'executed' && cmd.install_outcome !== 'already_installed' && (
                              <span className="px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-800 font-bold">
                                ✓ تم التثبيت والتحقق (v{cmd.installed_version || cmd.version_code})
                              </span>
                            )}
                            {cmd.status === 'failed' && (
                              <span className="px-2 py-0.5 rounded text-xs bg-rose-100 text-rose-800 font-bold">
                                ✕ فشل التثبيت
                              </span>
                            )}
                            {cmd.status === 'cancelled' && (
                              <span className="px-2 py-0.5 rounded text-xs bg-slate-200 text-slate-700 font-bold">
                                ⊘ تم إلغاء الأمر
                              </span>
                            )}
                          </td>
                          <td className="p-3">
                            {cmd.add_to_kiosk !== true ? (
                              <span className="text-xs text-slate-400">غير مطلوب من المشرف</span>
                            ) : cmd.kiosk_addition_status === 'added' ? (
                              <span className="px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-800 font-bold">
                                ✓ أُضيف لسياسة الكشك بالخادم
                              </span>
                            ) : cmd.kiosk_addition_status === 'waiting_for_inventory' ? (
                              <span className="px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-800 font-bold">
                                ⏳ بانتظار تحديث جرد التطبيقات
                              </span>
                            ) : cmd.kiosk_addition_status === 'failed' ? (
                              <span className="px-2 py-0.5 rounded text-xs bg-rose-100 text-rose-800 font-bold">
                                ✕ تعذرت الإضافة للكشك
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded text-xs bg-indigo-50 text-indigo-700 font-medium">
                                بانتظار اكتمال التثبيت وتحديث السياسة
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <div>
                                {cmd.error && <div className="text-rose-600 font-medium">خطأ التثبيت: {cmd.error}</div>}
                                {cmd.kiosk_addition_error && (
                                  <div className="text-amber-700 font-medium mt-0.5">
                                    خطأ الكشك: {cmd.kiosk_addition_error}
                                  </div>
                                )}
                                {!cmd.error && !cmd.kiosk_addition_error && (
                                  <span className="text-slate-400">{cmd.progress || '—'}</span>
                                )}
                              </div>
                              {(cmd.status === 'pending' || cmd.status === 'in_progress') && (
                                <button
                                  type="button"
                                  onClick={() => void handleCancelCommand(cmd)}
                                  className="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded text-[11px] font-bold transition cursor-pointer shrink-0"
                                >
                                  إلغاء الأمر
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Requests SubTab */}
      {activeSubTab === 'requests' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead className="bg-slate-50 text-slate-600 text-xs font-semibold border-b border-slate-200">
                <tr>
                  <th className="p-3">التطبيق</th>
                  <th className="p-3">الحزمة</th>
                  <th className="p-3">الجهاز والمندوب</th>
                  <th className="p-3">الحالة</th>
                  <th className="p-3">ملاحظات المشرف</th>
                  <th className="p-3 text-center">الإجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {requests.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-400">
                      لا توجد طلبات تثبيت مسجلة حاليًا
                    </td>
                  </tr>
                ) : (
                  requests.map((req) => (
                    <tr key={req.id} className="hover:bg-slate-50">
                      <td className="p-3 font-medium text-slate-800">{req.app_name}</td>
                      <td className="p-3 font-mono text-xs text-slate-500 dir-ltr text-right">{req.package_name}</td>
                      <td className="p-3">
                        <div className="text-slate-800">{req.requested_by_rep || 'مندوب غير محدد'}</div>
                        <div className="font-mono text-xs text-slate-400 dir-ltr text-right">
                          {req.device_uid.slice(0, 10)}...
                        </div>
                      </td>
                      <td className="p-3">
                        {req.status === 'pending' && (
                          <span className="px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-800 font-medium">
                            قيد المراجعة
                          </span>
                        )}
                        {req.status === 'approved' && (
                          <span className="px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-800 font-medium">
                            تمت الموافقة
                          </span>
                        )}
                        {req.status === 'rejected' && (
                          <span className="px-2 py-0.5 rounded text-xs bg-rose-100 text-rose-800 font-medium">
                            مرفوض
                          </span>
                        )}
                        {req.status === 'installed' && (
                          <span className="px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-800 font-medium">
                            مثبّت على الجهاز
                          </span>
                        )}
                      </td>
                      <td className="p-3">
                        {req.status === 'pending' ? (
                          <input
                            type="text"
                            placeholder="ملاحظات توجيهية للمندوب..."
                            value={reviewNotes[req.id] || ''}
                            onChange={(e) =>
                              setReviewNotes({ ...reviewNotes, [req.id]: e.target.value })
                            }
                            className="text-xs px-2 py-1 border border-slate-300 rounded w-full"
                          />
                        ) : (
                          <span className="text-xs text-slate-500">{req.admin_notes || '—'}</span>
                        )}
                      </td>
                      <td className="p-3 text-center">
                        {req.status === 'pending' ? (
                          <div className="flex items-center justify-center gap-2">
                            <button
                              onClick={() => handleReviewRequest(req.id, 'approved')}
                              className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-medium transition cursor-pointer"
                            >
                              موافقة
                            </button>
                            <button
                              onClick={() => handleReviewRequest(req.id, 'rejected')}
                              className="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded text-xs font-medium transition cursor-pointer"
                            >
                              رفض
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">مكتمل</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add App Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-xl w-full p-6 shadow-2xl border border-slate-200 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 mb-4">
              <div>
                <h3 className="text-lg font-bold text-slate-800">رفع ومعاينة حزمة APK للفحص الخادمي</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  المعاينة في المتصفح استرشادية فقط؛ يتم الاعتماد النهائي (verified) حصرياً من الخادم بعد فحص التوقيع والمحتوى
                </p>
              </div>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="text-slate-400 hover:text-slate-700 text-xl font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Drag and Drop Zone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition ${
                isDragging
                  ? 'border-indigo-600 bg-indigo-50/80 scale-[0.99]'
                  : parsedInfo
                  ? 'border-emerald-400 bg-emerald-50/40'
                  : 'border-slate-300 hover:border-indigo-400 bg-slate-50/60'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".apk,application/vnd.android.package-archive"
                onChange={handleFileInputChange}
                className="hidden"
              />

              <div className="flex flex-col items-center">
                {parsingApk ? (
                  <>
                    <RefreshCw className="w-10 h-10 text-indigo-600 animate-spin mb-2" />
                    <p className="text-sm font-bold text-slate-800">جارٍ قراءة المعاينة الأولية لحزمة APK...</p>
                  </>
                ) : parsedInfo && selectedFile ? (
                  <>
                    <CheckCircle2 className="w-10 h-10 text-emerald-600 mb-2" />
                    <p className="text-sm font-bold text-slate-800">
                      معاينة أولية صالحة ({parsedInfo.signatureScheme}) — {selectedFile.name}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      الحجم: {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB • حزمة: {parsedInfo.packageName} • بانتظار الفحص الخادمي
                    </p>
                  </>
                ) : (
                  <>
                    <UploadCloud className="w-10 h-10 text-indigo-500 mb-2" />
                    <p className="text-sm font-bold text-slate-800">اسحب وأفلت ملف APK الموقع هنا</p>
                    <p className="text-xs text-slate-500 mt-1">يدعم تواقيع APK Signature Scheme v2 / v3 / v1</p>
                  </>
                )}
              </div>
            </div>

            {parseError && (
              <div className="mt-3 p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{parseError}</span>
              </div>
            )}

            {uploadError && (
              <div className="mt-3 p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{uploadError}</span>
              </div>
            )}

            {/* Upload Progress Bar */}
            {uploadProgress !== null && (
              <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold">
                  <span className="text-slate-700">
                    {uploadSuccess
                      ? 'تم رفع الحزمة لمسار Storage المحمي (غير قابل للاستبدال)'
                      : 'جارٍ الرفع إلى Storage المحمي...'}
                  </span>
                  <span className="font-mono text-indigo-600">{uploadProgress}%</span>
                </div>
                <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      uploadSuccess ? 'bg-emerald-500' : 'bg-indigo-600'
                    }`}
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            <form onSubmit={handleAddApp} className="space-y-4 mt-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">اسم التطبيق</label>
                  <input
                    type="text"
                    required
                    value={formData.appName}
                    onChange={(e) => setFormData({ ...formData, appName: e.target.value })}
                    className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">اسم الحزمة (معاينة)</label>
                  <input
                    type="text"
                    required
                    readOnly
                    value={formData.packageName}
                    className="w-full text-sm font-mono px-3 py-2 border border-slate-200 bg-slate-50 rounded-lg dir-ltr text-right"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">رقم الإصدار (معاينة)</label>
                  <input
                    type="number"
                    min="1"
                    required
                    readOnly
                    value={formData.versionCode || ''}
                    className="w-full text-sm font-mono px-3 py-2 border border-slate-200 bg-slate-50 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">اسم الإصدار (معاينة)</label>
                  <input
                    type="text"
                    required
                    readOnly
                    value={formData.versionName}
                    className="w-full text-sm font-mono px-3 py-2 border border-slate-200 bg-slate-50 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  مسار التخزين المحمي (Storage Path - بدون رابط تنزيل عام)
                </label>
                <input
                  type="text"
                  required
                  readOnly
                  value={formData.storagePath}
                  className="w-full text-xs font-mono px-3 py-2 border border-slate-200 bg-slate-50 rounded-lg dir-ltr text-right"
                />
              </div>

              {/* Expandable Technical Drawer */}
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowTechnicalDrawer(!showTechnicalDrawer)}
                  className="w-full px-4 py-2.5 bg-slate-50 flex items-center justify-between text-xs font-bold text-slate-700 hover:bg-slate-100 transition cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-600" />
                    <span>معاينة البصمات الرقمية بصيغة Hex (سيُعاد التحقق منها خادمياً)</span>
                  </div>
                  {showTechnicalDrawer ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>

                {showTechnicalDrawer && (
                  <div className="p-4 space-y-3 bg-white border-t border-slate-200">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        بصمة APK SHA-256 (64 حرف hex)
                      </label>
                      <input
                        type="text"
                        required
                        readOnly
                        value={formData.sha256Apk}
                        className="w-full text-xs font-mono px-3 py-2 border border-slate-200 bg-slate-50 rounded-lg dir-ltr text-right"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        بصمة شهادة X.509 SHA-256 (معاينة أولية - يثبتها الخادم)
                      </label>
                      <input
                        type="text"
                        required
                        readOnly
                        value={formData.sha256Cert}
                        className="w-full text-xs font-mono px-3 py-2 border border-slate-200 bg-slate-50 rounded-lg dir-ltr text-right"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-sm hover:bg-slate-50 transition cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={submitting || !parsedInfo}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-sm font-bold transition cursor-pointer shadow-sm"
                >
                  {submitting ? 'جارٍ الحفظ وطلب الفحص الخادمي...' : 'حفظ وطلب الفحص الخادمي'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Deploy Modal */}
      {isDeployModalOpen && selectedAppForDeploy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-200">
            <h3 className="text-lg font-bold text-slate-800 mb-1">
              توزيع تطبيق «{selectedAppForDeploy.app_name}»
            </h3>
            <p className="text-xs text-slate-500 mb-4">
              إصدار: v{selectedAppForDeploy.version_name} ({selectedAppForDeploy.version_code}) • حزمة: {selectedAppForDeploy.package_name}
            </p>

            <div className="space-y-4 mb-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-2">النطاق المستهدف للتوزيع</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setDeployTargetType('single')}
                    className={`p-3 rounded-xl border text-right transition cursor-pointer flex items-center gap-2.5 ${
                      deployTargetType === 'single'
                        ? 'border-indigo-600 bg-indigo-50/80 text-indigo-950 font-bold'
                        : 'border-slate-200 hover:border-slate-300 text-slate-700'
                    }`}
                  >
                    <Smartphone className="w-4 h-4 text-indigo-600 shrink-0" />
                    <div className="text-xs">
                      <div className="font-bold">جهاز محدد</div>
                      <div className="text-[11px] text-slate-500 font-normal">تفويض تنزيل خاص بهاتف واحد</div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDeployTargetType('all_active')}
                    className={`p-3 rounded-xl border text-right transition cursor-pointer flex items-center gap-2.5 ${
                      deployTargetType === 'all_active'
                        ? 'border-indigo-600 bg-indigo-50/80 text-indigo-950 font-bold'
                        : 'border-slate-200 hover:border-slate-300 text-slate-700'
                    }`}
                  >
                    <Users className="w-4 h-4 text-indigo-600 shrink-0" />
                    <div className="text-xs">
                      <div className="font-bold">جميع الأجهزة النشطة</div>
                      <div className="text-[11px] text-slate-500 font-normal">{activeDevices.length} جهاز نشط</div>
                    </div>
                  </button>
                </div>
              </div>

              {deployTargetType === 'single' ? (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">اختر الجهاز المستهدف</label>
                  <select
                    value={selectedDeviceUid}
                    onChange={(e) => setSelectedDeviceUid(e.target.value)}
                    className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="">-- حدد جهازاً مسجلاً --</option>
                    {activeDevices.map((d) => (
                      <option key={d.uid} value={d.uid}>
                        {d.metadata?.device_name || 'جهاز بدون اسم'} ({d.metadata?.rep_name || 'مندوب'}) - {d.uid.slice(0, 8)}...
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 space-y-1">
                  <div className="font-bold flex items-center gap-1.5 text-amber-950">
                    <AlertCircle className="w-4 h-4 text-amber-600" />
                    <span>تأكيد الإرسال الجماعي:</span>
                  </div>
                  <p>
                    سيتم إرسال أمر التثبيت الصامت وتفويض التنزيل إلى <strong>{activeDevices.length} جهازاً نشطاً</strong>.
                  </p>
                  {archivedCount > 0 && (
                    <p className="text-amber-800 text-[11px]">
                      (تم استبعاد {archivedCount} جهازاً مؤرشفاً تلقائياً).
                    </p>
                  )}
                </div>
              )}

              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                <label className="flex items-center gap-2.5 text-xs font-semibold text-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={addToKiosk}
                    onChange={(e) => setAddToKiosk(e.target.checked)}
                    className="rounded text-indigo-600 w-4 h-4"
                  />
                  <span>إضافة إلى شاشة الشركة (Kiosk) عبر تحديث سياسة الخادم بعد تأكيد التثبيت</span>
                </label>
                <p className="text-[11px] text-slate-500 mt-1 mr-6">
                  قرار الإضافة لشاشة الشركة يُحفظ كحقل غير قابل للتعديل من الهاتف (add_to_kiosk)، وتتحقق الوظيفة الخادمية منه داخل معاملة ذرية قبل رفع إصدار السياسة.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setIsDeployModalOpen(false)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-sm hover:bg-slate-50 transition cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={deploying || (deployTargetType === 'single' && !selectedDeviceUid)}
                onClick={handleDeployToDevices}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-sm font-bold transition flex items-center gap-2 cursor-pointer shadow-sm"
              >
                {deploying ? 'جارٍ الإرسال...' : 'إرسال أمر التثبيت'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
