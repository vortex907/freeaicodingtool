/*
 * FreeCode.exe: the desktop launcher installed by the Windows setup.
 * Starts the bundled Node.js runtime with the FreeCode app, without a console window.
 * If FreeCode fails while starting, it shows the end of the log instead of failing silently.
 * Built with MinGW-w64 by scripts/build-windows.mjs.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <wchar.h>

#define CMD_MAX 32768
#define PATH_MAX_W 4096

static wchar_t cmd[CMD_MAX];

static void error_box(const wchar_t *msg) {
  MessageBoxW(NULL, msg, L"FreeCode", MB_OK | MB_ICONERROR);
}

static void append(const wchar_t *s) {
  size_t used = wcslen(cmd);
  size_t add = wcslen(s);
  if (used + add + 1 < CMD_MAX) wmemcpy(cmd + used, s, add + 1);
}

/* Appends one argument quoted so that the C runtime parses it back unchanged. */
static void append_quoted(const wchar_t *arg) {
  static wchar_t tmp[CMD_MAX];
  size_t n = 0;
  tmp[n++] = L'"';
  for (const wchar_t *p = arg;; p++) {
    size_t slashes = 0;
    while (*p == L'\\') {
      p++;
      slashes++;
    }
    if (n + slashes * 2 + 4 >= CMD_MAX) break;
    if (*p == 0) {
      for (size_t i = 0; i < slashes * 2; i++) tmp[n++] = L'\\';
      break;
    }
    if (*p == L'"') {
      for (size_t i = 0; i < slashes * 2 + 1; i++) tmp[n++] = L'\\';
    } else {
      for (size_t i = 0; i < slashes; i++) tmp[n++] = L'\\';
    }
    tmp[n++] = *p;
  }
  tmp[n++] = L'"';
  tmp[n] = 0;
  append(tmp);
}

static int exists(const wchar_t *path) {
  return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

/* FreeCode's data folder: %FREECODE_HOME%, else %USERPROFILE%\.freecode */
static void data_dir(wchar_t *out, DWORD cap) {
  DWORD n = GetEnvironmentVariableW(L"FREECODE_HOME", out, cap);
  if (n > 0 && n < cap) return;
  n = GetEnvironmentVariableW(L"USERPROFILE", out, cap);
  if (n == 0 || n >= cap) out[0] = 0;
  _snwprintf(out + wcslen(out), cap - wcslen(out), L"\\.freecode");
  out[cap - 1] = 0;
}

static void show_failure(DWORD code) {
  wchar_t log[PATH_MAX_W];
  data_dir(log, PATH_MAX_W - 32);
  wcscat(log, L"\\logs\\desktop.log");
  char tail[3001] = {0};
  HANDLE f = CreateFileW(log, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
  if (f != INVALID_HANDLE_VALUE) {
    LARGE_INTEGER size, pos;
    if (GetFileSizeEx(f, &size)) {
      pos.QuadPart = size.QuadPart > 3000 ? size.QuadPart - 3000 : 0;
      SetFilePointerEx(f, pos, NULL, FILE_BEGIN);
      DWORD got = 0;
      if (ReadFile(f, tail, 3000, &got, NULL)) tail[got] = 0;
    }
    CloseHandle(f);
  }
  static wchar_t wtail[3001];
  wtail[0] = 0;
  MultiByteToWideChar(CP_UTF8, 0, tail, -1, wtail, 3001);
  /* Start at the most recent run. */
  wchar_t *last = wtail, *p = wtail;
  while ((p = wcsstr(p, L"\n--- ")) != NULL) last = ++p;
  static wchar_t msg[4096];
  _snwprintf(msg, 4096, L"FreeCode stopped while starting (exit code %lu).\n\nLog: %ls\n\n%ls", (unsigned long)code, log, last);
  msg[4095] = 0;
  MessageBoxW(NULL, msg, L"FreeCode", MB_OK | MB_ICONERROR);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR args, int show) {
  (void)inst;
  (void)prev;
  (void)args;
  (void)show;
  wchar_t dir[PATH_MAX_W];
  DWORD n = GetModuleFileNameW(NULL, dir, PATH_MAX_W);
  if (n == 0 || n >= PATH_MAX_W) {
    error_box(L"Could not find the FreeCode folder.");
    return 1;
  }
  wchar_t *slash = wcsrchr(dir, L'\\');
  if (slash) *slash = 0;

  wchar_t node[PATH_MAX_W], script[PATH_MAX_W];
  _snwprintf(node, PATH_MAX_W, L"%ls\\runtime\\node.exe", dir);
  _snwprintf(script, PATH_MAX_W, L"%ls\\app\\bin\\freecode.js", dir);
  node[PATH_MAX_W - 1] = script[PATH_MAX_W - 1] = 0;
  if (!exists(node) || !exists(script)) {
    error_box(L"Some FreeCode files are missing. Please run the FreeCode setup again.");
    return 1;
  }

  cmd[0] = 0;
  append_quoted(node);
  append(L" ");
  append_quoted(script);
  append(L" app --desktop");

  /* "FreeCode.exe <folder>" (Explorer's "Open with FreeCode", or a folder dropped on the icon). */
  int argc = 0;
  LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; argv && i < argc; i++) {
    DWORD attr = GetFileAttributesW(argv[i]);
    if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY)) {
      wchar_t full[PATH_MAX_W];
      DWORD len = GetFullPathNameW(argv[i], PATH_MAX_W, full, NULL);
      if (len > 0 && len < PATH_MAX_W) {
        append(L" --cwd ");
        append_quoted(full);
      }
      break;
    }
  }
  if (argv) LocalFree(argv);

  wchar_t home[PATH_MAX_W];
  DWORD hl = GetEnvironmentVariableW(L"USERPROFILE", home, PATH_MAX_W);
  const wchar_t *workdir = hl > 0 && hl < PATH_MAX_W ? home : NULL;

  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof si);
  ZeroMemory(&pi, sizeof pi);
  si.cb = sizeof si;
  if (!CreateProcessW(node, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, workdir, &si, &pi)) {
    wchar_t msg[256];
    _snwprintf(msg, 256, L"Could not start FreeCode (Windows error %lu).", (unsigned long)GetLastError());
    msg[255] = 0;
    error_box(msg);
    return 1;
  }
  CloseHandle(pi.hThread);
  /* Wait a little: a crash during startup gets reported instead of vanishing silently. */
  if (WaitForSingleObject(pi.hProcess, 15000) == WAIT_OBJECT_0) {
    DWORD code = 0;
    if (GetExitCodeProcess(pi.hProcess, &code) && code != 0) show_failure(code);
  }
  CloseHandle(pi.hProcess);
  return 0;
}
