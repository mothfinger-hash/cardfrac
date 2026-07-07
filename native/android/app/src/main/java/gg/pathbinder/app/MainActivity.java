package gg.pathbinder.app;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Neon reveal (promise manifesto first launch, then video) once per cold launch.
        NeonSplash.present(this);

        // Android 15 (target SDK 35) forces edge-to-edge: the WebView extends
        // under the status + navigation bars. The Android WebView does NOT map
        // the system bars into env(safe-area-inset-*) (only display cutouts),
        // and it positions position:fixed elements against the full viewport,
        // IGNORING the WebView's own padding — so we can't fix this by padding
        // the WebView. Instead pad the WebView's PARENT: that shrinks the
        // WebView's view bounds (and therefore its layout viewport), so the
        // fixed bottom nav lands inside the safe area. NeonSplash's overlays are
        // siblings of the WebView's parent (added to android.R.id.content), so
        // the splash/video stay full-bleed.
        final WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv != null && wv.getParent() instanceof View) {
            final View wvParent = (View) wv.getParent();
            final View decor = getWindow().getDecorView();
            ViewCompat.setOnApplyWindowInsetsListener(decor, (v, insets) -> {
                Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
                wvParent.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsetsCompat.CONSUMED;
            });
            ViewCompat.requestApplyInsets(decor);
        }
    }
}
