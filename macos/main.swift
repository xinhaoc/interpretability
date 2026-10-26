// interpretability for macOS: a native window around the local web app.
//
// On launch it starts the Python server (app.py) unless one is already running on the port,
// shows the UI in a WKWebView, and stops the server it started when the app quits.
// PDFs opened from Finder, dropped on the Dock icon, or picked with ⌘O are imported directly.

import Cocoa
import UniformTypeIdentifiers
import WebKit

let port = 8765
let base = URL(string: "http://127.0.0.1:\(port)/")!

func plist(_ key: String) -> String? { Bundle.main.object(forInfoDictionaryKey: key) as? String }

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var lifeline: Pipe?  // the server exits when this pipe closes, i.e. when the app goes away for any reason
    var ready = false
    var pendingFiles: [URL] = []

    // The server code ships inside the bundle (Contents/Resources/app); a plist key can point elsewhere for development.
    let projectDir = plist("InterpretabilityProjectDir") ?? (Bundle.main.resourcePath ?? "") + "/app"
    // Python: the one recorded at build time (a local build), else the copy shipped in the bundle (a release).
    let python: String = {
        if let p = plist("InterpretabilityPython"), FileManager.default.isExecutableFile(atPath: p) { return p }
        let bundled = (Bundle.main.resourcePath ?? "") + "/python/bin/python3"
        return FileManager.default.isExecutableFile(atPath: bundled) ? bundled : "/usr/bin/python3"
    }()
    // PATH, so the server can find `claude` / `codex`: apps opened from Finder don't get the
    // shell's PATH, so ask the user's login shell once, and add the usual install places.
    lazy var searchPath: String = {
        if let p = plist("InterpretabilityPATH") { return p }
        let home = NSHomeDirectory()
        var parts = [home + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", home + "/.npm-global/bin", home + "/.bun/bin"]
        let sh = Process()
        sh.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
        sh.arguments = ["-ilc", "printf '%s' \"$PATH\""]
        let out = Pipe()
        sh.standardOutput = out
        sh.standardError = FileHandle.nullDevice
        sh.standardInput = FileHandle.nullDevice
        if (try? sh.run()) != nil {
            let deadline = Date().addingTimeInterval(3)
            while sh.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
            if sh.isRunning { sh.terminate() }
            let text = String(data: out.fileHandleForReading.availableData, encoding: .utf8) ?? ""
            if let last = text.split(separator: "\n").last { parts += last.split(separator: ":").map(String.init) }
        }
        parts += ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        var seen = Set<String>()
        return parts.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
    }()
    let logURL = URL(fileURLWithPath: NSHomeDirectory() + "/Interpretability/server.log")

    // MARK: launch / quit

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "interpretability"
        window.minSize = NSSize(width: 700, height: 480)
        window.tabbingMode = .disallowed
        window.isReleasedWhenClosed = false
        if !window.setFrameUsingName("main") { window.center() }
        window.setFrameAutosaveName("main")

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.allowsBackForwardNavigationGestures = false
        if #available(macOS 13.3, *) { web.isInspectable = true }
        window.contentView = web
        showMessage("正在启动…", detail: "")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startServer()
    }

    func applicationWillTerminate(_ note: Notification) {
        server?.terminate()
    }

    // ⌘W only closes the window; the app (and any running first read) keeps going. Click the Dock icon to reopen.
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func application(_ app: NSApplication, open urls: [URL]) {
        let pdfs = urls.filter { $0.pathExtension.lowercased() == "pdf" }
        if ready { importFiles(pdfs) } else { pendingFiles += pdfs }
    }

    // MARK: server

    func isUp(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: base.appendingPathComponent("api/settings"))
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            done((resp as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    func startServer() {
        isUp { up in
            DispatchQueue.main.async {
                if up { self.serverReady() } else { self.launchServer() }
            }
        }
    }

    func launchServer() {
        if server?.isRunning == true { return waitForServer(tries: 0) }  // already starting
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: python)
        p.arguments = ["app.py", "--no-browser"]
        p.currentDirectoryURL = URL(fileURLWithPath: projectDir)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = searchPath
        env["PORT"] = String(port)
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["INTERPRETABILITY_LIFELINE"] = "1"
        env["PYTHONNOUSERSITE"] = "1"  // never mix in packages from the user's own Python
        p.environment = env
        let pipe = Pipe()
        p.standardInput = pipe
        lifeline = pipe
        if let log = try? FileHandle(forWritingTo: logURL) {
            p.standardOutput = log
            p.standardError = log
        }
        do { try p.run() } catch {
            showMessage("启动失败", detail: "无法运行 \(python)：\(error.localizedDescription)")
            return
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, self.server === proc else { return }
                self.server = nil
                self.ready = false
                self.showMessage("后台服务已退出，按 ⌘R 重新启动", detail: self.logTail())
            }
        }
        server = p
        waitForServer(tries: 0)
    }

    func waitForServer(tries: Int) {
        isUp { up in
            DispatchQueue.main.async {
                if up { return self.serverReady() }
                if self.server == nil || self.server?.isRunning == false {
                    return self.showMessage("服务启动失败，按 ⌘R 重试", detail: self.logTail())
                }
                if tries > 120 { return self.showMessage("服务启动超时，按 ⌘R 重试", detail: self.logTail()) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitForServer(tries: tries + 1) }
            }
        }
    }

    func serverReady() {
        web.load(URLRequest(url: base))
    }

    func logTail() -> String {
        let text = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
        return String(text.suffix(3000))
    }

    func showMessage(_ title: String, detail: String) {
        let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        let html = """
        <html><head><meta charset="utf-8"><style>
        :root { color-scheme: light dark; }
        body { font: 14px -apple-system, "PingFang SC", sans-serif; display: flex; align-items: center; justify-content: center;
               height: 100vh; margin: 0; background: Canvas; color: CanvasText; }
        .box { max-width: 720px; text-align: center; }
        h1 { font-size: 22px; font-weight: 600; }
        pre { text-align: left; white-space: pre-wrap; font-size: 12px; opacity: .8; max-height: 50vh; overflow: auto; }
        </style></head><body><div class="box"><h1>interpretability</h1><p>\(esc(title))</p><pre>\(esc(detail))</pre></div></body></html>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    // MARK: importing PDFs from Finder / Dock / ⌘O

    func importFiles(_ urls: [URL]) {
        for url in urls {
            DispatchQueue.global(qos: .userInitiated).async {
                guard let data = try? Data(contentsOf: url) else {
                    return self.importFailed(url, "读不了这个文件")
                }
                let boundary = "----interpretability\(UUID().uuidString)"
                let name = url.lastPathComponent.replacingOccurrences(of: "\"", with: "'")
                var body = Data()
                body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: application/pdf\r\n\r\n".data(using: .utf8)!)
                body.append(data)
                body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
                var req = URLRequest(url: base.appendingPathComponent("api/papers"))
                req.httpMethod = "POST"
                req.timeoutInterval = 120
                req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
                req.httpBody = body
                URLSession.shared.dataTask(with: req) { data, resp, err in
                    let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                    guard (resp as? HTTPURLResponse)?.statusCode == 200, let id = obj?["id"] as? String else {
                        return self.importFailed(url, (obj?["detail"] as? String) ?? err?.localizedDescription ?? "导入失败")
                    }
                    DispatchQueue.main.async {
                        self.web.callAsyncJavaScript("window.interpretability && window.interpretability.openPaper(id)",
                                                     arguments: ["id": id], in: nil, in: .page)
                    }
                }.resume()
            }
        }
    }

    func importFailed(_ url: URL, _ reason: String) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = "没能导入 \(url.lastPathComponent)"
            alert.informativeText = reason
            alert.beginSheetModal(for: self.window)
        }
    }

    @objc func openDocument(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.pdf]
        panel.allowsMultipleSelection = true
        panel.beginSheetModal(for: window) { resp in
            if resp == .OK { self.importFiles(panel.urls) }
        }
    }

    // MARK: web view

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        ready = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        ready = false
        showMessage("连不上后台服务，按 ⌘R 重新启动", detail: logTail())
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView.url?.host == "127.0.0.1" else { return }
        ready = true
        if !pendingFiles.isEmpty {
            importFiles(pendingFiles)
            pendingFiles = []
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Links out of the app (paper URLs in references, etc.) open in the default browser.
        if let url = action.request.url, action.navigationType == .linkActivated,
           url.host != "127.0.0.1", url.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.pdf]
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    // MARK: menu

    func js(_ code: String) { web.evaluateJavaScript(code) }
    @objc func openSettings(_ sender: Any?) { js("document.querySelector('#backend-btn')?.click()") }
    @objc func reloadPage(_ sender: Any?) {
        startServer()  // reloads the page, and restarts the server first if it is gone
    }
    @objc func zoomIn(_ sender: Any?) { js("document.querySelector('#zoom-in')?.click()") }
    @objc func zoomOut(_ sender: Any?) { js("document.querySelector('#zoom-out')?.click()") }
    @objc func zoomFit(_ sender: Any?) { js("document.querySelector('#zoom-fit')?.click()") }
    @objc func toggleLibrary(_ sender: Any?) { js("document.querySelector('#toggle-lib')?.click()") }
    @objc func showData(_ sender: Any?) {
        NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory() + "/Interpretability"))
    }

    func buildMenu() {
        let main = NSMenu()
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
            let it = NSMenuItem(title: title, action: action, keyEquivalent: key)
            it.keyEquivalentModifierMask = mods
            if let target { it.target = target }
            return it
        }
        func submenu(_ title: String, _ items: [NSMenuItem]) {
            let top = NSMenuItem()
            let menu = NSMenu(title: title)
            items.forEach(menu.addItem)
            top.submenu = menu
            main.addItem(top)
        }
        submenu("interpretability", [
            item("关于 interpretability", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("设置…", #selector(openSettings(_:)), ",", target: self),
            .separator(),
            item("隐藏 interpretability", #selector(NSApplication.hide(_:)), "h"),
            item("隐藏其他", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            .separator(),
            item("退出 interpretability", #selector(NSApplication.terminate(_:)), "q"),
        ])
        submenu("文件", [
            item("导入 PDF…", #selector(openDocument(_:)), "o", target: self),
            item("在访达中显示数据文件夹", #selector(showData(_:)), "", target: self),
            .separator(),
            item("关闭窗口", #selector(NSWindow.performClose(_:)), "w"),
        ])
        submenu("编辑", [
            item("撤销", Selector(("undo:")), "z"),
            item("重做", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("剪切", #selector(NSText.cut(_:)), "x"),
            item("拷贝", #selector(NSText.copy(_:)), "c"),
            item("粘贴", #selector(NSText.paste(_:)), "v"),
            item("全选", #selector(NSText.selectAll(_:)), "a"),
        ])
        submenu("显示", [
            item("放大", #selector(zoomIn(_:)), "=", target: self),
            item("缩小", #selector(zoomOut(_:)), "-", target: self),
            item("适应宽度", #selector(zoomFit(_:)), "0", target: self),
            .separator(),
            item("显示/隐藏论文库", #selector(toggleLibrary(_:)), "l", [.command, .shift], target: self),
            item("重新载入", #selector(reloadPage(_:)), "r", target: self),
            .separator(),
            item("进入全屏幕", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        submenu("窗口", [
            item("最小化", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("缩放", #selector(NSWindow.performZoom(_:))),
        ])
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
