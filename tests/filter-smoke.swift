import AppKit
import WebKit

final class FilterCheck: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            do {
                try await Task.sleep(for: .seconds(1))
                let result = try await webView.evaluateJavaScript("""
                    (() => {
                      const input = document.querySelector('#search');
                      const tree = document.querySelector('#tree');
                      const labels = () => [...tree.querySelectorAll('.tree-row .label')].map(el => el.textContent);
                      const expect = (wanted, reason) => {
                        const actual = labels();
                        if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw Error(`${reason}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
                      };
                      const type = value => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
                      expect(['README.md', 'docs', 'archive'], 'Unfiltered tree must respect collapsed folders');
                      type('g');
                      expect(['docs', 'guide.md', 'design.md'], 'First character must filter live, including descendants in collapsed folders');
                      type('gu');
                      expect(['docs', 'guide.md'], 'Next character must narrow the result immediately');
                      type('docs');
                      expect(['docs', 'guide.md', 'design.md'], 'A matching folder must show its complete Markdown subtree');
                      tree.querySelector('.tree-row').click();
                      expect(['docs'], 'Collapsing a filtered folder must hide its descendants');
                      type('');
                      expect(['README.md', 'docs', 'archive'], 'Clearing the filter must restore the original expansion state');
                      tree.querySelectorAll('.tree-row')[1].click();
                      expect(['README.md', 'docs', 'guide.md', 'design.md', 'archive'], 'Normal tree expansion must still work');
                      type('ARCHIVE');
                      expect(['archive', 'old.md'], 'Folder search must ignore case');
                      type('missing');
                      expect([], 'No matches must hide all rows');
                      if (tree.dataset.message !== 'No matches.') throw Error('No matches must explain the empty tree');
                      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                      expect(['README.md', 'docs', 'guide.md', 'design.md', 'archive'], 'Escape must clear the filter and restore expanded folders');
                      document.querySelector('#sidebar-toggle').click();
                      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true }));
                      if (document.body.classList.contains('sidebar-hidden') || document.activeElement !== input) throw Error('Command-P must show the sidebar and focus Search');
                      if (window.filterScans() !== 1) throw Error(`Filtering must not rescan the filesystem: ${window.filterScans()} scans`);
                      type('guide');
                      expect(['docs', 'guide.md'], 'A leaf match must show only the matching file and its ancestors');
                      const marks = () => document.querySelectorAll('#preview mark.search-match').length;
                      if (marks() !== 0) throw Error('A query missing from the open document must not mark it');
                      type('INSTALL');
                      expect(['README.md', 'docs', 'design.md', 'archive', 'old.md'], 'Search must find files by their text, ignoring case');
                      if (marks() !== 1) throw Error(`The open document must mark the match: ${marks()} marks`);
                      type('');
                      if (marks() !== 0) throw Error('Clearing the search must remove the marks');
                      return 'PASS: live name and text filter, temporary expansion, Escape, Command-P, no rescans, marks in preview';
                    })()
                    """)
                print(result as? String ?? String(describing: result))
                exit(0)
            } catch {
                fputs("Filter check failed: \(error)\n", stderr)
                exit(1)
            }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 680), styleMask: [.titled], backing: .buffered, defer: false)
let webView = WKWebView(frame: window.contentView!.bounds)
let check = FilterCheck()
webView.navigationDelegate = check
window.contentView = webView
window.orderFront(nil)
webView.load(URLRequest(url: URL(string: CommandLine.arguments[1])!))
DispatchQueue.main.asyncAfter(deadline: .now() + 12) { fputs("Filter check timed out\n", stderr); exit(1) }
app.run()
