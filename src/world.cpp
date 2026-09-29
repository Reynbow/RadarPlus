// World markers: where each sonar icon's object is, and the camera to project it with.
//
// The sonar keeps one entry per icon in its environment ("SonarData"): a list at +0x70 (pointer) and
// +0x78 (count) of 0x50-byte entries
//     +0x00 id   +0x08/+0x10 sonar position (current/previous)   +0x24 kind   +0x2c elevation
//     +0x30 ring state   +0x40 world position (x, y up, z)
// The function that turns them into HUD values every frame ("sonar facts") also keeps a map
// id -> HUD slot (the N in hud_sonar_poi_N_*). We hook it and, once it has run, copy
// {slot, world position} for every entry. The script projects those with the camera the HUD's own
// world-to-screen transform uses: a global whose view-projection matrix (16 doubles, row vectors,
// clip = [x y z 1] * M) sits at +0x1c8 (coui://base/__radarplus_world__.json).
#include "common.h"
#include <math.h>

namespace rp {

// Prologue and start of the sonar facts writer (7 arguments: rdx facts, r8 SonarData, 3 on the stack).
static const char* kSigSonarFacts =
    "48 8B C4 48 89 58 08 48 89 70 10 4C 89 40 18 57 41 54 41 55 41 56 41 57 48 81 EC C0 04 00 00 C5 F8 29 70 C8 "
    "C5 F8 29 78 B8 C5 78 29 40 A8 C5 78 29 48 98 C5 78 29 50 88 C5 78 29 98 78 FF FF FF C5 78 29 A0 68 FF FF FF "
    "C5 78 29 A8 58 FF FF FF C5 78 29 B0 48 FF FF FF C5 78 29 B8 38 FF FF FF 4D 8B E0 48 8B F2 33 FF 41 0F B6 08 "
    "84 C9 74 ?? 41 38 B8 80 00 00 00";
static const uint8_t kFactsPrologue[15] = {0x48, 0x8B, 0xC4, 0x48, 0x89, 0x58, 0x08, 0x48,
                                           0x89, 0x70, 0x10, 0x4C, 0x89, 0x40, 0x18};
// Inside it: the id -> slot lookup in a std::map (node: +0x19 isnil, +0x20 key, +0x28 slot)
//   mov r8,[map] ; mov rax,[r8+8] ; mov rcx,r8 ; cmp byte [rax+19h],0 ; jne ; mov rdx,[rdi] ;
//   cmp [rax+20h],rdx ; jae ; mov rax,[rax+10h]
static const char* kSigSlotLookup =
    "4C 8B 05 ?? ?? ?? ?? 49 8B 40 08 49 8B C8 80 78 19 00 75 ?? 48 8B 17 48 39 50 20 73 ?? 48 8B 40 10 EB ??";
// ... and the loop over the entries: [SonarData+70h], count [SonarData+78h], 50h bytes each.
static const char* kSigEntryLoop =
    "4C 8B BC 24 00 05 00 00 49 8B 7F 70 45 33 E4 41 8B D4 48 89 54 24 78 41 8B 47 78 48 8D 1C 80 48 C1 E3 04";
// Where entries are built: id at +0, sonar positions at +8/+10h ... world position at +40h.
static const char* kSigEntryLayout =
    "48 8D 14 80 48 03 D2 49 8B 04 24 48 89 04 D7 48 8B 45 00 48 89 44 D7 08 49 8B 07 48 89 44 D7 10";
static const char* kSigEntryWorld = "48 8B 84 24 A8 00 00 00 C5 F8 10 00 C5 F8 11 44 D7 40 FF 43 08";

// The HUD's world-to-screen (used by the "world-to-screen" UI data transform). At +0xb4 it calls
// the camera getter (lea rax,[camera] ; ret), at +0x122 the projection core.
static const char* kSigWorldToScreen =
    "48 8B C4 55 56 48 81 EC 48 06 00 00 C5 FA 10 15 ?? ?? ?? ?? C5 FA 10 05 ?? ?? ?? ?? C5 FA 10 0D ?? ?? ?? ?? "
    "C5 78 29 48 B8 C5 78 29 50 A8 48 89 58 10 48 8B F1 48 89 78 E8 48 8D 4C 24 30 C5 F8 28 DA 48 8B FA 49 8B E8 "
    "C5 FA 11 44 24 20 E8";
static const char* kSigCameraGetter = "48 8D 05 ?? ?? ?? ?? C3";
// Projection core: lea rdx,[camera+matrix] at +0x32 (the doubles are converted to floats) ...
static const char* kSigProjectCore =
    "48 8B C4 55 53 56 57 41 54 41 56 41 57 48 8D 68 B8 48 81 EC 10 01 00 00 C5 F8 29 70 B8 C5 F8 29 78 A8 C5 78 "
    "29 40 98 48 8B DA 48 8B F1 C5 78 29 48 88 49 8D 90 ?? ?? ?? ?? 45 0F B6 F9 48 8D 4C";
// ... then at +0x52: w = y*M[7] + x*M[3] + z*M[11] + M[15] (row vectors).
static const char* kSigProjectRows =
    "C5 FA 10 6B 04 C5 FA 10 3B C5 7A 10 43 08 C5 D2 59 4C 24 4C C5 C2 59 44 24 3C C5 7A 10 0D ?? ?? ?? ?? C5 F2 "
    "58 D0 C5 BA 59 4C 24 5C C5 EA 58 D1 C5 EA 58 74 24 6C";
// Lens distortion correction switches read by the core (diagnostics only): cmp [flag],r12b x2, cmp [flag],r12d.
static const struct { uint32_t at; const char* sig; } kLensFlags[3] = {
    {0x98, "44 38 25 ?? ?? ?? ??"}, {0x11e, "44 38 25 ?? ?? ?? ?? 0F 84"}, {0x158, "44 39 25 ?? ?? ?? ??"}};

using SonarFactsFn = void (*)(void* a1, void* facts, void* sonar, void* a4, void* a5, void* a6, void* a7);
static SonarFactsFn volatile g_original = nullptr;
static volatile bool g_installed = false;
static uintptr_t g_slotMap = 0;           // holds the map's head node pointer
static const double* g_matrix = nullptr;  // live view-projection of the HUD camera
static const uint8_t* g_lens[3] = {};

struct Poi {
    uint32_t slot;
    int32_t kind, elevation, ring;
    float pos[3];
};
static const int kMaxPois = 64;  // the game keeps at most 50
static SRWLOCK g_lock = SRWLOCK_INIT;
static Poi g_pois[kMaxPois];
static uint32_t g_count = 0;
static uint64_t g_tick = 0, g_serial = 0;
static volatile LONG64 g_calls = 0, g_faults = 0;
// Cumulative time in our own code (not the game's), for the diagnostics log.
static volatile LONG64 g_hookNs = 0, g_hooks = 0, g_replyNs = 0, g_replies = 0;
static double g_nsPerTick = 0;

static uint64_t Ticks() {
    LARGE_INTEGER t;
    QueryPerformanceCounter(&t);
    return (uint64_t)t.QuadPart;
}
static LONG64 Ns(uint64_t from) { return (LONG64)((double)(Ticks() - from) * g_nsPerTick); }

static bool Sane(float v) { return isfinite(v) && fabsf(v) < 1e7f; }

// Copies {slot, world position} of every sonar entry. Runs on the game thread right after the facts
// writer, when entries and map agree. Pure C so SEH can guard every access.
static bool CopyEntries(void* sonar, Poi* out, uint32_t& n) {
    __try {
        const uint8_t* sd = (const uint8_t*)sonar;
        const uint8_t* entries = *(const uint8_t* const*)(sd + 0x70);
        uint32_t count = *(const uint32_t*)(sd + 0x78);
        n = 0;
        if (!count) return true;
        if (!entries || count > 256) return false;
        const uint8_t* head = *(const uint8_t* const*)g_slotMap;
        if (!head) return false;
        const uint8_t* root = *(const uint8_t* const*)(head + 8);
        for (uint32_t i = 0; i < count && n < kMaxPois; ++i) {
            const uint8_t* e = entries + (size_t)i * 0x50;
            uint64_t id = *(const uint64_t*)e;
            // lower_bound, as the game does it
            const uint8_t* found = head;
            const uint8_t* node = root;
            for (int depth = 0; node && !node[0x19] && depth < 128; ++depth) {
                if (*(const uint64_t*)(node + 0x20) < id) {
                    node = *(const uint8_t* const*)(node + 0x10);
                } else {
                    found = node;
                    node = *(const uint8_t* const*)node;
                }
            }
            if (found == head || id < *(const uint64_t*)(found + 0x20)) continue;  // no slot yet
            uint64_t slot = *(const uint64_t*)(found + 0x28);
            const float* p = (const float*)(e + 0x40);
            if (slot >= 256 || !Sane(p[0]) || !Sane(p[1]) || !Sane(p[2])) continue;
            Poi& o = out[n++];
            o.slot = (uint32_t)slot;
            o.kind = *(const int32_t*)(e + 0x24);
            o.elevation = *(const int32_t*)(e + 0x2c);
            o.ring = *(const int32_t*)(e + 0x30);
            o.pos[0] = p[0];
            o.pos[1] = p[1];
            o.pos[2] = p[2];
        }
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        InterlockedIncrement64(&g_faults);
        return false;
    }
}

static void HookedSonarFacts(void* a1, void* facts, void* sonar, void* a4, void* a5, void* a6, void* a7) {
    g_original(a1, facts, sonar, a4, a5, a6, a7);
    uint64_t start = Ticks();
    LONG64 calls = InterlockedIncrement64(&g_calls);
    Poi tmp[kMaxPois];
    uint32_t n = 0;
    if (!sonar || !CopyEntries(sonar, tmp, n)) return;
    if (g_cfg.diagnostics && (calls == 1 || calls == 600 || calls == 6000) && n) {
        char line[512];
        int len = 0;
        line[0] = 0;
        for (uint32_t i = 0; i < n && i < 6; ++i) {
            int w = _snprintf_s(line + len, sizeof(line) - len, _TRUNCATE, " | slot %u kind %d ring %d elev %d at %.1f,%.1f,%.1f",
                                tmp[i].slot, tmp[i].kind, tmp[i].ring, tmp[i].elevation, tmp[i].pos[0], tmp[i].pos[1],
                                tmp[i].pos[2]);
            if (w < 0) break;
            len += w;
        }
        Log("World markers: call %lld, %u sonar entries%s", (long long)calls, n, line);
    }
    if (TryAcquireSRWLockExclusive(&g_lock)) {  // never stall the game thread
        memcpy(g_pois, tmp, n * sizeof(Poi));
        g_count = n;
        g_tick = GetTickCount64();
        ++g_serial;
        ReleaseSRWLockExclusive(&g_lock);
    }
    InterlockedAdd64(&g_hookNs, Ns(start));
    InterlockedIncrement64(&g_hooks);
}

// The camera is written by the game while we read; take two identical copies.
static bool ReadCamera(double m[16]) {
    __try {
        for (int attempt = 0; attempt < 4; ++attempt) {
            double a[16], b[16];
            memcpy(a, (const void*)g_matrix, sizeof(a));
            memcpy(b, (const void*)g_matrix, sizeof(b));
            if (memcmp(a, b, sizeof(a)) != 0) continue;
            double wsum = 0;
            for (int i = 0; i < 16; ++i)
                if (!isfinite(a[i]) || fabs(a[i]) > 1e12) return false;
            for (int i = 3; i < 16; i += 4) wsum += fabs(a[i]);
            if (!(wsum > 0)) return false;  // not set up yet
            memcpy(m, a, sizeof(a));
            return true;
        }
        return false;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        InterlockedIncrement64(&g_faults);
        return false;
    }
}

static int ReadLensFlag(int i) {
    if (!g_lens[i]) return -1;
    __try {
        return i == 2 ? *(const int32_t*)g_lens[i] : *g_lens[i];
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return -1;
    }
}

bool WorldObserverInstalled() { return g_installed; }

std::string WorldJson() {
    uint64_t start = Ticks();
    Poi pois[kMaxPois];
    AcquireSRWLockShared(&g_lock);
    uint32_t n = g_count;
    memcpy(pois, g_pois, n * sizeof(Poi));
    uint64_t tick = g_tick, serial = g_serial;
    ReleaseSRWLockShared(&g_lock);
    double m[16];
    bool cam = g_installed && ReadCamera(m);
    float player[3];
    bool havePlayer = PlayerWorldPosition(player);
    uint64_t age = tick ? GetTickCount64() - tick : 100000;
    std::string out;
    out.reserve(512 + n * 72);
    char buf[256];
    _snprintf_s(buf, sizeof(buf), _TRUNCATE,
                "{\"installed\":%s,\"serial\":%llu,\"ageMs\":%llu,\"calls\":%lld,\"faults\":%lld,\"lens\":[%d,%d,%d]",
                g_installed ? "true" : "false", (unsigned long long)serial, (unsigned long long)age, (long long)g_calls,
                (long long)g_faults, ReadLensFlag(0), ReadLensFlag(1), ReadLensFlag(2));
    out += buf;
    if (cam) {
        out += ",\"m\":[";
        for (int i = 0; i < 16; ++i) {
            _snprintf_s(buf, sizeof(buf), _TRUNCATE, i ? ",%.10g" : "%.10g", m[i]);
            out += buf;
        }
        out += "]";
    }
    if (havePlayer) {
        _snprintf_s(buf, sizeof(buf), _TRUNCATE, ",\"player\":[%.3f,%.3f,%.3f]", player[0], player[1], player[2]);
        out += buf;
    }
    out += ",\"pois\":[";
    for (uint32_t i = 0; i < n; ++i) {
        const Poi& p = pois[i];
        _snprintf_s(buf, sizeof(buf), _TRUNCATE, "%s[%u,%.3f,%.3f,%.3f,%d,%d,%d]", i ? "," : "", p.slot, p.pos[0],
                    p.pos[1], p.pos[2], p.kind, p.ring, p.elevation);
        out += buf;
    }
    out += "]";
    _snprintf_s(buf, sizeof(buf), _TRUNCATE, ",\"perf\":[%lld,%lld,%lld,%lld]}", (long long)g_hookNs, (long long)g_hooks,
                (long long)g_replyNs, (long long)g_replies);
    out += buf;
    InterlockedAdd64(&g_replyNs, Ns(start));
    InterlockedIncrement64(&g_replies);
    return out;
}

static uint32_t RipTarget(const Image& img, uint32_t at, uint32_t dispAt, uint32_t len) {
    return at + len + (uint32_t)img.I32(at + dispAt);
}
static uint32_t CallTarget(const Image& img, uint32_t rva) { return rva + 5 + (uint32_t)img.I32(rva + 1); }
static bool MatchSig(const Image& img, uint32_t rva, const char* sig) {
    Pattern p;
    return p.Parse(sig) && MatchAt(img, rva, p);
}

bool FindWorldTargets(const Image& img, WorldTargets& out, std::string& err) {
    uint32_t facts = FindUnique(img, "sonar facts", kSigSonarFacts, err);
    if (!facts) return false;
    uint32_t lookup = FindUnique(img, "sonar slot lookup", kSigSlotLookup, err);
    if (!lookup) return false;
    uint32_t loop = FindUnique(img, "sonar entry loop", kSigEntryLoop, err);
    if (!loop) return false;
    if (lookup < facts || lookup > facts + 0x2000 || loop < facts || loop > facts + 0x2000) {
        err = "sonar facts: slot lookup or entry loop outside the function";
        return false;
    }
    if (!FindUnique(img, "sonar entry layout", kSigEntryLayout, err)) return false;
    if (!FindUnique(img, "sonar entry world position", kSigEntryWorld, err)) return false;
    uint32_t slotMap = RipTarget(img, lookup, 3, 7);
    const Section* ms = img.SectionOf(slotMap);
    if (!ms || !ms->write || ms->exec) {
        err = "sonar slot map is not in writable data";
        return false;
    }

    uint32_t w2s = FindUnique(img, "world to screen", kSigWorldToScreen, err);
    if (!w2s) return false;
    if (!img.Contains(w2s + 0x122, 5) || img.mem[w2s + 0xb4] != 0xE8 || img.mem[w2s + 0x122] != 0xE8) {
        err = "world to screen: calls not where expected";
        return false;
    }
    uint32_t getter = CallTarget(img, w2s + 0xb4);
    if (!MatchSig(img, getter, kSigCameraGetter)) {
        err = "camera getter: unexpected code";
        return false;
    }
    uint32_t camera = RipTarget(img, getter, 3, 7);
    const Section* cs = img.SectionOf(camera);
    if (!cs || !cs->write || cs->exec) {
        err = "camera is not in writable data";
        return false;
    }
    uint32_t core = CallTarget(img, w2s + 0x122);
    if (!MatchSig(img, core, kSigProjectCore) || !MatchSig(img, core + 0x52, kSigProjectRows)) {
        err = "projection core: unexpected code";
        return false;
    }
    uint32_t matrix = img.U32(core + 0x35);
    if (matrix < 0x100 || matrix > 0x250 || (matrix & 7)) {  // 16 doubles inside the 0x2d0-byte camera
        err = "camera matrix offset out of range";
        return false;
    }
    out.facts = facts;
    out.slotMap = slotMap;
    out.camera = camera;
    out.matrix = matrix;
    for (int i = 0; i < 3; ++i)
        out.lens[i] = MatchSig(img, core + kLensFlags[i].at, kLensFlags[i].sig) ? RipTarget(img, core + kLensFlags[i].at, 3, 7) : 0;
    return true;
}

bool InstallWorldObserver(const Image& img, std::string& err) {
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    g_nsPerTick = 1e9 / (double)f.QuadPart;
    WorldTargets tg{};
    if (!FindWorldTargets(img, tg, err)) return false;
    g_slotMap = g_gameBase + tg.slotMap;
    g_matrix = (const double*)(g_gameBase + tg.camera + tg.matrix);
    for (int i = 0; i < 3; ++i) g_lens[i] = tg.lens[i] ? (const uint8_t*)(g_gameBase + tg.lens[i]) : nullptr;
    uint8_t* target = (uint8_t*)(g_gameBase + tg.facts);
    if (!InstallJmpHook(target, kFactsPrologue, (void*)&HookedSonarFacts, (void* volatile*)&g_original, "sonar facts", err))
        return false;
    g_installed = true;
    Log("World markers active (sonar facts +0x%x, slot map +0x%x, camera +0x%x, matrix +0x%x, lens flags %d/%d/%d)",
        tg.facts, tg.slotMap, tg.camera, tg.matrix, ReadLensFlag(0), ReadLensFlag(1), ReadLensFlag(2));
    return true;
}

}  // namespace rp
