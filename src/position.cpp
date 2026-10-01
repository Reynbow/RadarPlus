// Player position observer.
//
// The game lays out the player's map marker in one function ("position update"): it projects the
// player's world position into map space and appends a 40-byte marker to a list. We hook it, let
// it run, then read the marker it appended plus the district and UI height, and keep the latest
// sample for the script (coui://base/__radarplus_position__.json).
#include "common.h"
#include <math.h>

namespace rp {

static const char* kSigPositionUpdate =
    "48 89 5C 24 10 48 89 74 24 18 57 41 56 41 57 48 81 EC A0 00 00 00 4C 8B F9 49 8B F9 49 8B C9 49 8B D8 4C "
    "8B F2 E8 ?? ?? ?? ?? 48 8B CB 8B 10 E8 ?? ?? ?? ?? 48 8B F0 48 85 C0 0F 84 ?? ?? ?? ?? 48 8B CF E8 ?? ?? ?? "
    "?? 85 C0 0F 84 ?? ?? ?? ?? C4 C1 7C 10 0F C4 E3 7D 19 C8 01 C4 C3 F9 16 C7 01 C5 FC 11 4C 24 60 4C 89 A4 24 "
    "C0 00 00 00 49 8B DF C5 F8 29 B4 24 90 00 00 00 48 C1 E3 05 48 8B CF 48 03 5C 24 60 C5 F8 29 BC 24 80 00 00 "
    "00 C4 C3 F9 16 CC 01 C5 F8 10 43 10 C5 F8 11 44 24 60 C5 F8 77 E8 ?? ?? ?? ??";
static const char* kSigDistrictGetter = "8B 41 08 48 C1 E0 04 48 03 01 48 39 01 75 ?? 48 8D 41 20";
// Pushes the 40-byte marker record; checked so a changed record layout disables us. Build 25600401 fills a new byte
// at +0x1d (padding before: movzx eax, [rax+8]; mov [rsp+0x4d], al); the fields we read (+0x10, +0x14) are as before.
static const char* kSigMarkerLayout =
    "48 89 5C 24 30 48 89 44 24 38 C5 FA 10 84 24 B8 00 00 00 C5 FA 11 44 24 40 C5 FA 10 8C 24 BC 00 00 00 C5 FA "
    "11 4C 24 44 48 8B 84 24 E0 00 00 00 C5 FA 10 00 C5 FA 11 44 24 48 88 54 24 4C 0F B6 40 08 88 44 24 4D "
    "C5 7A 11 44 24 50 40 88 7C 24 "
    "54 8B 46 0C 4C 8D 04 80 49 C1 E0 03 8B 5E 08 48 8D 0C 9B 48 C1 E1 03 4C 8B 36 49 3B C8 0F 85 ?? ?? ?? ?? 49 "
    "B9 67 66 66 66 66 66 66 66 49 8B C1 48 F7 E9 48 8B DA 48 C1 FB 04 48 8B C3 48 C1 E8 3F 48 03 D8 48 8D 4B 01 "
    "49 8B C1 49 F7 E8 48 C1 FA 04 48 8B C2 48 C1 E8 3F 48 03 D0 4C 8B FA 49 D1 EF 4C 03 FA 4C 3B F9 4C 0F 42 F9 "
    "4B 8D 0C BF 48 C1 E1 03 BA 08 00 00 00 E8 ?? ?? ?? ?? 4C 8B F0 8B 4E 08 4C 8D 04 89 49 C1 E0 03 48 8B 16 48 "
    "8B C8 E8 ?? ?? ?? ?? 48 8B 0E 48 85 C9 74 ?? E8 ?? ?? ?? ?? 4C 89 36 89 5E 08 44 89 7E 0C 8B C3 48 8D 0C 80 "
    "C5 FC 10 44 24 30 C4 C1 7C 11 04 CE C5 FB 10 4C 24 50 C4 C1 7B 11 4C CE 20 FF 46 08";
static const char* kSigViewportSize =
    "48 89 5C 24 08 48 89 74 24 10 57 48 83 EC 20 48 8B F2 48 8B F9 48 83 C1 58 E8 ?? ?? ?? ?? 44 8B 87 10 01 00 00";
// Call sites of the form  call Owner ; lea rdx,[rsp+..] ; mov rcx,rax ; call ViewportSize
static const char* kSigOwnerCall8 = "E8 ?? ?? ?? ?? 48 8D 54 24 ?? 48 8B C8 E8 ?? ?? ?? ??";
static const char* kSigOwnerCall32 = "E8 ?? ?? ?? ?? 48 8D 94 24 ?? ?? ?? ?? 48 8B C8 E8 ?? ?? ?? ??";
static const char* kSigOwnerGetter = "48 8B 05 ?? ?? ?? ?? C3";

static const uint8_t kPrologue[15] = {0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x74,
                                      0x24, 0x18, 0x57, 0x41, 0x56, 0x41, 0x57};

// Build 25600401 dropped the sixth argument (the map screen's flags, whose byte 1 said "full map open"): nothing
// reads that stack slot any more, so neither do we. The script asks the UI whether the map is open instead.
using PositionUpdateFn = void (*)(void* table, void* markers, void* districts, void* districtStack, void* a5);
using OwnerGetterFn = void* (*)();
using ViewportSizeFn = uint32_t* (*)(void* owner, uint32_t* out);

static PositionUpdateFn volatile g_original = nullptr;
static OwnerGetterFn g_ownerGetter = nullptr;
static ViewportSizeFn g_viewportSize = nullptr;
static volatile bool g_installed = false;

struct Sample {
    uint64_t seq, tick, epoch, id;
    float world[3], proj[2], clip[2];
    uint32_t district, uiHeight;
    bool valid;
};
static SRWLOCK g_lock = SRWLOCK_INIT;
static Sample g_last = {};
static volatile LONG64 g_seq = 0, g_calls = 0, g_faults = 0;

static bool Sane(float v) { return isfinite(v) && fabsf(v) <= 1e8f; }

// Reads the marker appended by the original call. Pure C so SEH can guard every access.
static bool ReadSample(void* table, void* markers, void* districtStack, uint32_t before, Sample& s) {
    __try {
        uint8_t* list = (uint8_t*)markers;
        uint32_t after = *(uint32_t*)(list + 8);
        if (before >= 0x1000 || after != before + 1) return false;
        uint8_t* entry = *(uint8_t**)list + (size_t)before * 40;
        uint8_t* t = (uint8_t*)table;
        uint64_t index = *(uint64_t*)(t + 0x18);
        if (index > 0x100000) return false;
        uint64_t id = (*(uint64_t**)(t + 8))[index];
        if (*(uint64_t*)entry != id) return false;
        const float* rec = (const float*)(*(uint8_t**)t + index * 32 + 0x10);
        s.id = id;
        s.world[0] = rec[0];
        s.world[1] = rec[1];
        s.world[2] = rec[2];
        s.clip[0] = *(float*)(entry + 0x08);
        s.clip[1] = *(float*)(entry + 0x0C);
        s.proj[0] = *(float*)(entry + 0x10);
        s.proj[1] = *(float*)(entry + 0x14);
        for (int i = 0; i < 3; ++i)
            if (!Sane(s.world[i])) return false;
        for (int i = 0; i < 2; ++i)
            if (!Sane(s.clip[i]) || !Sane(s.proj[i])) return false;
        uint8_t* ds = (uint8_t*)districtStack;
        uint32_t count = *(uint32_t*)(ds + 8);
        if (count > 0x100) return false;
        s.district = count ? *(uint32_t*)(*(uint8_t**)ds + (size_t)count * 16 - 8) : *(uint32_t*)(ds + 0x20);
        if (!g_ownerGetter || !g_viewportSize) return false;
        uint32_t wh[2] = {0, 0};
        g_viewportSize(g_ownerGetter(), wh);
        if (wh[1] < 0x40 || wh[1] > 0x4000) return false;
        s.uiHeight = wh[1];
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        InterlockedIncrement64(&g_faults);
        return false;
    }
}

static bool ReadCount(void* markers, uint32_t& out) {
    __try {
        out = *(uint32_t*)((uint8_t*)markers + 8);
        return out < 0x1000;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        InterlockedIncrement64(&g_faults);
        return false;
    }
}

static void HookedPositionUpdate(void* table, void* markers, void* districts, void* districtStack, void* a5) {
    uint32_t before = 0;
    bool counted = markers && ReadCount(markers, before);
    g_original(table, markers, districts, districtStack, a5);
    InterlockedIncrement64(&g_calls);
    Sample s = {};
    s.valid = counted && ReadSample(table, markers, districtStack, before, s);
    s.tick = GetTickCount64();
    if (!TryAcquireSRWLockExclusive(&g_lock)) return;  // never stall the game thread
    uint64_t epoch = g_last.epoch;
    if (s.valid) {
        bool same = g_last.valid && g_last.district == s.district && g_last.uiHeight == s.uiHeight &&
                    g_last.id == s.id && s.tick - g_last.tick <= 1000;
        if (!same) ++epoch;
    }
    s.epoch = epoch;
    s.seq = (uint64_t)InterlockedIncrement64(&g_seq);
    g_last = s;
    ReleaseSRWLockExclusive(&g_lock);
}

bool PositionObserverInstalled() { return g_installed; }

bool PlayerWorldPosition(float out[3]) {
    AcquireSRWLockShared(&g_lock);
    Sample s = g_last;
    ReleaseSRWLockShared(&g_lock);
    if (!s.valid || GetTickCount64() - s.tick > 500) return false;
    memcpy(out, s.world, sizeof(s.world));
    return true;
}

std::string PositionJson() {
    Sample s;
    AcquireSRWLockShared(&g_lock);
    s = g_last;
    ReleaseSRWLockShared(&g_lock);
    uint64_t now = GetTickCount64();
    uint64_t age = s.tick ? now - s.tick : 100000;
    float rings[4];
    RingValues(rings);
    uint32_t keys[kKeyCount];
    KeyCounts(keys);
    char buf[896];
    _snprintf_s(buf, sizeof(buf), _TRUNCATE,
                "{\"installed\":%s,\"valid\":%s,\"seq\":%llu,\"epoch\":%llu,\"ageMs\":%llu,\"district\":%u,"
                "\"uiHeight\":%u,\"x\":%.4f,\"y\":%.4f,\"clipX\":%.4f,\"clipY\":%.4f,"
                "\"wx\":%.3f,\"wy\":%.3f,\"wz\":%.3f,\"zoom\":%d,\"zoomSerial\":%u,"
                "\"rings\":[%.3f,%.3f,%.3f,%.3f],\"keys\":[%u,%u,%u,%u],\"calls\":%lld,\"faults\":%lld}",
                g_installed ? "true" : "false", s.valid ? "true" : "false", (unsigned long long)s.seq,
                (unsigned long long)s.epoch, (unsigned long long)age, s.district, s.uiHeight,
                s.proj[0], s.proj[1], s.clip[0], s.clip[1], s.world[0], s.world[1],
                s.world[2], CurrentZoom(), ZoomSerial(), rings[0], rings[1], rings[2], rings[3], keys[0], keys[1],
                keys[2], keys[3], (long long)g_calls, (long long)g_faults);
    return buf;
}

static uint32_t CallTarget(const Image& img, uint32_t rva) { return rva + 5 + (uint32_t)img.I32(rva + 1); }

bool FindPositionTargets(const Image& img, PositionTargets& out, std::string& err) {
    uint32_t update = FindUnique(img, "position update", kSigPositionUpdate, err);
    if (!update) return false;
    uint32_t district = FindUnique(img, "district getter", kSigDistrictGetter, err);
    if (!district) return false;
    if (!FindUnique(img, "marker layout", kSigMarkerLayout, err)) return false;
    uint32_t viewport = FindUnique(img, "viewport size", kSigViewportSize, err);
    if (!viewport) return false;
    if (CallTarget(img, update + 0x25) != district) {
        err = "position update: first call is not the district getter";
        return false;
    }
    if (!MatchAt(img, update, [] { Pattern p; p.Parse("48 89 5C 24 10 48 89 74 24 18 57 41 56 41 57"); return p; }())) {
        err = "position update: unexpected prologue";
        return false;
    }
    // The viewport owner getter: every call site that feeds ViewportSize must agree on it.
    uint32_t owner = 0;
    bool disagree = false;
    struct { const char* sig; uint32_t second; } shapes[] = {{kSigOwnerCall8, 13}, {kSigOwnerCall32, 16}};
    for (auto& shape : shapes) {
        Pattern p;
        p.Parse(shape.sig);
        for (uint32_t site : FindPattern(img, p, 4096)) {
            if (CallTarget(img, site + shape.second) != viewport) continue;
            uint32_t first = CallTarget(img, site);
            if (owner && first != owner) disagree = true;
            owner = first;
        }
    }
    if (disagree) {
        err = "viewport owner: call sites disagree";
        return false;
    }
    Pattern getter;
    getter.Parse(kSigOwnerGetter);
    if (!owner || !MatchAt(img, owner, getter)) {
        err = "viewport owner: not found";
        return false;
    }
    out.update = update;
    out.district = district;
    out.viewport = viewport;
    out.owner = owner;
    return true;
}

bool InstallPositionObserver(const Image& img, std::string& err) {
    PositionTargets tg;
    if (!FindPositionTargets(img, tg, err)) return false;
    const uint32_t update = tg.update, district = tg.district, viewport = tg.viewport, owner = tg.owner;
    uint8_t* target = (uint8_t*)(g_gameBase + update);
    if (memcmp(target, kPrologue, sizeof(kPrologue)) != 0) {
        err = "position update is already patched in memory (another mod hooks it; remove MapFusion)";
        return false;
    }
    g_ownerGetter = (OwnerGetterFn)(g_gameBase + owner);
    g_viewportSize = (ViewportSizeFn)(g_gameBase + viewport);
    if (!InstallJmpHook(target, kPrologue, (void*)&HookedPositionUpdate, (void* volatile*)&g_original, "position update", err))
        return false;
    g_installed = true;
    Log("Position observer active (update +0x%x, district +0x%x, viewport +0x%x, owner +0x%x)", update, district,
        viewport, owner);
    return true;
}

}  // namespace rp
