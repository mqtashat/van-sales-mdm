import React, {useEffect, useRef, useState} from 'react';
import {collection, doc, onSnapshot, runTransaction, serverTimestamp, type Firestore} from 'firebase/firestore';
import type {AdminIdentity, DeviceAppInventoryDoc, MergedDeviceRecord} from '../types/mdm';

export type KioskPolicy = {schema_version:1;revision:number;enabled:boolean;allowed_apps:string[];exit_salt:string;exit_hash:string};
export function validateKiosk(p:unknown):p is KioskPolicy {
  const x=p as KioskPolicy;
  return !!x && x.schema_version===1 && Number.isSafeInteger(x.revision)&&x.revision>0
    && typeof x.enabled==='boolean' && Array.isArray(x.allowed_apps)&&x.allowed_apps.length<=50
    && (!x.enabled||x.allowed_apps.length>0) && x.allowed_apps.every(p=>typeof p==='string'&&p.length<=150&&/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(p))
    && /^[a-f0-9]{32}$/.test(x.exit_salt)&&/^[a-f0-9]{64}$/.test(x.exit_hash);
}
export async function passwordVerifier(password:string){
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:120000},key,256);
  const hex=(a:Uint8Array)=>Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');
  return {exit_salt:hex(salt),exit_hash:hex(new Uint8Array(bits))};
}
export function KioskPanel({db,device,actor,inventory}:{db:Firestore;device:MergedDeviceRecord;actor:AdminIdentity;inventory:DeviceAppInventoryDoc|null}){
 const [remote,setRemote]=useState<KioskPolicy|null>(null),[status,setStatus]=useState<Record<string,any>|null>(null);
 const [enabled,setEnabled]=useState(false),[apps,setApps]=useState<string[]>([]),[password,setPassword]=useState(''),[confirm,setConfirm]=useState('');
 const [error,setError]=useState(''),[message,setMessage]=useState(''),[ready,setReady]=useState(false),[busy,setBusy]=useState(false);
 const [expected,setExpected]=useState<number|null>(null);const dirty=useRef(false);
 useEffect(()=>{
  setReady(false);dirty.current=false;setRemote(null);setStatus(null);setPassword('');setConfirm('');setError('');setMessage('');
  const stop=onSnapshot(doc(db,'kioskPolicies',device.uid),{includeMetadataChanges:true},s=>{
   const data=s.exists()?s.data():null;
   if(data&&!validateKiosk(data)){setError('إعدادات شاشة الشركة غير صالحة؛ لم تُستبدل بقيم افتراضية.');setReady(false);return;}
   const p=data as KioskPolicy|null;setRemote(p);setReady(!s.metadata.fromCache);
   if(!dirty.current){setEnabled(p?.enabled??false);setApps(p?.allowed_apps??[]);setExpected(p?.revision??null);}
  },e=>{setReady(false);setError('تعذر قراءة إعدادات الشاشة. تحقق من نشر قواعد النسخة الجديدة: '+e.message);});
  const stopStatus=onSnapshot(doc(db,'kioskStatus',device.uid),s=>setStatus(s.exists()?s.data():null),e=>setError('تعذر قراءة حالة الشاشة: '+e.message));
  return()=>{stop();stopStatus();};
 },[db,device.uid]);
 const change=()=>{dirty.current=true;setMessage('');};
 async function save(){
  setBusy(true);setError('');setMessage('');
  try{
   if(!ready||!actor.isAuthorizedAdmin)throw Error('يلزم اتصال بالخادم وصلاحية مدير.');
   if(password&&(password.length<12||password!==confirm))throw Error('استخدم كلمة مرور من 12 حرفًا على الأقل، وأكدها بنفس القيمة.');
   if(!remote&&!password)throw Error('حدد كلمة مرور الصيانة قبل حفظ الإعدادات.');
   const credential=password?await passwordVerifier(password):{exit_salt:remote!.exit_salt,exit_hash:remote!.exit_hash};
   const next:KioskPolicy={schema_version:1,revision:(expected??0)+1,enabled,allowed_apps:[...new Set(apps)].sort(),...credential};
   if(!validateKiosk(next))throw Error('اختر تطبيقًا واحدًا على الأقل وحتى 50 تطبيقًا.');
   await runTransaction(db,async tx=>{
    const ref=doc(db,'kioskPolicies',device.uid);
    const [old,enrollment,phone,policy,scan]=await Promise.all([tx.get(ref),tx.get(doc(db,'enrollments',device.uid)),tx.get(doc(db,'deviceStatus',device.uid)),tx.get(doc(db,'policies',device.uid)),tx.get(doc(db,'deviceAppInventory',device.uid))]);
    if((old.exists()?old.data().revision:null)!==expected)throw Error('تغيرت إعدادات الجهاز أثناء التعديل. أغلق التفاصيل وافتحها لإعادة التحميل.');
    if(enrollment.data()?.approved!==true)throw Error('الجهاز غير معتمد.');
    if(enabled){
     if(!/^0\.[4-9]\./.test(phone.data()?.agent_version??'')||phone.data()?.android_sdk<30)throw Error('ثبّت تحديث Android 0.4.0 أو أحدث على جهاز Android 11 أو أحدث أولًا.');
     const actual=scan.data()?.apps??[];
     for(const pkg of next.allowed_apps){
      const app=actual.find((a:any)=>a.package_name===pkg);
      if(!app||!app.has_launcher_icon||app.is_enabled===false||app.is_hidden_by_agent)throw Error('التطبيق غير متاح حسب آخر جرد: '+pkg);
      if(['com.android.settings','com.android.vending','com.company.mdmagent'].includes(pkg)||policy.data()?.blocked_apps?.includes(pkg))throw Error('أزل التطبيق من الحظر أولًا أو اختر تطبيق عمل مناسبًا: '+pkg);
     }
    }
    tx.set(ref,next);
    tx.set(doc(collection(db,'auditLogs')),{actor_uid:actor.uid,actor_email:actor.email,target_uid:device.uid,action:'update_policy',summary:`شاشة الشركة: ${enabled?'تفعيل':'تعطيل'}، ${apps.length} تطبيق، إصدار ${next.revision}`,before:old.exists()?{revision:old.data().revision,enabled:old.data().enabled}:{exists:false},after:{revision:next.revision,enabled,allowed_apps:next.allowed_apps},created_at:serverTimestamp()});
   });
   dirty.current=false;setExpected(next.revision);setRemote(next);setPassword('');setConfirm('');setMessage('حُفظ الطلب؛ بانتظار تأكيد الهاتف.');
  }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 }
 const selectable=(inventory?.apps??[]).filter(a=>a.has_launcher_icon&&!['com.android.settings','com.android.vending','com.company.mdmagent'].includes(a.package_name));
 const confirmed=remote&&status?.configured_revision===remote.revision&&status?.active===remote.enabled&&!status?.error&&!status?.maintenance&&(!remote.enabled||status.install_blocked);
 return <section className="space-y-5 p-5" dir="rtl">
  <h3 className="text-xl font-bold">شاشة إنجاز لأجهزة الشركة</h3>
  <p className="text-sm text-slate-600">تظهر التطبيقات المختارة فقط على شاشة العمل. يُمنع التثبيت الحر أثناء التفعيل، وتبقى خدمات النظام الضرورية تعمل بالخلفية. إعدادات الحظر ومشاركة الإنترنت مستقلة.</p>
  <div className="rounded-xl bg-slate-100 p-3">{status?.maintenance?'الجهاز في صيانة المدير؛ احفظ إصدارًا جديدًا لإعادة التفعيل.':confirmed?'أكد الهاتف تطبيق إعدادات الشاشة.':'بانتظار تأكيد الهاتف.'}<br/>{status?.reported_at?.toDate?.().toLocaleString('ar-JO')??'لم يصل تقرير بعد'}{status?.error&&<p className="text-red-700">{status.error}</p>}</div>
  {error&&<p role="alert" className="text-red-700">{error}</p>}{message&&<p role="status" className="text-blue-700">{message}</p>}
  <label className="flex gap-2 font-bold"><input type="checkbox" checked={enabled} onChange={e=>{change();setEnabled(e.target.checked);}}/>تفعيل شاشة إنجاز ومنع تثبيت التطبيقات</label>
  <p className="text-sm">التطبيقات المسموحة ({apps.length}/50) — الجرد: {inventory?.reported_at?.toDate?.().toLocaleString('ar-JO')??'لم يصل من الجهاز'}</p>
  <div className="grid gap-2 sm:grid-cols-2">{selectable.map(a=><label key={a.package_name} className="flex gap-2 border rounded-lg p-3"><input type="checkbox" checked={apps.includes(a.package_name)} disabled={a.is_hidden_by_agent||a.is_enabled===false} onChange={e=>{change();setApps(e.target.checked?[...apps,a.package_name]:apps.filter(p=>p!==a.package_name));}}/><span>{a.app_name}<small className="block text-slate-500" dir="ltr">{a.package_name}</small>{a.is_hidden_by_agent?'محظور؛ فك الحظر أولًا':a.is_enabled===false?'معطل على الهاتف':''}</span></label>)}</div>
  {apps.filter(p=>!selectable.some(a=>a.package_name===p)).map(p=><p key={p}>غير متاح في آخر جرد: {p} <button className="text-red-700" onClick={()=>{change();setApps(apps.filter(x=>x!==p));}}>إزالة من المسموح</button></p>)}
  <div className="space-y-2 border rounded-xl p-4"><p className="font-bold">كلمة مرور صيانة خاصة بهذا الجهاز</p><p className="text-sm">احفظها لدى المدير قبل التفعيل. تتيح الخروج محليًا دون إنترنت، مع بقاء الحظر ومنع مشاركة الإنترنت. لإضافة تطبيق جديد: يدخل المدير للصيانة، يثبته، ثم يختاره هنا ويعيد التفعيل. {remote?'اترك الحقلين فارغين للاحتفاظ بالكلمة الحالية.':''}</p>
  <input className="border rounded p-2 w-full" type="password" autoComplete="new-password" placeholder="12 حرفًا على الأقل" value={password} onChange={e=>{change();setPassword(e.target.value);}}/>
  <input className="border rounded p-2 w-full" type="password" autoComplete="new-password" placeholder="تأكيد كلمة المرور" value={confirm} onChange={e=>setConfirm(e.target.value)}/></div>
  <button className="bg-blue-700 text-white rounded-lg p-3 disabled:opacity-40" disabled={busy||!ready} onClick={save}>{busy?'جارٍ الحفظ…':'حفظ إعدادات شاشة الشركة'}</button>
 </section>;
}
