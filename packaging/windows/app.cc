// FreeCode.exe: the FreeCode desktop app for Windows.
//
// Starts the FreeCode server (the bundled Node.js runtime, without a console window) and shows the
// app in its own window through WebView2, the web engine built into Windows 10 and 11. FreeCode
// looks like a normal app: its own title bar (colored like the app), taskbar icon and window.
// Without WebView2 it falls back to an Edge/Chrome app window.
//
// Built with MinGW-w64 by scripts/build-windows.mjs, using the webview library
// (https://github.com/webview/webview, MIT) and the WebView2 SDK headers (BSD).

#include "webview/webview.h"

#include <dwmapi.h>
#include <shellapi.h>
#include <windows.h>

#include <memory>
#include <string>
#include <vector>

namespace {

constexpr const wchar_t *kMutexName = L"Local\\FreeCode.DesktopApp";
constexpr const wchar_t *kWindowProp = L"FreeCode.AppWindow";
constexpr const wchar_t *kRegKey = L"Software\\FreeCode";
constexpr ULONG_PTR kOpenFolder = 0x4643;  // WM_COPYDATA tag: "open this folder"

std::wstring g_dir;     // installation folder
std::wstring g_folder;  // folder passed on the command line
webview::webview *g_view = nullptr;
HWND g_hwnd = nullptr;
WNDPROC g_prevProc = nullptr;
volatile LONG g_generation = 0;  // bumped on every (re)start so old reader threads stay quiet
volatile LONG g_closing = 0;

struct Server {
  HANDLE process = nullptr;
  HANDLE stdinWrite = nullptr;  // closing it tells FreeCode to shut down
  HANDLE reader = nullptr;      // thread reading its output
};
Server g_server;

// ------------------------------------------------------------------ strings

std::string Utf8(const std::wstring &w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
  return s;
}

std::string JsString(const std::string &s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '<': out += "\\u003c"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out + "\"";
}

std::string HtmlEscape(const std::string &s) {
  std::string out;
  for (char c : s) {
    switch (c) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      default: out += c;
    }
  }
  return out;
}

/** The string arguments of a webview binding call (a JSON array such as ["dark","#161615"]). */
std::vector<std::string> JsonStrings(const std::string &json) {
  std::vector<std::string> out;
  for (size_t i = 0; i < json.size(); ++i) {
    if (json[i] != '"') continue;
    std::string cur;
    for (++i; i < json.size() && json[i] != '"'; ++i) {
      if (json[i] == '\\' && i + 1 < json.size()) {
        char e = json[++i];
        cur += e == 'n' ? '\n' : e == 't' ? '\t' : e;
      } else {
        cur += json[i];
      }
    }
    out.push_back(cur);
  }
  return out;
}

/** Quotes one command-line argument so the C runtime reads it back unchanged. */
std::wstring Quote(const std::wstring &arg) {
  std::wstring out = L"\"";
  for (size_t i = 0;; ++i) {
    size_t slashes = 0;
    while (i < arg.size() && arg[i] == L'\\') {
      ++i;
      ++slashes;
    }
    if (i == arg.size()) {
      out.append(slashes * 2, L'\\');
      break;
    }
    out.append(arg[i] == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    out.push_back(arg[i]);
  }
  out.push_back(L'"');
  return out;
}

std::wstring Env(const wchar_t *name) {
  wchar_t buf[32768];
  DWORD n = GetEnvironmentVariableW(name, buf, 32768);
  return n > 0 && n < 32768 ? std::wstring(buf, n) : std::wstring();
}

bool Exists(const std::wstring &path) { return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES; }

// ------------------------------------------------------------------ settings (HKCU\Software\FreeCode)

bool RegString(const wchar_t *name, std::wstring *out) {
  wchar_t buf[256];
  DWORD size = sizeof buf;
  if (RegGetValueW(HKEY_CURRENT_USER, kRegKey, name, RRF_RT_REG_SZ, nullptr, buf, &size) != ERROR_SUCCESS) return false;
  *out = buf;
  return true;
}

bool SystemUsesLightTheme() {
  DWORD v = 0, size = sizeof v;
  return RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", L"AppsUseLightTheme", RRF_RT_REG_DWORD, nullptr, &v, &size) == ERROR_SUCCESS && v == 1;
}

bool SavedThemeIsDark() {
  std::wstring t;
  if (RegString(L"Theme", &t)) return t != L"light";
  return !SystemUsesLightTheme();
}

COLORREF SavedTitleColor(bool dark) {
  DWORD v = 0, size = sizeof v;
  if (RegGetValueW(HKEY_CURRENT_USER, kRegKey, L"TitleColor", RRF_RT_REG_DWORD, nullptr, &v, &size) == ERROR_SUCCESS) return v;
  return dark ? RGB(0x16, 0x16, 0x15) : RGB(0xF1, 0xEF, 0xEA);
}

void SavePlacement() {
  WINDOWPLACEMENT wp{};
  wp.length = sizeof wp;
  if (g_hwnd && GetWindowPlacement(g_hwnd, &wp)) RegSetKeyValueW(HKEY_CURRENT_USER, kRegKey, L"WindowPlacement", REG_BINARY, &wp, sizeof wp);
}

void RestorePlacement() {
  WINDOWPLACEMENT wp{};
  DWORD size = sizeof wp;
  if (RegGetValueW(HKEY_CURRENT_USER, kRegKey, L"WindowPlacement", RRF_RT_REG_BINARY, nullptr, &wp, &size) != ERROR_SUCCESS) return;
  if (size != sizeof wp || wp.length != sizeof wp) return;
  if (!MonitorFromRect(&wp.rcNormalPosition, MONITOR_DEFAULTTONULL)) return;  // that screen is gone
  if (wp.showCmd != SW_SHOWMAXIMIZED) wp.showCmd = SW_SHOWNORMAL;
  SetWindowPlacement(g_hwnd, &wp);
}

// ------------------------------------------------------------------ window look

/** Title bar in the app's colors (Windows 11), dark or light title text everywhere else. */
void ApplyTitleBar(bool dark, COLORREF caption) {
  BOOL useDark = dark ? TRUE : FALSE;
  if (DwmSetWindowAttribute(g_hwnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &useDark, sizeof useDark) != S_OK) {
    DwmSetWindowAttribute(g_hwnd, 19 /* same, before Windows 10 20H1 */, &useDark, sizeof useDark);
  }
  COLORREF text = dark ? RGB(0xEC, 0xEB, 0xE8) : RGB(0x1F, 0x1E, 0x1D);
  DwmSetWindowAttribute(g_hwnd, 35 /* DWMWA_CAPTION_COLOR */, &caption, sizeof caption);
  DwmSetWindowAttribute(g_hwnd, 36 /* DWMWA_TEXT_COLOR */, &text, sizeof text);
  DwmSetWindowAttribute(g_hwnd, 34 /* DWMWA_BORDER_COLOR */, &caption, sizeof caption);
}

void SetIcons() {
  HINSTANCE inst = GetModuleHandleW(nullptr);
  auto big = static_cast<HICON>(LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), 0));
  auto small = static_cast<HICON>(LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0));
  if (big) SendMessageW(g_hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(big));
  if (small) SendMessageW(g_hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(small));
}

const char *kLogo =
    "<svg viewBox='0 0 64 64' width='64' height='64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>"
    "<stop offset='0' stop-color='#4ff0a8'/><stop offset='1' stop-color='#1fa974'/></linearGradient></defs>"
    "<rect x='2' y='2' width='60' height='60' rx='16' fill='url(#g)'/>"
    "<path d='M18 22 L30 32 L18 42' fill='none' stroke='#0d2a1e' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'/>"
    "<path d='M34 43 H47' fill='none' stroke='#0d2a1e' stroke-width='6' stroke-linecap='round'/></svg>";

std::string Page(bool dark, const std::string &body) {
  std::string bg = dark ? "#1d1c1b" : "#faf9f6";
  std::string fg = dark ? "#ecebe8" : "#1f1e1d";
  return "<!doctype html><html><head><meta charset='utf-8'><style>"
         "html,body{margin:0;height:100%;background:" + bg + ";color:" + fg + ";font:14px 'Segoe UI',system-ui,sans-serif}"
         "body{display:flex;align-items:center;justify-content:center}"
         ".box{text-align:center;max-width:720px;padding:24px}"
         ".pulse{animation:p 1.4s ease-in-out infinite;opacity:.75}@keyframes p{50%{opacity:.35}}"
         "h1{font-size:18px;margin:18px 0 8px}p{opacity:.75;line-height:1.5}"
         "pre{text-align:left;max-height:320px;overflow:auto;background:rgba(127,127,127,.12);padding:12px;border-radius:8px;font:12px Consolas,monospace;white-space:pre-wrap}"
         "button{margin-top:14px;padding:9px 18px;border-radius:8px;border:0;background:#1fa974;color:#fff;font:600 14px 'Segoe UI',sans-serif;cursor:pointer}"
         "</style></head><body><div class='box'>" + std::string(kLogo) + body + "</div></body></html>";
}

std::string SplashHtml(bool dark) { return Page(dark, "<p class='pulse'>Starting FreeCode&hellip;</p>"); }

/** The last run's lines from FreeCode's log, to show why it stopped. */
std::string LogTail() {
  std::wstring home = Env(L"FREECODE_HOME");
  if (home.empty()) home = Env(L"USERPROFILE") + L"\\.freecode";
  std::wstring file = home + L"\\logs\\desktop.log";
  HANDLE f = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
  if (f == INVALID_HANDLE_VALUE) return "";
  std::string tail;
  LARGE_INTEGER size;
  if (GetFileSizeEx(f, &size)) {
    LARGE_INTEGER pos;
    pos.QuadPart = size.QuadPart > 6000 ? size.QuadPart - 6000 : 0;
    SetFilePointerEx(f, pos, nullptr, FILE_BEGIN);
    char buf[6001];
    DWORD got = 0;
    if (ReadFile(f, buf, 6000, &got, nullptr)) tail.assign(buf, got);
  }
  CloseHandle(f);
  size_t start = tail.rfind("\n--- ");
  if (start != std::string::npos) tail = tail.substr(start + 1);
  return tail;
}

void ShowStopped() {
  if (!g_view || g_closing) return;
  std::string tail = LogTail();
  g_view->set_html(Page(SavedThemeIsDark(),
                        "<h1>FreeCode stopped</h1><p>The FreeCode engine closed unexpectedly.</p>" +
                            (tail.empty() ? std::string() : "<pre>" + HtmlEscape(tail) + "</pre>") +
                            "<button onclick='window.fcHostRestart()'>Restart FreeCode</button>"));
}

// ------------------------------------------------------------------ the FreeCode server (Node.js)

struct ReaderArgs {
  HANDLE pipe;
  LONG generation;
};

DWORD WINAPI ReadServerOutput(LPVOID param) {
  std::unique_ptr<ReaderArgs> args(static_cast<ReaderArgs *>(param));
  std::string buf;
  bool ready = false;
  char chunk[4096];
  DWORD n = 0;
  while (ReadFile(args->pipe, chunk, sizeof chunk, &n, nullptr) && n > 0) {
    if (ready) continue;  // keep draining so the server never blocks on a full pipe
    buf.append(chunk, n);
    size_t nl;
    while ((nl = buf.find('\n')) != std::string::npos) {
      std::string line = buf.substr(0, nl);
      buf.erase(0, nl + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.rfind("FREECODE_READY ", 0) == 0) {
        std::string url = line.substr(15);
        LONG gen = args->generation;
        ready = true;
        g_view->dispatch([url, gen] {
          if (gen == g_generation) g_view->navigate(url);
        });
        break;
      }
    }
    if (buf.size() > 65536) buf.erase(0, buf.size() - 4096);
  }
  CloseHandle(args->pipe);
  LONG gen = args->generation;
  g_view->dispatch([gen] {
    if (gen == g_generation) ShowStopped();
  });
  return 0;
}

bool StartServer() {
  SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, TRUE};
  HANDLE inRead = nullptr, inWrite = nullptr, outRead = nullptr, outWrite = nullptr;
  if (!CreatePipe(&inRead, &inWrite, &sa, 0)) return false;
  if (!CreatePipe(&outRead, &outWrite, &sa, 0)) {
    CloseHandle(inRead);
    CloseHandle(inWrite);
    return false;
  }
  SetHandleInformation(inWrite, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);

  std::wstring node = g_dir + L"\\runtime\\node.exe";
  std::wstring script = g_dir + L"\\app\\bin\\freecode.js";
  std::wstring cmd = Quote(node) + L" " + Quote(script) + L" app --host";
  if (!g_folder.empty()) cmd += L" --cwd " + Quote(g_folder);
  std::wstring home = Env(L"USERPROFILE");

  STARTUPINFOW si{};
  si.cb = sizeof si;
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = inRead;
  si.hStdOutput = outWrite;
  si.hStdError = outWrite;
  PROCESS_INFORMATION pi{};
  BOOL ok = CreateProcessW(node.c_str(), cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, home.empty() ? nullptr : home.c_str(), &si, &pi);
  CloseHandle(inRead);
  CloseHandle(outWrite);
  if (!ok) {
    CloseHandle(inWrite);
    CloseHandle(outRead);
    return false;
  }
  CloseHandle(pi.hThread);
  g_server.process = pi.hProcess;
  g_server.stdinWrite = inWrite;
  LONG gen = InterlockedIncrement(&g_generation);
  g_server.reader = CreateThread(nullptr, 0, ReadServerOutput, new ReaderArgs{outRead, gen}, 0, nullptr);
  return true;
}

void StopServer() {
  InterlockedIncrement(&g_generation);
  if (g_server.stdinWrite) {
    CloseHandle(g_server.stdinWrite);  // FreeCode saves and exits when its input closes
    g_server.stdinWrite = nullptr;
  }
  if (g_server.process) {
    if (WaitForSingleObject(g_server.process, 5000) == WAIT_TIMEOUT) TerminateProcess(g_server.process, 1);
    CloseHandle(g_server.process);
    g_server.process = nullptr;
  }
  if (g_server.reader) {
    WaitForSingleObject(g_server.reader, 3000);  // it ends once the server's output closes
    CloseHandle(g_server.reader);
    g_server.reader = nullptr;
  }
}

void ShowStartFailure() {
  g_view->set_html(Page(SavedThemeIsDark(),
                        "<h1>FreeCode could not start</h1><p>Its files may be damaged. Please run the FreeCode setup again.</p>"
                        "<button onclick='window.fcHostRestart()'>Try again</button>"));
}

/** No WebView2 on this PC: let FreeCode open an Edge/Chrome app window by itself. */
int FallbackToBrowserWindow() {
  std::wstring node = g_dir + L"\\runtime\\node.exe";
  std::wstring cmd = Quote(node) + L" " + Quote(g_dir + L"\\app\\bin\\freecode.js") + L" app --desktop";
  if (!g_folder.empty()) cmd += L" --cwd " + Quote(g_folder);
  std::wstring home = Env(L"USERPROFILE");
  STARTUPINFOW si{};
  si.cb = sizeof si;
  PROCESS_INFORMATION pi{};
  if (!CreateProcessW(node.c_str(), cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, home.empty() ? nullptr : home.c_str(), &si, &pi)) {
    MessageBoxW(nullptr, L"FreeCode could not start. Please run the FreeCode setup again.", L"FreeCode", MB_OK | MB_ICONERROR);
    return 1;
  }
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return 0;
}

// ------------------------------------------------------------------ single window

BOOL CALLBACK FindAppWindowProc(HWND hwnd, LPARAM lp) {
  if (GetPropW(hwnd, kWindowProp)) {
    *reinterpret_cast<HWND *>(lp) = hwnd;
    return FALSE;
  }
  return TRUE;
}

HWND FindAppWindow() {
  HWND found = nullptr;
  EnumWindows(FindAppWindowProc, reinterpret_cast<LPARAM>(&found));
  return found;
}

/** Another FreeCode window is open: bring it forward (and open the requested folder there). */
void HandOver(HWND other) {
  if (!g_folder.empty()) {
    COPYDATASTRUCT cds{kOpenFolder, static_cast<DWORD>((g_folder.size() + 1) * sizeof(wchar_t)), const_cast<wchar_t *>(g_folder.c_str())};
    SendMessageTimeoutW(other, WM_COPYDATA, 0, reinterpret_cast<LPARAM>(&cds), SMTO_ABORTIFHUNG, 3000, nullptr);
  }
  if (IsIconic(other)) ShowWindow(other, SW_RESTORE);
  SetForegroundWindow(other);
}

LRESULT CALLBACK WindowProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_COPYDATA: {
      auto *cds = reinterpret_cast<COPYDATASTRUCT *>(lp);
      if (cds && cds->dwData == kOpenFolder && cds->lpData && cds->cbData >= sizeof(wchar_t)) {
        std::wstring folder(static_cast<const wchar_t *>(cds->lpData), cds->cbData / sizeof(wchar_t));
        while (!folder.empty() && folder.back() == L'\0') folder.pop_back();
        if (!folder.empty() && g_view) g_view->eval("window.fcOpenProject && window.fcOpenProject(" + JsString(Utf8(folder)) + ")");
        return TRUE;
      }
      break;
    }
    case WM_CLOSE:
      SavePlacement();
      InterlockedExchange(&g_closing, 1);
      break;
  }
  return CallWindowProcW(g_prevProc, hwnd, msg, wp, lp);
}

}  // namespace

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
  // "FreeCode.exe <folder>": Explorer's "Open with FreeCode", or a folder dropped on the icon.
  int argc = 0;
  LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; argv && i < argc; ++i) {
    DWORD attr = GetFileAttributesW(argv[i]);
    if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY)) {
      wchar_t full[MAX_PATH * 4];
      DWORD n = GetFullPathNameW(argv[i], MAX_PATH * 4, full, nullptr);
      if (n > 0 && n < MAX_PATH * 4) g_folder.assign(full, n);
      break;
    }
  }
  if (argv) LocalFree(argv);

  // One window at a time: a second start brings the open window forward.
  HANDLE mutex = CreateMutexW(nullptr, FALSE, kMutexName);
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    for (int i = 0; i < 100; ++i) {
      if (HWND other = FindAppWindow()) {
        HandOver(other);
        return 0;
      }
      Sleep(100);
    }
    return 0;
  }

  wchar_t exe[MAX_PATH * 4];
  DWORD len = GetModuleFileNameW(nullptr, exe, MAX_PATH * 4);
  g_dir.assign(exe, len);
  g_dir.erase(g_dir.find_last_of(L'\\'));
  if (!Exists(g_dir + L"\\runtime\\node.exe") || !Exists(g_dir + L"\\app\\bin\\freecode.js")) {
    MessageBoxW(nullptr, L"Some FreeCode files are missing. Please run the FreeCode setup again.", L"FreeCode", MB_OK | MB_ICONERROR);
    return 1;
  }

  bool dark = SavedThemeIsDark();
  // No white flash while the page loads.
  SetEnvironmentVariableW(L"WEBVIEW2_DEFAULT_BACKGROUND_COLOR", dark ? L"FF1D1C1B" : L"FFFAF9F6");

  std::unique_ptr<webview::webview> view;
  try {
    view = std::make_unique<webview::webview>(false, nullptr);
  } catch (const std::exception &) {
    view.reset();
  }
  if (!view) {
    if (mutex) CloseHandle(mutex);
    return FallbackToBrowserWindow();
  }
  g_view = view.get();
  g_hwnd = static_cast<HWND>(view->window().value());
  SetPropW(g_hwnd, kWindowProp, reinterpret_cast<HANDLE>(1));
  view->set_title("FreeCode");
  view->set_size(820, 560, WEBVIEW_HINT_MIN);
  view->set_size(1320, 880, WEBVIEW_HINT_NONE);
  RestorePlacement();
  SetIcons();
  ApplyTitleBar(dark, SavedTitleColor(dark));
  g_prevProc = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(g_hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(WindowProc)));

  // Called by the page: fcHostTheme("dark" | "light", "#rrggbb")
  view->bind("fcHostTheme", [](const std::string &req) -> std::string {
    auto args = JsonStrings(req);
    if (args.empty()) return "null";
    bool isDark = args[0] != "light";
    COLORREF color = SavedTitleColor(isDark);
    if (args.size() > 1 && args[1].size() == 7 && args[1][0] == '#') {
      unsigned long rgb = strtoul(args[1].c_str() + 1, nullptr, 16);
      color = RGB((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
    }
    ApplyTitleBar(isDark, color);
    std::wstring theme = isDark ? L"dark" : L"light";
    RegSetKeyValueW(HKEY_CURRENT_USER, kRegKey, L"Theme", REG_SZ, theme.c_str(), static_cast<DWORD>((theme.size() + 1) * sizeof(wchar_t)));
    DWORD c = color;
    RegSetKeyValueW(HKEY_CURRENT_USER, kRegKey, L"TitleColor", REG_DWORD, &c, sizeof c);
    return "null";
  });
  view->bind("fcHostRestart", [](const std::string &) -> std::string {
    g_view->dispatch([] {
      StopServer();
      g_view->set_html(SplashHtml(SavedThemeIsDark()));
      if (!StartServer()) ShowStartFailure();
    });
    return "null";
  });

  view->set_html(SplashHtml(dark));
  if (!StartServer()) ShowStartFailure();
  view->run();

  InterlockedExchange(&g_closing, 1);
  StopServer();
  g_view = nullptr;
  if (mutex) CloseHandle(mutex);
  return 0;
}
