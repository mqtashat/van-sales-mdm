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
        MaintenanceInput.configure(field, false);
        assertEquals(InputType.TYPE_CLASS_PHONE, field.getInputType() & InputType.TYPE_MASK_CLASS);
        assertTrue(field.getTransformationMethod() instanceof PasswordTransformationMethod);
        field.getText().append("1a2+*#56");
        assertEquals("12*#56", field.getText().toString());
        field.getText().append("7");
        assertEquals("12*#56", field.getText().toString());
    }
    @Test public void legacyModeKeepsOldPasswordsAccessibleAndSwitchClearsSecret() {
        EditText field = new EditText(RuntimeEnvironment.getApplication());
        MaintenanceInput.configure(field, true);
        field.getText().append("Old-Password#2026");
        assertEquals("Old-Password#2026", field.getText().toString());
        assertTrue(field.getTransformationMethod() instanceof PasswordTransformationMethod);
        MaintenanceInput.configure(field, false);
        assertEquals("", field.getText().toString());
    }
}
