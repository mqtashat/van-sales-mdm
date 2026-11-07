package com.company.mdmagent;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.OperationCanceledException;
import android.provider.CallLog;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class CallLogPilotReaderTest {
    private MatrixCursor cursor() { return new MatrixCursor(CallLogPilotReader.PROJECTION); }
    @Test public void rejectsHistoryAndFutureAndDoesNotExposeRestrictedNumber() {
        try (MatrixCursor c = cursor()) {
            c.addRow(new Object[]{1,"0791111111",1,1,999,15});
            c.addRow(new Object[]{2,"0792222222",2,2,1500,0});
            c.addRow(new Object[]{3,"0793333333",1,3,2001,0});
            CallLogPilotReader.Result r = CallLogPilotReader.decode(c,1000,2000,new CancellationSignal());
            assertEquals(1,r.rows.size());
            assertEquals("رقم محجوب أو غير متاح",r.rows.get(0).number);
            assertEquals(0,r.rows.get(0).duration);
            assertFalse(r.partial);
        }
    }
    @Test public void preservesDirectionDurationAndMissingDuration() {
        try (MatrixCursor c = cursor()) {
            c.addRow(new Object[]{1,"+962791111111",1,2,1500,65});
            c.addRow(new Object[]{2,null,3,3,1400,null});
            CallLogPilotReader.Result r = CallLogPilotReader.decode(c,1000,2000,new CancellationSignal());
            assertEquals("+962791111111",r.rows.get(0).number);
            assertEquals("صادرة",CallLogPilotReader.typeLabel(r.rows.get(0).type));
            assertEquals(65,r.rows.get(0).duration);
            assertEquals(-1,r.rows.get(1).duration);
        }
    }
    @Test public void boundsLargeResultAndLabelsPartial() {
        try (MatrixCursor c = cursor()) {
            for(int i=0;i<101;i++) c.addRow(new Object[]{i,"0790000000",1,1,1500,3});
            CallLogPilotReader.Result r = CallLogPilotReader.decode(c,1000,2000,new CancellationSignal());
            assertEquals(100,r.rows.size()); assertTrue(r.partial);
        }
    }
    @Test(expected=OperationCanceledException.class) public void cancellationDiscardsPendingRead() {
        try (MatrixCursor c = cursor()) {
            c.addRow(new Object[]{1,"0790000000",1,1,1500,3});
            CancellationSignal s = new CancellationSignal();s.cancel();
            CallLogPilotReader.decode(c,1000,2000,s);
        }
    }
}
