package com.company.mdmagent;

import android.Manifest;
import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.provider.CallLog;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.Timestamp;
import com.google.firebase.firestore.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Explicit local disclosure + server policy, fail closed, no audio/contact collection. */
final class CallLogSync {
    static final long RETENTION_MS = 30L * 24 * 60 * 60 * 1000;
    static final String PREFS = "call-log-cloud-v1";
    private static final AtomicBoolean BUSY = new AtomicBoolean();
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, 0); }
    static boolean permitted(Context c) { return c.checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED; }
    static void request(Context c) {
        if (!BUSY.compareAndSet(false, true)) return;
        Context app = c.getApplicationContext();
        AgentApp.SYNC.execute(() -> {
            try { sync(app); } catch (Exception e) {
                // Never log exception text: provider errors may include a phone number.
                prefs(app).edit().putString("message", "تعذرت مزامنة المكالمات؛ لم يُؤكد الإرسال. تحقق من الاتصال والسياسة والصلاحيات.").apply();
            } finally { BUSY.set(false); }
        });
    }
    static DocumentSnapshot policy(FirebaseFirestore db, String uid) throws Exception {
        return Tasks.await(db.collection("callLogPolicies").document(uid).get(Source.SERVER), 20, TimeUnit.SECONDS);
    }
    static boolean validPolicy(DocumentSnapshot p) {
        return p.exists() && Long.valueOf(1).equals(p.getLong("schema_version"))
                && Boolean.TRUE.equals(p.getBoolean("enabled")) && p.getLong("revision") != null && p.getLong("revision") > 0
                && p.getString("collection_id") != null && p.getString("collection_id").matches("[a-zA-Z0-9_-]{16,80}")
                && p.getTimestamp("activated_at") != null && Long.valueOf(30).equals(p.getLong("retention_days"));
    }
    static boolean consentMatches(SharedPreferences s, String uid, String session) {
        return uid.equals(s.getString("uid", "")) && session.equals(s.getString("session", "")) && s.getLong("since", 0) > 0;
    }
    static String key(String session, long id, long date) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest((session + ":" + id + ":" + date).getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(); for (byte b : digest) out.append(String.format(Locale.ROOT, "%02x", b & 255));
            return out.toString();
        } catch (Exception e) { throw new IllegalStateException("Digest unavailable"); }
    }
    static String safeNumber(String n, boolean visible) {
        if (!visible || n == null) return "";
        String clean = n.replaceAll("[^+0-9*#]", "");
        return clean.length() <= 40 ? clean : "";
    }
    static boolean afterCursor(long date, long id, long cursorDate, long cursorId) {
        return date > cursorDate || (date == cursorDate && id > cursorId);
    }
    static void sync(Context c) throws Exception {
        String uid = SyncEngine.getCurrentAuthenticatedUid();
        DevicePolicyManager dpm = (DevicePolicyManager)c.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (uid == null || dpm == null || !dpm.isDeviceOwnerApp(c.getPackageName())) return;
        FirebaseFirestore db = FirebaseFirestore.getInstance();
        DocumentSnapshot enrollment = Tasks.await(db.collection("enrollments").document(uid).get(Source.SERVER), 20, TimeUnit.SECONDS);
        if (!Boolean.TRUE.equals(enrollment.getBoolean("approved"))) return;
        DocumentSnapshot p = policy(db, uid);
        SharedPreferences s = prefs(c);
        if (!validPolicy(p)) { s.edit().putString("message", "سياسة المكالمات متوقفة؛ لم تتم قراءة السجل.").apply(); report(db, uid, p, "disabled", 0, false, 0); return; }
        String session = p.getString("collection_id");
        if (!consentMatches(s, uid, session)) { s.edit().putString("message", "بانتظار تأكيد التفعيل المحلي للجلسة الحالية.").apply(); report(db, uid, p, "awaiting_activation", 0, false, 0); return; }
        final long consentStart = s.getLong("since", 0);
        long since = Math.max(consentStart, p.getTimestamp("activated_at").toDate().getTime());
        if (!permitted(c)) { s.edit().putString("message", "إذن سجل المكالمات غير متاح؛ لم تتم القراءة.").apply(); report(db, uid, p, "permission_required", since, false, 0); return; }
        final long now = System.currentTimeMillis();
        long floor = Math.max(since, now - RETENTION_MS + 60000);
        long cursorDate = Math.max(floor, s.getLong("cursor_date", floor));
        long cursorId = cursorDate == s.getLong("cursor_date", -1) ? s.getLong("cursor_id", -1) : -1;
        if (cursorDate > now) { report(db, uid, p, "clock_error", since, false, 0); return; }
        int changed = 0; boolean more = true;
        for (int page = 0; page < 5 && more; page++) {
            if (!consentMatches(s, uid, session) || s.getLong("since",0) != consentStart || !permitted(c)) return;
            List<Map<String,Object>> rows = new ArrayList<>(); List<String> keys = new ArrayList<>();
            long lastDate = cursorDate, lastId = cursorId; int count = 0;
            try (Cursor cr = c.getContentResolver().query(CallLog.Calls.CONTENT_URI.buildUpon()
                    .appendQueryParameter(CallLog.Calls.LIMIT_PARAM_KEY, "101").build(), CallLogPilotReader.PROJECTION,
                    "(" + CallLog.Calls.DATE + " > ? OR (" + CallLog.Calls.DATE + " = ? AND " + CallLog.Calls._ID + " > ?)) AND " + CallLog.Calls.DATE + " <= ?",
                    new String[]{""+cursorDate,""+cursorDate,""+cursorId,""+now}, CallLog.Calls.DATE + " ASC, " + CallLog.Calls._ID + " ASC")) {
                if (cr == null) throw new IllegalStateException("Provider unavailable");
                while (cr.moveToNext()) {
                    if (++count > 100) break;
                    long date = cr.getLong(cr.getColumnIndexOrThrow(CallLog.Calls.DATE));
                    long id = cr.getLong(cr.getColumnIndexOrThrow(CallLog.Calls._ID));
                    if (date < floor || date > now || !afterCursor(date,id,lastDate,lastId)) throw new IllegalStateException("Invalid provider ordering");
                    lastDate = date; lastId = id;
                    int pi = cr.getColumnIndexOrThrow(CallLog.Calls.NUMBER_PRESENTATION);
                    boolean visible = !cr.isNull(pi) && cr.getInt(pi) == CallLog.Calls.PRESENTATION_ALLOWED;
                    String number = safeNumber(cr.getString(cr.getColumnIndexOrThrow(CallLog.Calls.NUMBER)), visible);
                    int type = cr.getInt(cr.getColumnIndexOrThrow(CallLog.Calls.TYPE));
                    if (type < 1 || type > 7) type = 0;
                    int di = cr.getColumnIndexOrThrow(CallLog.Calls.DURATION);
                    long duration = cr.isNull(di) ? -1 : cr.getLong(di);
                    if (duration < -1 || duration > 604800) duration = -1;
                    String key = key(session, id, date);
                    // A digest only is cached; raw numbers and call records remain in the system provider.
                    String fingerprint = key(number + ":" + type, duration, date);
                    if (fingerprint.equals(s.getString("fp_" + key, ""))) continue;
                    Map<String,Object> row = new HashMap<>();
                    row.put("schema_version",1); row.put("collection_id",session); row.put("started_at",new Timestamp(new Date(date)));
                    row.put("number",number); row.put("number_available",!number.isEmpty()); row.put("call_type",type);
                    row.put("duration_seconds",duration); row.put("received_at",FieldValue.serverTimestamp());
                    row.put("expires_at",new Timestamp(new Date(date + RETENTION_MS))); row.put("agent_version",SyncEngine.AGENT_VERSION);
                    rows.add(row); keys.add(key + ":" + fingerprint);
                }
            }
            final long expectedRevision = p.getLong("revision");
            if (!rows.isEmpty()) {
                Tasks.await(db.runTransaction(tx -> {
                    DocumentSnapshot current = tx.get(db.collection("callLogPolicies").document(uid));
                    if (!validPolicy(current) || !session.equals(current.getString("collection_id"))
                            || !Long.valueOf(expectedRevision).equals(current.getLong("revision"))
                            || !consentMatches(s,uid,session) || s.getLong("since",0) != consentStart || !permitted(c)) throw new IllegalStateException("Collection no longer enabled");
                    for (int i=0;i<rows.size();i++) tx.set(db.collection("deviceCallLogs").document(uid).collection("calls").document(keys.get(i).substring(0,64)),rows.get(i));
                    return true;
                }),25,TimeUnit.SECONDS);
                if (!consentMatches(s,uid,session) || s.getLong("since",0) != consentStart) return;
                SharedPreferences.Editor editor = s.edit();
                for (String pair : keys) editor.putString("fp_"+pair.substring(0,64),pair.substring(65));
                if (!editor.commit()) throw new IllegalStateException("Checkpoint unavailable");
                changed += rows.size();
            }
            cursorDate = lastDate; cursorId = lastId; more = count > 100;
            if (!consentMatches(s,uid,session) || s.getLong("since",0) != consentStart) return;
            if (!more) { cursorDate = Math.max(floor, now - 24L*60*60*1000); cursorId = -1; }
            if (!s.edit().putLong("cursor_date",cursorDate).putLong("cursor_id",cursorId).commit()) throw new IllegalStateException("Checkpoint unavailable");
        }
        // Bound digest cache; clearing it can cause idempotent rewrites, never duplicate call documents.
        if (s.getAll().size() > 3000) { SharedPreferences.Editor e=s.edit(); for(String k:s.getAll().keySet()) if(k.startsWith("fp_")) e.remove(k); e.commit(); }
        report(db, uid, p, more ? "catching_up" : "synced", since, more, changed);
        s.edit().putString("message", more ? "مزامنة جزئية؛ ستُستكمل الدفعة التالية." : "تم تأكيد مزامنة المكالمات مع الخادم.").putLong("last_success",now).apply();
    }
    private static void report(FirebaseFirestore db,String uid,DocumentSnapshot p,String state,long since,boolean more,int count) throws Exception {
        Map<String,Object> m=new HashMap<>();
        m.put("schema_version",1); m.put("state",state); m.put("policy_revision",p.exists() && p.getLong("revision")!=null ? p.getLong("revision") : 0);
        m.put("collection_id",p.exists() && p.getString("collection_id")!=null ? p.getString("collection_id") : "");
        m.put("local_started_at",since>0 ? new Timestamp(new Date(since)) : null); m.put("reported_at",FieldValue.serverTimestamp());
        m.put("has_more",more); m.put("uploaded_count",count); m.put("agent_version",SyncEngine.AGENT_VERSION);
        Tasks.await(db.collection("callLogStatus").document(uid).set(m),20,TimeUnit.SECONDS);
    }
    private CallLogSync() {}
}
