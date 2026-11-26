import ExpoModulesCore
import UIKit

/// Präsentationsmodus auf externem Display (Beamer / AirPlay / HDMI).
///
/// Das Gerät bleibt normal bedienbar; auf dem externen Bildschirm wird
/// **keine UI** gezeigt, sondern nur der übergebene Seiteninhalt (Bild).
public class ExternalDisplayModule: Module {
  // MARK: - State

  private var externalWindow: UIWindow?
  private var imageView: UIImageView?
  private var screenObservers: [NSObjectProtocol] = []
  private var presentationActive = false
  private var currentImage: UIImage?
  private var backgroundColor: UIColor = .white

  // MARK: - Module definition

  public func definition() -> ModuleDefinition {
    Name("ExternalDisplay")

    Events(
      "onConnected",
      "onDisconnected",
      "onAvailabilityChange",
      "onPresentationChange"
    )

    OnCreate {
      self.registerScreenObservers()
    }

    OnDestroy {
      self.removeScreenObservers()
      self.tearDownWindow()
    }

    // MARK: Availability

    AsyncFunction("isAvailable") { (promise: Promise) in
      promise.resolve(self.externalScreen() != nil)
    }.runOnQueue(.main)

    AsyncFunction("isPresentationActive") { (promise: Promise) in
      promise.resolve(self.presentationActive)
    }.runOnQueue(.main)

    AsyncFunction("getScreenInfo") { (promise: Promise) in
      guard let screen = self.externalScreen() else {
        promise.resolve(nil)
        return
      }
      promise.resolve([
        "width": Double(screen.bounds.width),
        "height": Double(screen.bounds.height),
        "scale": Double(screen.scale),
        "maximumFramesPerSecond": screen.maximumFramesPerSecond
      ])
    }.runOnQueue(.main)

    // MARK: Presentation control

    AsyncFunction("startPresentation") { (promise: Promise) in
      self.presentationActive = true
      let attached = self.attachWindowIfNeeded()
      self.emitPresentationChange(connected: attached)
      promise.resolve(attached)
    }.runOnQueue(.main)

    AsyncFunction("stopPresentation") { (promise: Promise) in
      self.presentationActive = false
      self.tearDownWindow()
      self.emitPresentationChange(connected: false)
      promise.resolve(nil)
    }.runOnQueue(.main)

    // MARK: Content

    AsyncFunction("setImageBase64") { (base64: String, promise: Promise) in
      // Roh-Base64 oder data-URI ("data:image/png;base64,...") werden akzeptiert.
      let cleaned = base64.components(separatedBy: ",").last ?? base64
      if let data = Data(base64Encoded: cleaned, options: [.ignoreUnknownCharacters]),
         let image = UIImage(data: data) {
        self.currentImage = image
        self.imageView?.image = image
      }
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("setImageUri") { (uri: String, promise: Promise) in
      let path: String
      if uri.hasPrefix("file://") {
        path = String(uri.dropFirst("file://".count))
      } else {
        path = uri
      }
      if let image = UIImage(contentsOfFile: path) {
        self.currentImage = image
        self.imageView?.image = image
      }
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("clearImage") { (promise: Promise) in
      self.currentImage = nil
      self.imageView?.image = nil
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("setBackgroundColor") { (hex: String, promise: Promise) in
      let color = UIColor(hexString: hex) ?? .white
      self.backgroundColor = color
      self.externalWindow?.backgroundColor = color
      self.externalWindow?.rootViewController?.view.backgroundColor = color
      self.imageView?.backgroundColor = color
      promise.resolve(nil)
    }.runOnQueue(.main)
  }

  // MARK: - Screen observation

  private func registerScreenObservers() {
    let center = NotificationCenter.default

    let connectObserver = center.addObserver(
      forName: UIScreen.didConnectNotification,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      guard let self = self else { return }
      let screen = notification.object as? UIScreen
      if self.presentationActive {
        self.attachWindowIfNeeded()
      }
      self.sendEvent("onConnected", self.screenPayload(screen))
      self.emitAvailabilityChange()
    }
    screenObservers.append(connectObserver)

    let disconnectObserver = center.addObserver(
      forName: UIScreen.didDisconnectNotification,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      guard let self = self else { return }
      let screen = notification.object as? UIScreen
      let hadWindow = self.externalWindow != nil
      if let windowScreen = self.externalWindow?.screen, windowScreen === screen {
        self.tearDownWindow()
      } else if hadWindow && self.externalScreen() == nil {
        self.tearDownWindow()
      }
      self.sendEvent("onDisconnected", self.screenPayload(screen))
      self.emitAvailabilityChange()
      if self.presentationActive {
        self.emitPresentationChange(connected: self.externalScreen() != nil)
      }
    }
    screenObservers.append(disconnectObserver)

    let modeObserver = center.addObserver(
      forName: UIScreen.modeDidChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self = self else { return }
      self.relayoutWindow()
      if self.presentationActive {
        self.attachWindowIfNeeded()
      }
      self.emitAvailabilityChange()
    }
    screenObservers.append(modeObserver)
  }

  private func removeScreenObservers() {
    let center = NotificationCenter.default
    for observer in screenObservers {
      center.removeObserver(observer)
    }
    screenObservers.removeAll()
  }

  // MARK: - External screen

  private func externalScreen() -> UIScreen? {
    let main = UIScreen.main
    // 1) Klassisches externes Display (HDMI / AirPlay extern): eigener Eintrag in UIScreen.screens.
    if let direct = UIScreen.screens.first(where: { screen in
      screen !== main && screen.bounds.width > 0 && screen.bounds.height > 0
    }) {
      return direct
    }
    // 2) Screen Mirroring: gespiegelter Screen hängt an UIScreen.main.mirrored
    //    (nicht in UIScreen.screens). Eigenes Fenster darauf ersetzt die Spiegelung.
    if let mirrored = main.mirrored, mirrored.bounds.width > 0, mirrored.bounds.height > 0 {
      return mirrored
    }
    return nil
  }

  private func screenPayload(_ screen: UIScreen?) -> [String: Any] {
    guard let screen = screen else { return [:] }
    return [
      "width": Double(screen.bounds.width),
      "height": Double(screen.bounds.height),
      "scale": Double(screen.scale)
    ]
  }

  // MARK: - Window management

  @discardableResult
  private func attachWindowIfNeeded() -> Bool {
    guard let screen = externalScreen() else { return false }

    if let window = externalWindow, window.screen === screen {
      window.isHidden = false
      return true
    }

    tearDownWindow()

    let window = UIWindow(frame: screen.bounds)
    // Klassische (vor iOS-13-Scene-API) externe Displays: eigenes Fenster auf
    // dem externen Screen. Das Hauptfenster bleibt key → App normal bedienbar.
    window.screen = screen
    window.windowLevel = .normal
    window.backgroundColor = backgroundColor
    window.isOpaque = true
    window.accessibilityElementsHidden = true

    let viewController = UIViewController()
    viewController.view.backgroundColor = backgroundColor
    viewController.view.isUserInteractionEnabled = false

    let imageView = UIImageView(frame: window.bounds)
    imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    imageView.contentMode = .scaleAspectFit
    imageView.backgroundColor = backgroundColor
    imageView.clipsToBounds = true
    imageView.image = currentImage
    imageView.isUserInteractionEnabled = false
    viewController.view.addSubview(imageView)

    window.rootViewController = viewController
    // NICHT makeKeyAndVisible() aufrufen – sonst verliert das Hauptfenster
    // den Key-Status und Eingaben auf dem Gerät gingen verloren.
    window.isHidden = false

    externalWindow = window
    self.imageView = imageView
    return true
  }

  private func tearDownWindow() {
    externalWindow?.isHidden = true
    externalWindow?.rootViewController = nil
    externalWindow = nil
    imageView = nil
  }

  private func relayoutWindow() {
    guard let window = externalWindow, let screen = window.screen else { return }
    window.frame = screen.bounds
    imageView?.frame = window.bounds
  }

  // MARK: - Events

  private func emitAvailabilityChange() {
    sendEvent("onAvailabilityChange", ["available": self.externalScreen() != nil])
  }

  private func emitPresentationChange(connected: Bool) {
    sendEvent("onPresentationChange", [
      "active": self.presentationActive,
      "connected": connected
    ])
  }
}

// MARK: - UIColor hex parsing

private extension UIColor {
  convenience init?(hexString: String) {
    var hex = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
    if hex.hasPrefix("#") { hex.removeFirst() }
    if hex.count == 3 {
      hex = hex.map { "\($0)\($0)" }.joined()
    }
    guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
    let red = CGFloat((value >> 16) & 0xFF) / 255.0
    let green = CGFloat((value >> 8) & 0xFF) / 255.0
    let blue = CGFloat(value & 0xFF) / 255.0
    self.init(red: red, green: green, blue: blue, alpha: 1.0)
  }
}
