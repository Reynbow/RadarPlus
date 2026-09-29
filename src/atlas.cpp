// Per-district map tile atlas cache.
//
// The map tiles and their bounds are only published to the UI while the full map is open. The
// script sends each district's atlas here once it has verified it against the live position, and
// we keep it in atlas.cache so the overlay works right away in later sessions.
#include "common.h"
#include <map>

namespace rp {

static SRWLOCK g_lock = SRWLOCK_INIT;
static std::map<uint32_t, std::string> g_atlas;

static std::wstring CachePath() { return g_modDir + L"atlas.cache"; }

void LoadAtlasCache() {
    std::string text;
    if (!ReadWholeFile(CachePath(), text, 4u << 20)) return;
    size_t pos = 0, loaded = 0;
    AcquireSRWLockExclusive(&g_lock);
    while (pos < text.size()) {
        size_t end = text.find('\n', pos);
        if (end == std::string::npos) end = text.size();
        std::string line = text.substr(pos, end - pos);
        pos = end + 1;
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
        if (line.empty() || line[0] == '#') continue;
        size_t eq = line.find('=');
        if (eq == std::string::npos || eq == 0 || eq > 10) continue;  // district ids are 32-bit
        char* stop = nullptr;
        unsigned long long d = strtoull(line.c_str(), &stop, 10);
        if (stop != line.c_str() + eq || d > 0xFFFFFFFFull) continue;
        std::string json = line.substr(eq + 1);
        if (!IsSafeJsonBlob(json) || json.front() != '{' || json.back() != '}') continue;
        g_atlas[(uint32_t)d] = json;
        ++loaded;
    }
    ReleaseSRWLockExclusive(&g_lock);
    Log("Atlas cache: %zu district(s)", loaded);
}

bool StoreAtlas(uint32_t district, const std::string& json) {
    if (!IsSafeJsonBlob(json) || json.front() != '{' || json.back() != '}') return false;
    std::string file;
    AcquireSRWLockExclusive(&g_lock);
    auto it = g_atlas.find(district);
    bool changed = it == g_atlas.end() || it->second != json;
    if (changed) {
        g_atlas[district] = json;
        file = "# RadarPlus map tile cache. Safe to delete; it is rebuilt when you open the map.\n";
        for (auto& e : g_atlas) {
            file += std::to_string(e.first);
            file += '=';
            file += e.second;
            file += '\n';
        }
    }
    ReleaseSRWLockExclusive(&g_lock);
    if (changed) {
        bool ok = WriteWholeFile(CachePath(), file.data(), file.size());
        Log("Atlas for district %u %s", district, ok ? "saved" : "could not be saved");
    }
    return true;
}

std::string AtlasCacheJs() {
    std::string out = "{";
    AcquireSRWLockShared(&g_lock);
    bool first = true;
    for (auto& e : g_atlas) {
        if (!first) out += ',';
        first = false;
        out += '"';
        out += std::to_string(e.first);
        out += "\":";
        out += e.second;
    }
    ReleaseSRWLockShared(&g_lock);
    out += '}';
    return out;
}

}  // namespace rp
