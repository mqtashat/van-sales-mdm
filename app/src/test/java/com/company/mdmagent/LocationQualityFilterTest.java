package com.company.mdmagent;
import org.junit.Test;
import static org.junit.Assert.*;
public class LocationQualityFilterTest {
    @Test public void rejectsStaleMissingInaccurateAndInvalidFixes() {
        assertTrue(LocationQualityFilter.valid(32,36,10,1000,100000,101000));
        assertFalse(LocationQualityFilter.valid(32,36,129,1000,100000,101000));
        assertFalse(LocationQualityFilter.valid(32,36,Float.NaN,1000,100000,101000));
        assertFalse(LocationQualityFilter.valid(32,36,10,31000,100000,101000));
        assertFalse(LocationQualityFilter.valid(32,36,10,-1,100000,101000));
        assertFalse(LocationQualityFilter.valid(91,36,10,1000,100000,101000));
    }
    @Test public void suppressesStationaryJitterButKeepsRealMotion() {
        LocationQualityFilter f = new LocationQualityFilter();
        assertTrue(f.accept(32,36,10,1000));
        assertFalse(f.accept(32.00001,36.00001,10,61000));
        assertFalse(f.isMoving());
        assertTrue(f.accept(32.001,36,10,121000));
        assertTrue(f.isMoving());
        assertFalse(f.accept(33,37,10,151000));
        assertTrue(f.accept(32.002,36,10,181000));
    }
    @Test public void repeatedRequestsDoNotCreateDuplicatePointsAndGapResetsAnchor() {
        LocationQualityFilter f = new LocationQualityFilter();
        assertTrue(f.accept(32,36,10,1000));
        assertFalse(f.accept(32.001,36,10,2000));
        assertTrue(f.accept(33,37,10,400000));
        assertFalse(f.isMoving());
    }
}
