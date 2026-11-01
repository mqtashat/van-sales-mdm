# INJAZ MDM — تجربة جهاز واحد

تطبيق Android أصلي مرتبط بمشروع Firebase `vansales-mdm`، والحزمة `com.company.mdmagent`.
**نسخة تجريبية وليست جاهزة للتعميم على أجهزة المندوبين.**

## الموجود الآن

- إظهار حالة Device Owner قبل أي تغيير.
- تسجيل جهاز بهوية Firebase Anonymous منفصلة؛ الاعتماد يدوي من مسؤول Firebase.
- منع جميع أشكال مشاركة الإنترنت بالقيد الرسمي `DISALLOW_CONFIG_TETHERING` وإزالة قيدنا بأمر صريح.
- إبقاء البلوتوث نفسه والطابعة والمكالمات وتطبيق المبيعات دون قيود إضافية.
- إبلاغ الخادم بالسياسة التي تحقّق التطبيق من تنفيذها والأخطاء الفعلية.
- الاستماع أثناء فتح التطبيق، ومزامنة WorkManager دورية (15 دقيقة كحد أدنى؛ قد تتأخر).
- لا موقع جغرافي، لا صور، لا جهات اتصال، لا أوامر مسح أو تغيير كلمة مرور.

ليست هناك لوحة ويب أو FCM أو سياسة جماعية بعد. يوجد حظر فردي للتطبيقات المحمّلة؛ تطبيقات النظام مستثناة حاليًا. هذه مراحل لاحقة بعد اختبار الجهاز.
استخدام Anonymous Auth هنا لا يعني السماح لأي جهاز: لا يمكنه اعتماد نفسه أو تعديل السياسات.
حالة الهاتف تقرير ذاتي من التطبيق، وليست إثبات سلامة أو attestation.

## 1. إعداد Firebase — لا تمسح الهاتف

1. Authentication → Get started → Sign-in method → Anonymous → Enable.
2. أنشئ Cloud Firestore بالوضع Production إن لم تكن موجودة. اختر الموقع بعناية فهو غير قابل للتغيير بسهولة.
3. من Firestore → Rules استبدل القواعد بملف [firestore.rules](firestore.rules) ثم Publish.
   هذه قواعد مشروع MDM مستقل؛ لا تستبدل بها قواعد قاعدة مشتركة مع نظام مبيعات قائم.
4. `google-services.json` المرفق إعداد عميل وليس مفتاح Service Account. لا ترفع مفاتيح الإدارة أو private_key.

رفع الملفات إلى GitHub **لا ينشر قواعد Firebase** ولا يفعّل Authentication تلقائيًا.

## 2. تحميل APK وتسجيل جهاز تجريبي

من Actions → Verify and build pilot APK → أحدث تشغيل ناجح → Artifacts → injaz-mdm-pilot-debug.
فك ZIP وثبّت APK على جهاز اختبار تحت إشراف المسؤول، وافتحه، ثم اضغط تسجيل جهاز التجربة.
انسخ UID الظاهر؛ هو معرّف تسجيل وليس اسم المندوب ولا رقم الهاتف.
لا تحذف بيانات التطبيق: فقدان UID قد يقطع ارتباطه بسياسة كانت مطبّقة بالفعل.

في Firestore أنشئ مستندًا في مجموعة `enrollments`، اسم المستند هو UID:

```json
{"approved": true}
```

ثم مستندًا في `policies` بنفس UID بالحقول والأنواع التالية:

```json
{"schema_version": 1, "revision": 1, "block_tethering": false, "blocked_apps": []}
```

الأرقام integer والـBoolean قيمة حقيقية وليست نصًا. يبدأ الاختبار بالسماح (false).
افتح التطبيق واضغط مزامنة. قبل Device Owner سيظهر خطأ واضح ولن يفرض القيد.
يكتب التطبيق نتيجة الفحص في `deviceStatus/{UID}`. لا تكتب السياسات في مستند الحالة.

## 3. اختبار Device Owner — مع المسؤول فقط

احفظ البيانات وتأكد من مزامنة فواتير المندوب أولًا. لا تنفذ فورمات.
وجود Family Link/حسابات Google أو ملف عمل قد يمنع التفعيل. إزالة حساب بإذن المشرف تزيل بعض بياناته المحلية؛
**لا تختَر Reset device & delete data، ولا تحذف حساب Google نفسه**.
يجب ترتيب إزالة الحساب الخاضع للإشراف/الإدارة السابقة على جهاز التجربة قبل محاولة التسجيل.
لا يوجد ضمان أن POVA 5 يقبل التفعيل دون فورمات؛ عند الرفض توقف واحتفظ برسالة الخطأ.

على كمبيوتر موثوق باستخدام Android Platform Tools الرسمية وUSB debugging، بعد تثبيت APK:

```sh
adb devices
adb shell dpm set-device-owner com.company.mdmagent/.AdminReceiver
```

لا تستخدم أوامر مسح أو تجاوز حماية عند الفشل. بعد النجاح أعد فتح التطبيق وتأكد أنه يعرض Device Owner مفعّل.
في هذا الإصدار التجريبي لا نمنع USB debugging أو reset أو uninstall بسياسة إضافية؛ لا تسلّم الجهاز للعمل بعد.

## 4. اختبار المنع والرجوع

1. غيّر السياسة إلى `revision: 2` و`block_tethering: true`، ثم مزامنة.
2. تأكد من `applied_revision: 2` و`tethering_restricted: true` و`error: ""` في الحالة.
3. جرّب تشغيل المشاركة من الإعدادات والاختصار السريع وUSB وBluetooth.
4. اختبر الطباعة والمكالمات وتطبيق المبيعات. أعد التشغيل واختبر أن القيد مستمر دون شبكة.
5. **اختبر الرجوع قبل التعميم:** `revision: 3` و`block_tethering: false`، ثم مزامنة والتحقق.

ارفع revision في كل تعديل. السياسة الناقصة أو الخاطئة لا تفك القيود تلقائيًا.
حذف السياسة أو سحب الاعتماد أو انقطاع الإنترنت **لا يلغي قيدًا مطبّقًا**.
لفك المنع: أعد الاعتماد/الاتصال وعدّل السياسة إلى false بإصدار أعلى وتحقق من التنفيذ أولًا.
إزالة Device Owner نفسها ليست جزءًا من الواجهة؛ خطة الخروج وترقية التوقيع تحتاج تجهيزًا قبل الاستخدام الفعلي.

## البناء والاختبارات

JDK 17 + Gradle 8.9 + Android SDK 35:

```sh
gradle testDebugUnitTest lintDebug assembleDebug
```

لا نفترض وجود gradlew غير مرفوع؛ GitHub Actions يثبت Gradle بالإصدار المحدد.
الاختبارات تشمل صلاحيات Firestore (عزل الأجهزة ومنع تعديل السياسات والاعتماد الذاتي) وصحة السياسات وإصداراتها.

**التوقيع Debug مؤقت:** إعادة البناء على runner جديد قد تعطي توقيعًا مختلفًا ولن يثبت APK الجديد كتحديث.
لا تثبّت إصدارات متكررة على جهاز Device Owner قبل تجهيز مفتاح توقيع ثابت وآلية تحديث.
لا تفترض أن حذف التطبيق وإعادة تثبيته حل؛ التطبيق المالك للجهاز محمي وقد تحتاج إعادة تهيئة لفكه.
قبل التعميم: توقيع Release ثابت محفوظ كسر، إدارة التسجيل والإلغاء، ربط صلاحيات المسؤول، سياسة حظر التطبيقات،
تحديثات آمنة وخطة استرجاع واختبارات POVA 5 فعلية. لا وعود بتوقيت فوري أو كلفة مجانية للأبد.

## تجربة حظر التطبيقات

أضف اسم حزمة تطبيق محمّل غير أساسي إلى مصفوفة `blocked_apps` ثم زد revision.
لإعادة إظهاره احذف اسم الحزمة من المصفوفة وزد revision؛ التطبيق يعيد فقط ما أخفاه هو.
المصفوفة الفارغة تعني إعادة إظهار التطبيقات التي أخفاها تطبيقنا. فقدان الحقل خطأ ولا يعني فتح الكل.
يمنع التطبيق إخفاء نفسه ولوحة المفاتيح والهاتف والواجهة الرئيسية وتطبيقات النظام.
قد تكون YouTube أو Chrome تطبيقات نظام على POVA 5؛ لن نضمن حظرها بهذه النسخة.
لا تمنع هذه النسخة تثبيت تطبيقات جديدة ولا تطبّق قائمة سماح شاملة. قبل استبدال Family Link بالكامل نحتاج حصر تطبيقاتكم واختبار بقية القيود.



### Pilot 0.3.1: network recovery experiment

Version code 4; update with the same persistent signing key (no reset). No Firestore schema,
rules, dashboard or server changes. The foreground service now observes INTERNET + VALIDATED
transitions, including WAN recovery while Wi-Fi stays associated; stale callbacks from an old
default network are ignored. Initial validation requests one sync; duplicate validated callbacks
are deduplicated. Validation is an OS signal, not proof that Firebase is reachable.

Direct sync transport failures schedule one unique connected WorkManager job (30-second minimum
delay, exponential backoff, at most 3 retries). Workers do not recursively schedule recovery jobs.
Policy parse/permission errors are not retried. Policy errors retain their original cause after
status reporting. Logs include screen-interactive/idle state and successful sync duration.
WorkManager delays are not deadlines. This does not bypass OEM process freezing: device logs
showed Transsion Hiber freezing the process despite an active systemExempted foreground service.

Acceptance on the physical phone: unplug USB, lock screen, remove WAN internet without dropping
Wi-Fi association, save a policy, restore WAN without touching phone. Record requested/applied
revision and latency; repeat after prolonged idle and reboot. A passing CI build is not proof
that this physical-device scenario passes. Keep the previous APK for comparison.
