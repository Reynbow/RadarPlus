// Icon filters: the "Custom" choice of Radar icons, World markers and Main map icons.
//
// CRModMenu only saves numbers, so the icons the player hides are kept here, in filters.ini: for each of
// the three settings the icon keys it hides ("pin", "enemy", "m19" for map-marker type 19...), and the
// map-marker types the player has come across, which the picker lists. The script sends the whole state
// whenever it changes, and gets it back at start-up in its config.
#include "common.h"

namespace rp {

static SRWLOCK g_lock = SRWLOCK_INIT;
static std::string g_lists[4];  // Radar, World, Map, Seen
static const char* kNames[4] = {"Radar", "World", "Map", "Seen"};

static std::wstring FiltersPath() { return g_modDir + L"filters.ini"; }

// Comma-separated keys of lower-case letters and digits; nothing else gets in.
bool IsFilterList(const std::string& s) {
    if (s.size() > 1024) return false;
    for (char c : s)
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == ',')) return false;
    return true;
}

void LoadFilters() {
    std::string text;
    if (!ReadWholeFile(FiltersPath(), text, 64u << 10)) return;
    AcquireSRWLockExclusive(&g_lock);
    size_t pos = 0;
    while (pos < text.size()) {
        size_t end = text.find('\n', pos);
        if (end == std::string::npos) end = text.size();
        std::string line = text.substr(pos, end - pos);
        pos = end + 1;
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
        size_t eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string name = line.substr(0, eq), value = line.substr(eq + 1);
        for (int i = 0; i < 4; ++i)
            if (name == kNames[i] && IsFilterList(value)) g_lists[i] = value;
    }
    ReleaseSRWLockExclusive(&g_lock);
    Log("Icon filters: radar [%s] world [%s] map [%s]", g_lists[0].c_str(), g_lists[1].c_str(), g_lists[2].c_str());
}

bool StoreFilters(const std::string& radar, const std::string& world, const std::string& map, const std::string& seen) {
    const std::string* in[4] = {&radar, &world, &map, &seen};
    for (const std::string* s : in)
        if (!IsFilterList(*s)) return false;
    std::string file;
    AcquireSRWLockExclusive(&g_lock);
    bool changed = false;
    for (int i = 0; i < 4; ++i) {
        if (g_lists[i] != *in[i]) changed = true;
        g_lists[i] = *in[i];
    }
    if (changed) {
        file = "; RadarPlus icon filters, set with the Custom choice in Options > MODS > RadarPlus.\n"
               "; Radar, World and Map list the icons each hides; Seen lists map-marker types met so far.\n[Filters]\n";
        for (int i = 0; i < 4; ++i) file += std::string(kNames[i]) + "=" + g_lists[i] + "\n";
    }
    ReleaseSRWLockExclusive(&g_lock);
    if (changed && !WriteWholeFile(FiltersPath(), file.data(), file.size())) {
        Log("Icon filters could not be saved");
        return false;
    }
    return true;
}

// For the script's config: the lists are plain [a-z0-9,], so they need no escaping.
std::string FiltersJs() {
    AcquireSRWLockShared(&g_lock);
    std::string out = "{r:\"" + g_lists[0] + "\",w:\"" + g_lists[1] + "\",m:\"" + g_lists[2] + "\",s:\"" + g_lists[3] + "\"}";
    ReleaseSRWLockShared(&g_lock);
    return out;
}

}  // namespace rp
