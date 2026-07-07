import UIKit
import Capacitor
import FirebaseCore
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Initialize Firebase (FCM push). Must run before the push plugin
        // registers so @capacitor/push-notifications returns an FCM token.
        FirebaseApp.configure()
        // Neon reveal video over the webview (once per cold launch).
        NeonSplash.presentWhenReady()
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

// MARK: - Neon intro video
//
// Full-screen neon reveal played once per cold launch, layered over the
// webview. Streams from pathbinder.gg (this is a remote-URL wrap, so the app
// needs the network regardless) and plays WITH sound — native playback isn't
// subject to the webview's autoplay-muting policy. Failsafes guarantee the
// overlay is removed even if the stream stalls, so launch is never blocked.

final class NeonPlayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

enum NeonSplash {
    private static var overlay: UIView?
    private static var player: AVPlayer?
    private static var didRun = false
    private static let videoURL = "https://pathbinder.gg/pathbinder-neon-splash.mp4"

    static func presentWhenReady() {
        DispatchQueue.main.async {
            let window = UIApplication.shared.windows.first(where: { $0.isKeyWindow })
                ?? UIApplication.shared.windows.first
            guard let w = window else { return }
            present(over: w)
        }
    }

    private static func present(over window: UIWindow) {
        guard !didRun, let url = URL(string: videoURL) else { return }
        didRun = true

        // Play sound even if the ringer switch is silent — this is a deliberate intro.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)

        let item = AVPlayerItem(url: url)
        let p = AVPlayer(playerItem: item)
        p.actionAtItemEnd = .pause
        player = p

        let view = NeonPlayerView(frame: window.bounds)
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.backgroundColor = UIColor(red: 10.0/255.0, green: 14.0/255.0, blue: 26.0/255.0, alpha: 1)
        view.playerLayer.videoGravity = .resizeAspectFill
        view.playerLayer.player = p
        view.addGestureRecognizer(UITapGestureRecognizer(target: NeonTapProxy.shared,
                                                         action: #selector(NeonTapProxy.fire)))
        window.addSubview(view)
        overlay = view

        NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime,
                                               object: item, queue: .main) { _ in dismiss() }
        // If the stream hasn't started within 4s, skip straight to the app.
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
            if p.currentTime().seconds < 0.1 { dismiss() }
        }
        // Absolute cap so the overlay can never linger.
        DispatchQueue.main.asyncAfter(deadline: .now() + 9) { dismiss() }

        p.play()
    }

    static func dismiss() {
        guard let v = overlay else { return }
        overlay = nil
        player?.pause()
        player = nil
        UIView.animate(withDuration: 0.4, animations: { v.alpha = 0 }, completion: { _ in
            v.removeFromSuperview()
        })
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

// Bridges a tap gesture to NeonSplash's static dismiss (enums take no @objc
// selectors). Must subclass NSObject so the gesture-recognizer target-action works.
final class NeonTapProxy: NSObject {
    static let shared = NeonTapProxy()
    @objc func fire() { NeonSplash.dismiss() }
}
