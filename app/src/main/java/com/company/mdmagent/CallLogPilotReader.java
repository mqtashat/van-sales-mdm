package com.company.mdmagent;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.os.CancellationSignal;
import android.provider.CallLog;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Read-only, on-demand diagnostic. Never logs, persists or uploads call data. */
final class CallLogPilotReader {
    static final int PAGE_SIZE = 100;
    static final String[] PROJECTION = {CallLog.Calls._ID, CallLog.Calls.NUMBER,
            CallLog.Calls.NUMBER_PRESENTATION, CallLog.Calls.TYPE, CallLog.Calls.DATE,
            CallLog.Calls.DURATION};

    static final class Row {
        final String number;
        final int type;
        final long startedAt, duration;
        Row(String number, int type, long startedAt, long duration) {
            this.number = number; this.type = type; this.startedAt = startedAt; this.duration = duration;
        }
    }
    static final class Result {
        final List<Row> rows;
        final boolean partial;
        Result(List<Row> rows, boolean partial) {
            this.rows = Collections.unmodifiableList(new ArrayList<>(rows)); this.partial = partial;
        }
    }

    static Result read(Context context, long since, long now, CancellationSignal signal) {
        if (context.checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED)
            throw new SecurityException("Call log permission unavailable");
        if (since <= 0 || now < since || now - since >= CallLogPilotSession.MAX_AGE_MS)
            throw new IllegalStateException("Session expired");
        // Both SQL bounds and cursor-side validation are intentional (OEM provider differences).
        try (Cursor cursor = context.getContentResolver().query(
                CallLog.Calls.CONTENT_URI.buildUpon().appendQueryParameter(CallLog.Calls.LIMIT_PARAM_KEY,
                        String.valueOf(PAGE_SIZE + 1)).build(),
                PROJECTION, CallLog.Calls.DATE + " >= ? AND " + CallLog.Calls.DATE + " <= ?",
                new String[]{String.valueOf(since), String.valueOf(now)},
                CallLog.Calls.DATE + " DESC, " + CallLog.Calls._ID + " DESC", signal)) {
            if (cursor == null) throw new IllegalStateException("Call log provider unavailable");
            return decode(cursor, since, now, signal);
        }
    }

    static Result decode(Cursor cursor, long since, long now, CancellationSignal signal) {
        List<Row> rows = new ArrayList<>();
        int n = cursor.getColumnIndexOrThrow(CallLog.Calls.NUMBER);
        int p = cursor.getColumnIndexOrThrow(CallLog.Calls.NUMBER_PRESENTATION);
        int t = cursor.getColumnIndexOrThrow(CallLog.Calls.TYPE);
        int d = cursor.getColumnIndexOrThrow(CallLog.Calls.DATE);
        int seconds = cursor.getColumnIndexOrThrow(CallLog.Calls.DURATION);
        while (cursor.moveToNext()) {
            signal.throwIfCanceled();
            long date = cursor.getLong(d);
            if (date < since || date > now) continue;
            if (rows.size() == PAGE_SIZE) return new Result(rows, true);
            String number = cursor.isNull(p) || cursor.getInt(p) != CallLog.Calls.PRESENTATION_ALLOWED
                    ? "رقم محجوب أو غير متاح" : displayNumber(cursor.getString(n));
            rows.add(new Row(number, cursor.getInt(t), date,
                    cursor.isNull(seconds) ? -1 : Math.max(-1, cursor.getLong(seconds))));
        }
        return new Result(rows, false);
    }

    static String displayNumber(String raw) {
        if (raw == null || raw.trim().isEmpty()) return "رقم غير متاح";
        // Display as provider supplied, excluding control/bidi formatting and excessive text.
        String clean = raw.replaceAll("[\\p{Cc}\\p{Cf}]", "").trim();
        if (clean.isEmpty()) return "رقم غير متاح";
        return clean.substring(0, Math.min(80, clean.length()));
    }
    static String typeLabel(int type) {
        switch (type) {
            case CallLog.Calls.INCOMING_TYPE: return "واردة";
            case CallLog.Calls.OUTGOING_TYPE: return "صادرة";
            case CallLog.Calls.MISSED_TYPE: return "فائتة";
            case CallLog.Calls.REJECTED_TYPE: return "مرفوضة";
            case CallLog.Calls.BLOCKED_TYPE: return "محظورة";
            case CallLog.Calls.VOICEMAIL_TYPE: return "بريد صوتي";
            case CallLog.Calls.ANSWERED_EXTERNALLY_TYPE: return "تم الرد عبر جهاز آخر";
            default: return "نوع آخر";
        }
    }
    private CallLogPilotReader() {}
}
