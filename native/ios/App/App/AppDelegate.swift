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

    // MARK: - Push notification registration
    // @capacitor/push-notifications hands the APNs device token to JS via these
    // NotificationCenter posts. Without them, PushNotifications.register() never
    // fires its 'registration' listener and no token is ever issued. Firebase's
    // method swizzling (from FirebaseApp.configure above) separately consumes the
    // same token to mint the FCM token used for delivery.
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications,
                                        object: deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications,
                                        object: error)
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

// MARK: - Neon intro
//
// Cold-launch intro, once per process, EVERY launch:
//   promise manifesto (held until the neon video is buffered) -> neon video -> app.
//
// The LaunchScreen storyboard already shows the promise image, so it's on screen
// from the very first frame; NeonSplash then keeps that same image up (on top of
// the buffering video) until the video is ready, then fades to reveal the video —
// no dead gap. Streams from pathbinder.gg (remote-URL wrap) and plays WITH sound.
// A MIN keeps the promise readable; a MAX + failsafes make sure a slow or dead
// network can never wedge the launch.

final class NeonPlayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

enum NeonSplash {
    private static var videoView: NeonPlayerView?
    private static var promiseView: UIImageView?
    private static var player: AVPlayer?
    private static var itemObs: NSKeyValueObservation?
    private static var didRun = false
    private static var videoReady = false
    private static var videoStarted = false
    private static var promiseGone = false
    private static var dismissed = false
    private static var startedAt: TimeInterval = 0
    private static let videoURL = "https://pathbinder.gg/pathbinder-neon-splash.mp4"
    private static let promiseMin: TimeInterval = 1.8   // keep it readable
    private static let promiseMax: TimeInterval = 6.0   // drop it even if video still buffering
    private static let videoGiveup: TimeInterval = 9.0  // if video never started, skip to app
    private static let hardCap: TimeInterval = 15.0     // absolute backstop

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
        startedAt = ProcessInfo.processInfo.systemUptime

        // Play sound even if the ringer switch is silent — this is a deliberate intro.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)

        // ---- Video layer (behind) ----
        let item = AVPlayerItem(url: url)
        let p = AVPlayer(playerItem: item)
        p.actionAtItemEnd = .pause
        player = p
        let vv = NeonPlayerView(frame: window.bounds)
        vv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        vv.backgroundColor = UIColor(red: 10.0/255.0, green: 14.0/255.0, blue: 26.0/255.0, alpha: 1)
        vv.playerLayer.videoGravity = .resizeAspectFill
        vv.playerLayer.player = p
        vv.addGestureRecognizer(UITapGestureRecognizer(target: NeonTapProxy.shared,
                                                       action: #selector(NeonTapProxy.fire)))
        window.addSubview(vv)
        videoView = vv

        // ---- Promise layer (on top of the video) ----
        if let img = UIImage(named: "PromiseSplash") {
            let iv = UIImageView(frame: window.bounds)
            iv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            iv.backgroundColor = UIColor(red: 10.0/255.0, green: 14.0/255.0, blue: 26.0/255.0, alpha: 1)
            iv.contentMode = .scaleAspectFit
            iv.image = img
            iv.isUserInteractionEnabled = true
            iv.addGestureRecognizer(UITapGestureRecognizer(target: NeonTapProxy.shared,
                                                           action: #selector(NeonTapProxy.firePromise)))
            window.addSubview(iv)
            promiseView = iv
        } else {
            promiseGone = true
        }

        NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime,
                                               object: item, queue: .main) { _ in dismiss() }
        itemObs = item.observe(\.status, options: [.new]) { it, _ in
            if it.status == .readyToPlay { onVideoReady() }
        }

        // Failsafes.
        DispatchQueue.main.asyncAfter(deadline: .now() + promiseMax)  { removePromise() }
        DispatchQueue.main.asyncAfter(deadline: .now() + videoGiveup) { if !videoStarted { dismiss() } }
        DispatchQueue.main.asyncAfter(deadline: .now() + hardCap)     { dismiss() }
    }

    private static func onVideoReady() {
        guard !videoReady else { return }
        videoReady = true
        if promiseGone {
            startVideo()
        } else {
            let elapsed = ProcessInfo.processInfo.systemUptime - startedAt
            let wait = max(0, promiseMin - elapsed)
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { removePromise() }
        }
    }

    private static func startVideo() {
        guard !videoStarted, !dismissed else { return }
        videoStarted = true
        player?.play()
    }

    // Fade the promise away, revealing the (now playing) video underneath.
    static func removePromise() {
        guard !promiseGone else { return }
        promiseGone = true
        if videoReady { startVideo() }
        guard let v = promiseView else { return }
        promiseView = nil
        UIView.animate(withDuration: 0.35, animations: { v.alpha = 0 }, completion: { _ in
            v.removeFromSuperview()
        })
    }

    static func dismiss() {
        guard !dismissed else { return }
        dismissed = true
        itemObs?.invalidate(); itemObs = nil
        player?.pause(); player = nil
        if let pv = promiseView { promiseView = nil; pv.removeFromSuperview() }
        if let v = videoView {
            videoView = nil
            UIView.animate(withDuration: 0.4, animations: { v.alpha = 0 }, completion: { _ in
                v.removeFromSuperview()
            })
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

// Bridges tap gestures to NeonSplash's static handlers (enums take no @objc
// selectors). Must subclass NSObject so the gesture-recognizer target-action works.
final class NeonTapProxy: NSObject {
    static let shared = NeonTapProxy()
    @objc func fire() { NeonSplash.dismiss() }
    @objc func firePromise() { NeonSplash.removePromise() }
}
