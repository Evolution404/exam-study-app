import UIKit
import Capacitor

enum AppThemeAppearance {
    private static let preferencesKey = "CapacitorStorage.study-v7-preferences"

    private enum Mode: String {
        case system
        case light
        case dark
    }

    private static func mode() -> Mode {
        guard
            let raw = UserDefaults.standard.string(forKey: preferencesKey),
            let data = raw.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let value = object["themeMode"] as? String,
            let mode = Mode(rawValue: value)
        else {
            return .system
        }
        return mode
    }

    static func interfaceStyle() -> UIUserInterfaceStyle {
        switch mode() {
        case .dark: return .dark
        case .light: return .light
        case .system: return .unspecified
        }
    }

    static func isDark(traits: UITraitCollection) -> Bool {
        switch mode() {
        case .dark: return true
        case .light: return false
        case .system: return traits.userInterfaceStyle == .dark
        }
    }

    static func backgroundColor(for traits: UITraitCollection) -> UIColor {
        if isDark(traits: traits) {
            return UIColor(red: 16.0 / 255.0, green: 22.0 / 255.0, blue: 18.0 / 255.0, alpha: 1)
        }
        return UIColor(red: 243.0 / 255.0, green: 240.0 / 255.0, blue: 233.0 / 255.0, alpha: 1)
    }

    static func statusBarStyle(for traits: UITraitCollection) -> UIStatusBarStyle {
        isDark(traits: traits) ? .lightContent : .darkContent
    }
}

final class BridgeViewController: CAPBridgeViewController {
    override func setStatusBarDefaults() {
        super.setStatusBarDefaults()
        statusBarStyle = AppThemeAppearance.statusBarStyle(for: traitCollection)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // StatusBar applies its static Capacitor config from the viewDidAppear
        // notification. Reassert the durable native theme immediately so that
        // DEFAULT never paints light-mode icons before JavaScript hydrates.
        statusBarStyle = AppThemeAppearance.statusBarStyle(for: traitCollection)
        setNeedsStatusBarAppearanceUpdate()
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        let background = AppThemeAppearance.backgroundColor(for: traitCollection)
        webView?.backgroundColor = background
        webView?.scrollView.backgroundColor = background
        bridge?.registerPluginInstance(SecureCredentialsPlugin())
    }
}
