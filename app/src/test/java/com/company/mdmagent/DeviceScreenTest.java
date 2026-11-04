package com.company.mdmagent;

import android.app.Activity;
import android.graphics.Color;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=34)
public class DeviceScreenTest {
    @Test public void longContentScrollsWhileHeaderAndActionsStayOutsideViewport() {
        Activity activity=Robolectric.buildActivity(Activity.class).setup().get();
        DeviceScreen screen=new DeviceScreen(activity);
        screen.title("INJAZ.MDM",32,Color.WHITE);
        screen.title("جهاز الشركة",18,DeviceScreen.BLUE);
        for(int i=0;i<50;i++){
            TextView item=screen.text("تطبيق "+i,16,Color.WHITE);
            screen.content.addView(item,new LinearLayout.LayoutParams(-1,screen.dp(60)));
        }
        LinearLayout actions=new LinearLayout(activity);
        actions.addView(screen.button("تحديث التطبيقات"),new LinearLayout.LayoutParams(0,-2,1));
        actions.addView(screen.button("دخول الإدارة"),new LinearLayout.LayoutParams(0,-2,1));
        screen.footer.addView(actions);
        screen.show();
        int width=screen.dp(320),height=screen.dp(640);
        screen.root.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));
        screen.root.layout(0,0,width,height);
        int headerTop=screen.header.getTop(),footerTop=screen.footer.getTop();
        assertTrue(screen.scroll.getHeight()>0);
        assertTrue(screen.content.getHeight()>screen.scroll.getHeight());
        screen.scroll.scrollTo(0,screen.dp(500));
        assertTrue(screen.scroll.getScrollY()>0);
        assertEquals(headerTop,screen.header.getTop());
        assertEquals(footerTop,screen.footer.getTop());
        assertEquals(height,screen.footer.getBottom());
        assertSame(screen.root,screen.header.getParent());
        assertSame(screen.root,screen.footer.getParent());
        assertEquals(actions.getChildAt(0).getWidth(),actions.getChildAt(1).getWidth());
    }
}
