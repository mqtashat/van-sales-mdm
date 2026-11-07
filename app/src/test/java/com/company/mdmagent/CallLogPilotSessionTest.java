package com.company.mdmagent;
import org.junit.Test;
import static org.junit.Assert.*;
public class CallLogPilotSessionTest {
    @Test public void requiresExplicitSessionAndSameIdentity() {
        assertFalse(CallLogPilotSession.valid(0,0,"a","a",1000,1000));
        assertFalse(CallLogPilotSession.valid(1000,10,"a","b",2000,1010));
        assertFalse(CallLogPilotSession.valid(1000,10,"a",null,2000,1010));
        assertTrue(CallLogPilotSession.valid(1000,10,"a","a",2000,1010));
    }
    @Test public void expiresAndRejectsClockRollbackAndRestart() {
        long day = CallLogPilotSession.MAX_AGE_MS;
        assertFalse(CallLogPilotSession.valid(1000,100,"a","a",1000+day,100+day));
        assertFalse(CallLogPilotSession.valid(1000,100,"a","a",999,101));
        assertFalse(CallLogPilotSession.valid(1000,100,"a","a",2000,99));
        assertFalse(CallLogPilotSession.valid(1000,100,"a","a",2000,100+day));
    }
}
