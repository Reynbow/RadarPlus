// Show on press: a controller button (D-pad Up unless the player picks another) shows the radar or the world
// markers for a while. Xbox-style pads are
// read through XInput; DualSense, DualSense Edge and DualShock 4 pads from their HID input reports, so they work
// without Steam Input too (FastTravelPlus's reader). Both are read-only and shared with the game, so the button
// keeps doing what it does there. Like the keyboard hotkeys, the DLL only counts presses; the script decides what
// a press does.
#include "common.h"
#include <atomic>
#include <vector>
#include <setupapi.h>
#include <hidsdi.h>
#include <hidpi.h>

#pragma comment(lib, "hid.lib")
#pragma comment(lib, "setupapi.lib")

namespace rp {

enum { kA = 1, kB, kX, kY, kLB, kRB, kLT, kRT, kView, kMenu, kLS, kRS, kUp, kDown, kLeft, kRight, kPadCount };
static inline uint32_t Bit(int button) { return 1u << button; }

// Show on press: the bound controller button (its bit, 0 = none) and keyboard key (VK, 0 = none), and the presses of
// either (hotkeys.cpp counts the key).
static std::atomic<int> g_revealBit{kUp}, g_revealVk{0};
static std::atomic<uint32_t> g_revealPresses{0};
static std::atomic<uint32_t> g_hidButtons{0};    // all connected PlayStation pads, OR'd
static std::atomic<uint32_t> g_hidPads{0};       // how many are open
static std::atomic<uint32_t> g_xinputPads{0};

// ---- XInput (Xbox-style pads, and PlayStation pads through Steam Input) ----
struct XPad {
    WORD wButtons;
    BYTE bLeftTrigger, bRightTrigger;
    SHORT sThumbLX, sThumbLY, sThumbRX, sThumbRY;
};
struct XState {
    DWORD dwPacketNumber;
    XPad Gamepad;
};
using XInputGetStateFn = DWORD(WINAPI*)(DWORD, XState*);
static XInputGetStateFn g_xinputGetState = nullptr;

static void LoadXInput() {
    const wchar_t* dlls[] = {L"xinput1_4.dll", L"xinput1_3.dll", L"xinput9_1_0.dll"};
    for (const wchar_t* d : dlls) {
        HMODULE m = GetModuleHandleW(d);
        if (!m) m = LoadLibraryW(d);
        if (m && (g_xinputGetState = (XInputGetStateFn)GetProcAddress(m, "XInputGetState"))) return;
    }
}

static uint32_t FromXInput(const XPad& p) {
    const WORD w = p.wButtons;
    uint32_t b = 0;
    if (w & 0x1000) b |= Bit(kA);
    if (w & 0x2000) b |= Bit(kB);
    if (w & 0x4000) b |= Bit(kX);
    if (w & 0x8000) b |= Bit(kY);
    if (w & 0x0100) b |= Bit(kLB);
    if (w & 0x0200) b |= Bit(kRB);
    if (p.bLeftTrigger > 64) b |= Bit(kLT);
    if (p.bRightTrigger > 64) b |= Bit(kRT);
    if (w & 0x0020) b |= Bit(kView);
    if (w & 0x0010) b |= Bit(kMenu);
    if (w & 0x0040) b |= Bit(kLS);
    if (w & 0x0080) b |= Bit(kRS);
    if (w & 0x0001) b |= Bit(kUp);
    if (w & 0x0002) b |= Bit(kDown);
    if (w & 0x0004) b |= Bit(kLeft);
    if (w & 0x0008) b |= Bit(kRight);
    return b;
}

// ---- PlayStation pads over HID ----
// Both families share the button bytes: b0 = D-pad hat (low nibble, 8 = none) + Square, Cross, Circle,
// Triangle (bits 4-7); b1 = L1, R1, L2, R2, Share/Create, Options, L3, R3 (bits 0-7).
static uint32_t FromSony(uint8_t b0, uint8_t b1) {
    uint32_t b = 0;
    if (b0 & 0x20) b |= Bit(kA);
    if (b0 & 0x40) b |= Bit(kB);
    if (b0 & 0x10) b |= Bit(kX);
    if (b0 & 0x80) b |= Bit(kY);
    if (b1 & 0x01) b |= Bit(kLB);
    if (b1 & 0x02) b |= Bit(kRB);
    if (b1 & 0x04) b |= Bit(kLT);
    if (b1 & 0x08) b |= Bit(kRT);
    if (b1 & 0x10) b |= Bit(kView);
    if (b1 & 0x20) b |= Bit(kMenu);
    if (b1 & 0x40) b |= Bit(kLS);
    if (b1 & 0x80) b |= Bit(kRS);
    switch (b0 & 0x0f) {
        case 0: b |= Bit(kUp); break;
        case 1: b |= Bit(kUp) | Bit(kRight); break;
        case 2: b |= Bit(kRight); break;
        case 3: b |= Bit(kDown) | Bit(kRight); break;
        case 4: b |= Bit(kDown); break;
        case 5: b |= Bit(kDown) | Bit(kLeft); break;
        case 6: b |= Bit(kLeft); break;
        case 7: b |= Bit(kUp) | Bit(kLeft); break;
        default: break;
    }
    return b;
}

static bool IsDualSense(uint16_t pid) { return pid == 0x0CE6 || pid == 0x0DF2; }
static bool IsSonyPad(uint16_t vid, uint16_t pid) {
    return vid == 0x054C && (IsDualSense(pid) || pid == 0x05C4 || pid == 0x09CC || pid == 0x0BA0);
}

// One input report. reportLength is the device's input report size: 64 over USB, larger over Bluetooth.
bool ParseSonyReport(uint16_t pid, size_t reportLength, const uint8_t* d, size_t n, uint32_t& buttons) {
    if (n < 10) return false;
    size_t at = 0;  // offset of the two button bytes
    if (IsDualSense(pid)) {
        if (d[0] == 0x01 && reportLength == 64 && n >= 11) at = 8;        // USB
        else if (d[0] == 0x31 && n >= 12) at = 9;                         // Bluetooth, full reports
        else if (d[0] == 0x01) at = 5;                                    // Bluetooth, simple reports
    } else {
        if (d[0] == 0x01) at = 5;                                         // USB, and Bluetooth simple reports
        else if (d[0] == 0x11 && n >= 10) at = 7;                         // Bluetooth, full reports
    }
    if (!at) return false;
    buttons = FromSony(d[at], d[at + 1]);
    return true;
}

struct HidPad {
    HANDLE h = INVALID_HANDLE_VALUE;
    HANDLE ev = nullptr;
    OVERLAPPED ov{};
    std::vector<uint8_t> buf;
    uint16_t pid = 0;
    bool pending = false;
    uint32_t buttons = 0;
    std::wstring path;
};

static void ClosePad(HidPad* p) {
    if (p->pending) {
        CancelIoEx(p->h, &p->ov);
        DWORD got = 0;
        GetOverlappedResult(p->h, &p->ov, &got, TRUE);
    }
    if (p->h != INVALID_HANDLE_VALUE) CloseHandle(p->h);
    if (p->ev) CloseHandle(p->ev);
    delete p;
}

// Opens PlayStation pads that aren't open yet. Every device is opened shared (the game and Steam keep theirs).
static void ScanPads(std::vector<HidPad*>& pads) {
    GUID hidGuid;
    HidD_GetHidGuid(&hidGuid);
    HDEVINFO set = SetupDiGetClassDevsW(&hidGuid, nullptr, nullptr, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (set == INVALID_HANDLE_VALUE) return;
    SP_DEVICE_INTERFACE_DATA itf{sizeof(itf)};
    for (DWORD i = 0; pads.size() < 4 && SetupDiEnumDeviceInterfaces(set, nullptr, &hidGuid, i, &itf); ++i) {
        DWORD need = 0;
        SetupDiGetDeviceInterfaceDetailW(set, &itf, nullptr, 0, &need, nullptr);
        if (!need || need > 4096) continue;
        std::vector<uint8_t> raw(need);
        auto* detail = (SP_DEVICE_INTERFACE_DETAIL_DATA_W*)raw.data();
        detail->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W);
        if (!SetupDiGetDeviceInterfaceDetailW(set, &itf, detail, need, nullptr, nullptr)) continue;
        std::wstring path = detail->DevicePath;
        bool open = false;
        for (HidPad* p : pads) open = open || _wcsicmp(p->path.c_str(), path.c_str()) == 0;
        if (open) continue;
        // Attributes first with no access rights, which works for any HID device.
        HANDLE probe = CreateFileW(path.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
        if (probe == INVALID_HANDLE_VALUE) continue;
        HIDD_ATTRIBUTES attr{sizeof(attr)};
        const bool sony = HidD_GetAttributes(probe, &attr) && IsSonyPad(attr.VendorID, attr.ProductID);
        CloseHandle(probe);
        if (!sony) continue;
        HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                               FILE_FLAG_OVERLAPPED, nullptr);
        if (h == INVALID_HANDLE_VALUE) continue;
        PHIDP_PREPARSED_DATA pre = nullptr;
        HIDP_CAPS caps{};
        const bool ok = HidD_GetPreparsedData(h, &pre) && HidP_GetCaps(pre, &caps) == HIDP_STATUS_SUCCESS &&
                        caps.InputReportByteLength >= 10 && caps.InputReportByteLength <= 1024;
        if (pre) HidD_FreePreparsedData(pre);
        if (!ok) {
            CloseHandle(h);
            continue;
        }
        HidD_SetNumInputBuffers(h, 4);  // we read the latest few reports, not a long backlog
        HidPad* p = new HidPad();
        p->h = h;
        p->ev = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        p->buf.assign(caps.InputReportByteLength, 0);
        p->pid = attr.ProductID;
        p->path = path;
        pads.push_back(p);
        Log("Controller: PlayStation pad 054C:%04X (%u-byte reports)", attr.ProductID, caps.InputReportByteLength);
    }
    SetupDiDestroyDeviceInfoList(set);
}

static DWORD WINAPI HidThread(void*) {
    // Let the game open its pads first.
    Sleep(15000);
    std::vector<HidPad*> pads;
    ULONGLONG nextScan = 0;
    for (;;) {
        const ULONGLONG now = GetTickCount64();
        if (now >= nextScan) {
            ScanPads(pads);
            nextScan = now + (pads.empty() ? 3000 : 10000);
        }
        if (pads.empty()) {
            g_hidButtons = 0;
            g_hidPads = 0;
            Sleep(200);
            continue;
        }
        HANDLE events[4];
        DWORD count = 0;
        for (size_t i = 0; i < pads.size(); ++i) {
            HidPad* p = pads[i];
            if (!p->pending) {
                ResetEvent(p->ev);
                p->ov = OVERLAPPED{};
                p->ov.hEvent = p->ev;
                if (ReadFile(p->h, p->buf.data(), (DWORD)p->buf.size(), nullptr, &p->ov) ||
                    GetLastError() == ERROR_IO_PENDING)
                    p->pending = true;
                else
                    p->buttons = 0xFFFFFFFF;  // marks it for closing below
            }
            events[count++] = p->ev;
        }
        WaitForMultipleObjects(count, events, FALSE, 100);
        for (size_t i = 0; i < pads.size();) {
            HidPad* p = pads[i];
            DWORD got = 0;
            bool gone = p->buttons == 0xFFFFFFFF;
            if (!gone && p->pending && GetOverlappedResult(p->h, &p->ov, &got, FALSE)) {
                p->pending = false;
                uint32_t b = 0;
                if (ParseSonyReport(p->pid, p->buf.size(), p->buf.data(), got, b)) p->buttons = b;
            } else if (!gone && p->pending && GetLastError() != ERROR_IO_INCOMPLETE) {
                p->pending = false;
                gone = true;  // unplugged or switched off
            }
            if (gone) {
                Log("Controller: PlayStation pad 054C:%04X gone", p->pid);
                ClosePad(p);
                pads.erase(pads.begin() + i);
                continue;
            }
            ++i;
        }
        uint32_t all = 0;
        for (HidPad* p : pads) all |= p->buttons;
        g_hidButtons = all;
        g_hidPads = (uint32_t)pads.size();
        Sleep(4);  // a pad reports up to 1000 times a second; 250 is plenty for a button press
    }
}

static bool GameHasFocus() {
    HWND fg = GetForegroundWindow();
    if (!fg) return false;
    DWORD pid = 0;
    GetWindowThreadProcessId(fg, &pid);
    return pid == GetCurrentProcessId();
}

// Each time the show button goes down on any pad (while the game has focus) counts as a press; holding it doesn't.
static DWORD WINAPI PadThread(void*) {
    bool connected[4] = {};
    ULONGLONG nextProbe[4] = {};
    bool was = false;
    for (;;) {
        Sleep(10);
        const ULONGLONG now = GetTickCount64();
        uint32_t buttons = g_hidButtons.load();
        uint32_t xpads = 0;
        for (DWORD i = 0; g_xinputGetState && i < 4; ++i) {
            // Asking an empty slot is slow; do that every 2 s only.
            if (!connected[i] && now < nextProbe[i]) continue;
            XState st{};
            connected[i] = g_xinputGetState(i, &st) == ERROR_SUCCESS;
            if (!connected[i]) {
                nextProbe[i] = now + 2000;
                continue;
            }
            ++xpads;
            buttons |= FromXInput(st.Gamepad);
        }
        g_xinputPads = xpads;
        const int bit = g_revealBit.load();
        const bool on = bit && (buttons & Bit(bit)) && GameHasFocus();
        if (on && !was) ++g_revealPresses;
        was = on;
    }
}

// Mod Settings Menu key codes: 256 + the pad button in our bit order (A, B, X, Y, LB, RB, LT, RT, View, Menu, LS, RS,
// D-pad Up, Down, Left, Right), keyboard keys as their virtual-key code (3-254, mouse buttons included); 0 is none.
static const char* kPadNames[] = {"A (Cross)", "B (Circle)",    "X (Square)",     "Y (Triangle)", "LB (L1)", "RB (R1)",
                                  "LT (L2)",   "RT (R2)",       "View (Create)",  "Menu (Options)", "LS (L3)", "RS (R3)",
                                  "D-pad Up",  "D-pad Down",    "D-pad Left",     "D-pad Right"};
bool SetRevealKeys(int padCode, int vk) {
    if (!(padCode == 0 || (padCode >= 256 && padCode < 272)) || !(vk == 0 || (vk >= 3 && vk <= 254))) return false;
    const int bit = padCode ? padCode - 256 + kA : 0;
    const bool changed = g_revealBit.exchange(bit) != bit;
    if (g_revealVk.exchange(vk) != vk || changed)
        Log("Show on press: controller %s, keyboard %s", bit ? kPadNames[bit - kA] : "none",
            vk ? ("key 0x" + [](int v) { char b[8]; sprintf_s(b, "%02x", v); return std::string(b); }(vk)).c_str() : "none");
    return true;
}
int RevealPadCode() { const int b = g_revealBit.load(); return b ? 256 + b - kA : 0; }
int RevealVk() { return g_revealVk.load(); }
void CountRevealPress() { ++g_revealPresses; }
uint32_t RevealPresses() { return g_revealPresses.load(); }

void StartPad() {
    LoadXInput();
    // The saved choice, until the script confirms it (or the player changes it).
    SetRevealKeys((int)MenuSetting("reveal_pad", 268), (int)MenuSetting("reveal_key", 0));
    HANDLE h = CreateThread(nullptr, 0, PadThread, nullptr, 0, nullptr);
    if (h) CloseHandle(h);
    h = CreateThread(nullptr, 0, HidThread, nullptr, 0, nullptr);
    if (h) CloseHandle(h);
    Log("Controller reader ready (XInput %s)", g_xinputGetState ? "ready" : "missing");
}

}  // namespace rp
