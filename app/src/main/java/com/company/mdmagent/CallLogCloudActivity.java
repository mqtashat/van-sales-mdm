package com.company.mdmagent;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.graphics.Color;
import android.Manifest;
import android.widget.*;
import android.view.WindowManager;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.DocumentSnapshot;

/** Company-device activation is separate from the local compatibility test. */
public final class CallLogCloudActivity extends Activity {
    private TextView state;
    private Button activate;
    private boolean consent;
    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        if (!CallLogPilotActivity.canAccess(this)) { finish(); return; }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        DeviceScreen screen=new DeviceScreen(this);
        screen.title("مزامنة مكالمات الشركة",24,Color.WHITE);
        LinearLayout card=screen.card("إفصاح وتفعيل المزامنة");
        card.addView(screen.text("عند التفعيل تُرسل أرقام المكالمات الجديدة واتجاهها ووقت بدايتها ومدتها إلى لوحة مدير الشركة للتحليل. لا يُسجّل الصوت، ولا تُقرأ الرسائل أو جهات الاتصال. مدة عرض البيانات 30 يومًا. يُفعّل هذا الخيار على جهاز الشركة بعد إبلاغ الموظف. مكالمات الإنترنت غير مضمونة في سجل الهاتف.",15,Color.WHITE));
        card.addView(screen.text("يلزم تفعيل سياسة المكالمات من اللوحة ثم تأكيدها هنا. لا يُرفع السجل السابق للتأكيد. يعمل الإرسال بعد حفظ المكالمة وفي دورات المزامنة، وقد يؤخره النظام. بعد عودة الإنترنت تُقرأ المكالمات المتبقية في سجل الهاتف ضمن آخر 30 يومًا؛ حذفها من الهاتف قبل الإرسال يمنع استعادتها.",14,Color.LTGRAY));
        state=screen.text("",14,DeviceScreen.BLUE);card.addView(state);
        activate=screen.button("تفعيل إرسال المكالمات الجديدة للوحة");card.addView(activate);
        activate.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("تفعيل معلن على جهاز الشركة")
            .setMessage("أؤكد إبلاغ الموظف بأن أرقام المكالمات الجديدة ووقتها ومدتها ستُرسل إلى لوحة الشركة. هذا التفعيل منفصل عن اختبار المكالمات المحلي.")
            .setNegativeButton("إلغاء",null).setPositiveButton("تأكيد وبدء",(d,w)->{
                if(!CallLogPilotActivity.canAccess(this)) {finish();return;}
                consent=true;
                if(CallLogSync.permitted(this)) activate();
                else requestPermissions(new String[]{Manifest.permission.READ_CALL_LOG},3201);
            }).show());
        Button sync=screen.button("مزامنة المكالمات الآن");card.addView(sync);
        sync.setOnClickListener(v->{if(CallLogPilotActivity.canAccess(this)){CallLogSync.request(this);state.setText("طُلبت المزامنة. اضغط تحديث الحالة بعد اكتمالها.");}});
        Button refresh=screen.button("تحديث الحالة");card.addView(refresh);refresh.setOnClickListener(v->showState());
        Button stop=screen.button("إيقاف الإرسال من هذا الهاتف");card.addView(stop);
        stop.setOnClickListener(v->{if(!CallLogPilotActivity.canAccess(this)){finish();return;}
            CallLogSync.prefs(this).edit().clear().commit();
            state.setText("أُوقف الإرسال محليًا. البيانات التي سبق إرسالها تبقى وفق مدة الاحتفاظ. عطّل السياسة من اللوحة أيضًا لإيقاف قبول الخادم لأي إرسال جارٍ.");
        });
        Button back=screen.button("العودة للصيانة");screen.footer.addView(back);back.setOnClickListener(v->finish());
        screen.show();showState();
    }
    @Override protected void onResume(){super.onResume();if(!CallLogPilotActivity.canAccess(this))finish();}
    private void showState(){
        if(!CallLogPilotActivity.canAccess(this)){finish();return;}
        android.content.SharedPreferences s=CallLogSync.prefs(this);
        String uid=SyncEngine.getCurrentAuthenticatedUid();
        state.setText("التفعيل المحلي: "+(uid!=null && uid.equals(s.getString("uid","")) && s.getLong("since",0)>0 ? "مؤكد؛ يلزم استمرار سماح السياسة" : "غير مفعّل")
            +"\nإذن السجل: "+(CallLogSync.permitted(this)?"ممنوح":"غير ممنوح")+"\n"+s.getString("message","لم تُؤكد مزامنة بعد."));
    }
    private void activate(){
        if(!consent || !CallLogPilotActivity.canAccess(this))return;
        consent=false;activate.setEnabled(false);state.setText("جارٍ التحقق من سياسة الخادم...");
        String uid=SyncEngine.getCurrentAuthenticatedUid();
        AgentApp.SYNC.execute(()->{
            try{
                DocumentSnapshot p=CallLogSync.policy(FirebaseFirestore.getInstance(),uid);
                if(!CallLogSync.validPolicy(p))throw new IllegalStateException("Disabled");
                String session=p.getString("collection_id");
                long serverStart=p.getTimestamp("activated_at").toDate().getTime();
                runOnUiThread(()->{
                    if(isFinishing()||isDestroyed()||!CallLogPilotActivity.canAccess(this)||!uid.equals(SyncEngine.getCurrentAuthenticatedUid()))return;
                    long since=Math.max(System.currentTimeMillis(),serverStart);
                    if(!CallLogSync.prefs(this).edit().clear().putString("uid",uid).putString("session",session).putLong("since",since).commit()){
                        state.setText("تعذر حفظ التفعيل؛ لم يبدأ الإرسال.");
                    }else{state.setText("تم التفعيل للمكالمات الجديدة فقط.");CallLogSync.request(this);}
                    activate.setEnabled(true);
                });
            }catch(Exception e){runOnUiThread(()->{if(!isDestroyed()){state.setText("تعذر التفعيل. فعّل سياسة المكالمات من اللوحة وتحقق من نشر القواعد والاتصال.");activate.setEnabled(true);}});}
        });
    }
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){
        super.onRequestPermissionsResult(request,permissions,results);
        if(request==3201){if(consent&&CallLogSync.permitted(this))activate();else{consent=false;showState();}}
    }
}
