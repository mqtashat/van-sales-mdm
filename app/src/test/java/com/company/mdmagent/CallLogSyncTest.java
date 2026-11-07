package com.company.mdmagent;
import org.junit.Test;
import static org.junit.Assert.*;
public class CallLogSyncTest {
    @Test public void privateNumbersNeverEscape() {
        assertEquals("",CallLogSync.safeNumber("0791234567",false));
        assertEquals("+962791234567",CallLogSync.safeNumber("+962 79-1234567",true));
        assertEquals("",CallLogSync.safeNumber(null,true));
    }
    @Test public void stableIdRetriesAndReusedProviderId() {
        assertEquals(CallLogSync.key("session",4,100),CallLogSync.key("session",4,100));
        assertNotEquals(CallLogSync.key("session",4,100),CallLogSync.key("session",4,101));
        assertNotEquals(CallLogSync.key("session",4,100),CallLogSync.key("other",4,100));
        assertTrue(CallLogSync.key("session",4,100).matches("[0-9a-f]{64}"));
    }
    @Test public void paginationKeepsSameMillisecondCalls() {
        assertTrue(CallLogSync.afterCursor(100,5,100,4));
        assertFalse(CallLogSync.afterCursor(100,4,100,4));
        assertFalse(CallLogSync.afterCursor(99,99,100,4));
        assertTrue(CallLogSync.afterCursor(101,1,100,4));
    }
}
