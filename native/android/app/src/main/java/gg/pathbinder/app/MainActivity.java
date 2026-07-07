package gg.pathbinder.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Neon reveal video over the webview (once per cold launch).
        NeonSplash.present(this);
    }
}
