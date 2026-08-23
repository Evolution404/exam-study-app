import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let rootViewController = BridgeViewController()
        let initialInterfaceStyle = AppThemeAppearance.interfaceStyle()
        rootViewController.overrideUserInterfaceStyle = initialInterfaceStyle

        let window = UIWindow(windowScene: windowScene)
        window.overrideUserInterfaceStyle = initialInterfaceStyle
        window.backgroundColor = AppThemeAppearance.backgroundColor(for: windowScene.traitCollection)
        window.rootViewController = rootViewController
        self.window = window
        window.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
