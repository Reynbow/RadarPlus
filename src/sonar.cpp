// Sonar range ("zoom"). The sonar rings are engine tweakables registered by name, e.g.
// "UI: Sonar Exploration ring 1 distance" = 40 m. Each registration looks like
//     lea rax,[name] ... lea rcx,[tweakable] ... vmovdqu xmm0,[defaults] ; vmovups [tweakable+18h],xmm0
// where the 16 bytes at +18h are {value, min, max, default}. Scaling the values scales the sonar:
// POIs, rings and our terrain all follow.
#include "common.h"
#include <atomic>

namespace rp {

static const char* kRingNames[4] = {
    "UI: Sonar Exploration ring 1 distance",
    "UI: Sonar Exploration ring 2 distance",
    "UI: Sonar Combat ring 1 distance",
    "UI: Sonar Combat ring 2 distance",
};

static float* g_value[4] = {};  // live {value,min,max,default} blocks
static float g_base[4] = {};    // the game's defaults
static bool g_available = false;
static std::atomic<int> g_zoom{100};
static std::atomic<uint32_t> g_serial{0};
static SRWLOCK g_zoomLock = SRWLOCK_INIT;

static uint32_t FindString(const Image& img, const char* s) {
    size_t n = strlen(s) + 1;  // include the terminator
    uint32_t found = 0;
    int count = 0;
    for (const Section& sec : img.secs) {
        if (sec.exec || sec.size < n) continue;
        const uint8_t* base = &img.mem[sec.rva];
        size_t i = 0, len = sec.size - n + 1;
        while (i < len) {
            const void* hit = memchr(base + i, (uint8_t)s[0], len - i);
            if (!hit) break;
            i = (const uint8_t*)hit - base;
            if (memcmp(base + i, s, n) == 0) {
                found = sec.rva + (uint32_t)i;
                ++count;
            }
            ++i;
        }
    }
    return count == 1 ? found : 0;
}

// Unique "lea rax,[rip+disp32]" whose target is rva.
static uint32_t FindLeaRax(const Image& img, uint32_t target, int& count) {
    count = 0;
    uint32_t found = 0;
    for (const Section& sec : img.secs) {
        if (!sec.exec || sec.size < 7) continue;
        const uint8_t* base = &img.mem[sec.rva];
        size_t len = sec.size - 6, i = 0;
        while (i < len) {
            const void* hit = memchr(base + i, 0x48, len - i);
            if (!hit) break;
            i = (const uint8_t*)hit - base;
            if (base[i + 1] == 0x8D && base[i + 2] == 0x05) {
                int32_t disp;
                memcpy(&disp, base + i + 3, 4);
                if (sec.rva + (uint32_t)i + 7 + (uint32_t)disp == target) {
                    found = sec.rva + (uint32_t)i;
                    ++count;
                }
            }
            ++i;
        }
    }
    return found;
}

bool FindSonarRings(const Image& img, std::string& err) {
    for (int r = 0; r < 4; ++r) {
        const char* name = kRingNames[r];
        uint32_t str = FindString(img, name);
        if (!str) {
            err = std::string(name) + ": name string not found";
            return false;
        }
        int refs = 0;
        uint32_t reg = FindLeaRax(img, str, refs);
        if (refs != 1) {
            err = std::string(name) + (refs ? ": registration found more than once" : ": registration not found");
            return false;
        }
        uint32_t tweak = 0, store = 0, defaults = 0;
        for (uint32_t k = 7; k < 0x80 && img.Contains(reg + k, 8); ++k) {
            const uint8_t* c = &img.mem[reg + k];
            if (!tweak && c[0] == 0x48 && c[1] == 0x8D && c[2] == 0x0D) tweak = reg + k + 7 + (uint32_t)img.I32(reg + k + 3);
            if (!defaults && c[0] == 0xC5 && (c[1] == 0xFA || c[1] == 0xF9 || c[1] == 0xF8) && (c[2] == 0x6F || c[2] == 0x10) &&
                c[3] == 0x05)
                defaults = reg + k + 8 + (uint32_t)img.I32(reg + k + 4);
            if (tweak && !store && c[0] == 0xC5 && c[1] == 0xF8 && c[2] == 0x11 && c[3] == 0x05) {
                store = reg + k + 8 + (uint32_t)img.I32(reg + k + 4);
                break;
            }
        }
        if (!tweak || !store || store != tweak + 0x18) {
            err = std::string(name) + ": value is not at tweakable+0x18";
            return false;
        }
        const Section* sec = img.SectionOf(store);
        if (!sec || !sec->write || sec->exec) {
            err = std::string(name) + ": value is not in writable data";
            return false;
        }
        if (!defaults || !img.Contains(defaults, 16)) {
            err = std::string(name) + ": defaults not found";
            return false;
        }
        float def = img.F32(defaults);  // {value,min,max,default}
        if (!(def > 1.0f && def < 1000.0f)) {
            err = std::string(name) + ": default distance out of range";
            return false;
        }
        g_base[r] = def;
        g_value[r] = (float*)(g_gameBase + store);
    }
    g_available = true;
    Log("Sonar rings found: explore %.0f/%.0f m, combat %.0f/%.0f m", g_base[0], g_base[1], g_base[2], g_base[3]);
    return true;
}

bool SonarRingsAvailable() { return g_available; }
int CurrentZoom() { return g_zoom.load(); }
uint32_t ZoomSerial() { return g_serial.load(); }

void RingValues(float out[4]) {
    int z = g_zoom.load();
    for (int i = 0; i < 4; ++i) out[i] = g_available ? g_base[i] * z / 100.0f : (i == 1 ? 120.0f : i == 3 ? 80.0f : 40.0f);
}

bool ApplyZoom(int percent) {
    if (!g_available) return false;
    if (percent < 25 || percent > 1000) return false;  // 10 m .. 400 m for the 40 m default ring
    AcquireSRWLockExclusive(&g_zoomLock);
    for (int i = 0; i < 4; ++i) {
        float v = g_base[i] * percent / 100.0f;
        float* t = g_value[i];
        // Widen the allowed range too, in case the engine clamps reads to {min,max}.
        if (t[1] > v) t[1] = v;
        if (t[2] < v) t[2] = v;
        t[0] = v;
    }
    bool changed = g_zoom.exchange(percent) != percent;
    ReleaseSRWLockExclusive(&g_zoomLock);
    if (changed) {
        ++g_serial;
        Log("Sonar range %d%%: ring 1 %.1f m (explore) / %.1f m (combat)", percent, g_base[0] * percent / 100.0f,
            g_base[2] * percent / 100.0f);
    }
    return true;
}

std::string ZoomJson(bool ok) {
    float r[4];
    RingValues(r);
    char buf[256];
    _snprintf_s(buf, sizeof(buf), _TRUNCATE,
                "{\"ok\":%s,\"available\":%s,\"zoom\":%d,\"serial\":%u,\"explore\":%.4f,\"combat\":%.4f,"
                "\"rings\":[%.4f,%.4f,%.4f,%.4f]}",
                ok ? "true" : "false", g_available ? "true" : "false", g_zoom.load(), g_serial.load(), r[0], r[2],
                r[0], r[1], r[2], r[3]);
    return buf;
}

}  // namespace rp
