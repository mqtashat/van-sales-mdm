package com.company.mdmagent;

import android.text.InputType;
import android.text.method.PasswordTransformationMethod;
import android.widget.EditText;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 34)
public class MaintenanceInputTest {
    @Test public void keypadMasksAndAcceptsOnlyDigitsStarHashWithSixCharacterLimit() {
        EditText field = new EditText(RuntimeEnvironment.getApplication());
        MaintenanceInput.configure(field);
        assertEquals(InputType.TYPE_CLASS_PHONE, field.getInputType() & InputType.TYPE_MASK_CLASS);
        assertTrue(field.getTransformationMethod() instanceof PasswordTransformationMethod);
        field.getText().append("1a2+*#56");
        assertEquals("12*#56", field.getText().toString());
        field.getText().append("7");
        assertEquals("12*#56", field.getText().toString());
    }
    @Test public void rejectsOldPasswordsAndInvalidLengths() {
        assertTrue(MaintenanceInput.valid("12*#".toCharArray()));
        assertTrue(MaintenanceInput.valid("123456".toCharArray()));
        for (String pin : new String[]{"", "123", "1234567", "Old-Password#2026", "12 4", "١٢٣٤"})
            assertFalse(MaintenanceInput.valid(pin.toCharArray()));
    }
}
