// Hotkeys. We only count presses (with auto-repeat for the size keys) while the game window has
// focus; the script reads the counters and changes the matching menu option, so CRModMenu shows
// and saves the new value like any other setting.
#include "common.h"
#include <atomic>

namespace rp {

static std::atomic<uint32_t> g_counts[kKeyCount];

static bool GameHasFocus() {
    HWND fg = GetForegroundWindow();
    if (!fg) return false;
    DWORD pid = 0;
    GetWindowThreadProcessId(fg, &pid);
    return pid == GetCurrentProcessId();
}

static bool Down(int vk) { return vk && (GetAsyncKeyState(vk) & 0x8000) != 0; }

static DWORD WINAPI HotkeyThread(void*) {
    struct State { bool down = false; ULONGLONG nextRepeat = 0; } st[kKeyCount];
    const bool repeats[kKeyCount] = {false, false, true, true};  // holding +/- keeps resizing
    for (;;) {
        Sleep(15);
        const bool focus = GameHasFocus();
        // Ctrl/Alt combinations belong to the game or Windows, not to us.
        const bool chord = Down(VK_CONTROL) || Down(VK_MENU) || Down(VK_LWIN) || Down(VK_RWIN);
        const ULONGLONG now = GetTickCount64();
        for (int i = 0; i < kKeyCount; ++i) {
            bool down = focus && !chord && Down(g_cfg.keys[i].vk);
            if (down && !st[i].down) {
                ++g_counts[i];
                st[i].nextRepeat = now + 450;
            } else if (down && repeats[i] && now >= st[i].nextRepeat) {
                ++g_counts[i];
                st[i].nextRepeat = now + 110;
            }
            st[i].down = down;
        }
    }
}

void KeyCounts(uint32_t out[kKeyCount]) {
    for (int i = 0; i < kKeyCount; ++i) out[i] = g_counts[i].load();
}

void StartHotkeys() {
    bool any = false;
    for (const Config::Key& k : g_cfg.keys) any = any || k.vk;
    if (!any) return;
    HANDLE h = CreateThread(nullptr, 0, HotkeyThread, nullptr, 0, nullptr);
    if (!h) return;
    CloseHandle(h);
    const char* names[kKeyCount] = {"zoom in", "zoom out", "size up", "size down"};
    for (int i = 0; i < kKeyCount; ++i)
        Log("Hotkey %s: %s (0x%02x)", names[i], g_cfg.keys[i].vk ? Utf8(g_cfg.keys[i].display).c_str() : "off",
            g_cfg.keys[i].vk);
}

}  // namespace rp
