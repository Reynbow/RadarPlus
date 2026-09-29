#include "common.h"
#include <stdio.h>
#include <stdarg.h>

namespace rp {

static SRWLOCK g_logLock = SRWLOCK_INIT;
static HANDLE g_logFile = INVALID_HANDLE_VALUE;
static LONG g_logLines = 0;

void LogInit() {
    std::wstring path = g_modDir + L"RadarPlus.log";
    g_logFile = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
}

void Log(const char* fmt, ...) {
    if (g_logFile == INVALID_HANDLE_VALUE) return;
    // Keep the log bounded even if something spams it.
    if (InterlockedIncrement(&g_logLines) > 20000) return;
    char buf[2048];
    SYSTEMTIME st;
    GetLocalTime(&st);
    int n = _snprintf_s(buf, sizeof(buf), _TRUNCATE, "%02u:%02u:%02u.%03u ", st.wHour, st.wMinute,
                        st.wSecond, st.wMilliseconds);
    if (n < 0) n = 0;
    va_list ap;
    va_start(ap, fmt);
    int m = _vsnprintf_s(buf + n, sizeof(buf) - n - 2, _TRUNCATE, fmt, ap);
    va_end(ap);
    size_t len = strlen(buf);
    (void)m;
    buf[len++] = '\r';
    buf[len++] = '\n';
    AcquireSRWLockExclusive(&g_logLock);
    DWORD written = 0;
    WriteFile(g_logFile, buf, (DWORD)len, &written, nullptr);
    ReleaseSRWLockExclusive(&g_logLock);
}

std::string Utf8(const std::wstring& w) {
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

std::wstring Wide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
    return w;
}

bool ReadWholeFile(const std::wstring& path, std::string& out, size_t maxBytes) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER size;
    bool ok = GetFileSizeEx(h, &size) && size.QuadPart >= 0 && (uint64_t)size.QuadPart <= maxBytes;
    if (ok) {
        out.resize((size_t)size.QuadPart);
        size_t done = 0;
        while (ok && done < out.size()) {
            DWORD chunk = (DWORD)std::min<size_t>(out.size() - done, 64u << 20), got = 0;
            ok = ReadFile(h, &out[done], chunk, &got, nullptr) && got > 0;
            done += got;
        }
    }
    CloseHandle(h);
    return ok;
}

bool EnsureDirectoryFor(const std::wstring& filePath) {
    size_t slash = filePath.find_last_of(L"\\/");
    if (slash == std::wstring::npos) return true;
    std::wstring dir = filePath.substr(0, slash);
    // Walk forward creating each level; existing levels are fine.
    for (size_t i = 3; i <= dir.size(); ++i) {
        if (i == dir.size() || dir[i] == L'\\' || dir[i] == L'/') {
            std::wstring part = dir.substr(0, i);
            if (!CreateDirectoryW(part.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) {
                DWORD attr = GetFileAttributesW(part.c_str());
                if (attr == INVALID_FILE_ATTRIBUTES || !(attr & FILE_ATTRIBUTE_DIRECTORY)) return false;
            }
        }
    }
    return true;
}

bool WriteWholeFile(const std::wstring& path, const void* data, size_t size) {
    if (!EnsureDirectoryFor(path)) return false;
    std::wstring tmp = path + L".tmp";
    HANDLE h = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    const uint8_t* p = (const uint8_t*)data;
    size_t done = 0;
    bool ok = true;
    while (ok && done < size) {
        DWORD chunk = (DWORD)std::min<size_t>(size - done, 64u << 20), wrote = 0;
        ok = WriteFile(h, p + done, chunk, &wrote, nullptr) && wrote == chunk;
        done += wrote;
    }
    CloseHandle(h);
    if (!ok || !MoveFileExW(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(tmp.c_str());
        return false;
    }
    return true;
}

static int Hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

std::string UrlDecode(const char* s, size_t n) {
    std::string out;
    out.reserve(n);
    for (size_t i = 0; i < n; ++i) {
        char c = s[i];
        if (c == '+') {
            out.push_back(' ');
        } else if (c == '%' && i + 2 < n && Hex(s[i + 1]) >= 0 && Hex(s[i + 2]) >= 0) {
            out.push_back((char)(Hex(s[i + 1]) * 16 + Hex(s[i + 2])));
            i += 2;
        } else {
            out.push_back(c);
        }
    }
    return out;
}

bool QueryParam(const char* query, const char* key, std::string& out) {
    if (!query) return false;
    size_t klen = strlen(key);
    const char* p = query;
    while (*p) {
        const char* amp = strchr(p, '&');
        const char* hash = strchr(p, '#');
        const char* end = amp ? amp : p + strlen(p);
        if (hash && hash < end) end = hash;
        const char* eq = (const char*)memchr(p, '=', end - p);
        size_t nameLen = eq ? (size_t)(eq - p) : (size_t)(end - p);
        if (nameLen == klen && memcmp(p, key, klen) == 0) {
            out = eq ? UrlDecode(eq + 1, end - eq - 1) : std::string();
            return true;
        }
        if (!amp || (hash && hash < amp)) break;
        p = amp + 1;
    }
    return false;
}

std::string JsonEscape(const std::string& s) {
    std::string o;
    o.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) {
                    char b[8];
                    sprintf_s(b, "\\u%04x", c);
                    o += b;
                } else {
                    o.push_back((char)c);
                }
        }
    }
    return o;
}

bool IsSafeJsonBlob(const std::string& s) {
    if (s.empty() || s.size() > 16384) return false;
    // Only what an atlas record needs: numbers, identifiers, paths, JSON punctuation.
    for (unsigned char c : s) {
        bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' ||
                  c == '-' || c == '+' || c == '.' || c == '/' || c == ':' || c == ',' || c == '{' || c == '}' ||
                  c == '[' || c == ']' || c == '"' || c == ' ';
        if (!ok) return false;
    }
    // No "</" or comment starts; with the charset above, only "/*" or "//" could matter.
    if (s.find("/*") != std::string::npos || s.find("//") != std::string::npos) return false;
    return true;
}

}  // namespace rp
