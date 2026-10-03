#include "common.h"
#include <wchar.h>

namespace rp {

Config g_cfg;

// Menu option ids (must match radarplus.menu.json). CRModMenu stores the player's choices in
// ModMenuConfig\radarplus.ini under [Settings]; we hand them to the script as its first values.
// radar_zoom (percent) is the pre-1.1 range setting, read once so the script can carry it over.
static const char* kMenuKeys[] = {"radar_size",         "radar_shape",       "radar_north_up",     "radar_icons",
                                  "radar_range",        "radar_icon_range",  "radar_zoom",         "terrain_enabled",
                                  "terrain_opacity",    "radar_backdrop",    "world_markers",      "world_marker_size",
                                  "world_marker_range", "world_marker_labels", "world_marker_combat",
                                  "map_icons",          "reveal_mode",       "reveal_seconds",     "reveal_pad",
                                  "reveal_key"};

static std::wstring IniPath() { return g_modDir + L"RadarPlus.ini"; }
static std::wstring MenuIniPath() { return g_modDir + L"ModMenuConfig\\radarplus.ini"; }

static std::wstring ReadIni(const std::wstring& file, const wchar_t* section, const wchar_t* key, const wchar_t* def) {
    wchar_t buf[256];
    GetPrivateProfileStringW(section, key, def, buf, 256, file.c_str());
    std::wstring s(buf);
    // Trim spaces and a trailing ; comment.
    size_t semi = s.find(L';');
    if (semi != std::wstring::npos) s.resize(semi);
    while (!s.empty() && iswspace(s.back())) s.pop_back();
    size_t start = 0;
    while (start < s.size() && iswspace(s[start])) ++start;
    return s.substr(start);
}

static std::wstring ReadString(const wchar_t* key, const wchar_t* def) { return ReadIni(IniPath(), L"RadarPlus", key, def); }

static bool ReadBool(const wchar_t* key, bool def) {
    std::wstring s = ReadString(key, def ? L"1" : L"0");
    if (s.empty()) return def;
    if (_wcsicmp(s.c_str(), L"true") == 0 || _wcsicmp(s.c_str(), L"on") == 0 || _wcsicmp(s.c_str(), L"yes") == 0)
        return true;
    if (_wcsicmp(s.c_str(), L"false") == 0 || _wcsicmp(s.c_str(), L"off") == 0 || _wcsicmp(s.c_str(), L"no") == 0)
        return false;
    return _wtoi(s.c_str()) != 0;
}

struct NamedKey { const wchar_t* name; int vk; const wchar_t* display; };
static const NamedKey kKeys[] = {
    {L"PageUp", VK_PRIOR, L"Page Up"},           {L"PageDown", VK_NEXT, L"Page Down"},
    {L"Plus", VK_OEM_PLUS, L"+"},                {L"Equals", VK_OEM_PLUS, L"+"},
    {L"Minus", VK_OEM_MINUS, L"-"},              {L"NumpadAdd", VK_ADD, L"Numpad +"},
    {L"NumpadPlus", VK_ADD, L"Numpad +"},        {L"NumpadSubtract", VK_SUBTRACT, L"Numpad -"},
    {L"NumpadMinus", VK_SUBTRACT, L"Numpad -"},  {L"NumpadMultiply", VK_MULTIPLY, L"Numpad *"},
    {L"NumpadDivide", VK_DIVIDE, L"Numpad /"},   {L"NumpadDecimal", VK_DECIMAL, L"Numpad ."},
    {L"Home", VK_HOME, L"Home"},                 {L"End", VK_END, L"End"},
    {L"Insert", VK_INSERT, L"Insert"},           {L"Delete", VK_DELETE, L"Delete"},
    {L"Up", VK_UP, L"Up"},                       {L"Down", VK_DOWN, L"Down"},
    {L"Left", VK_LEFT, L"Left"},                 {L"Right", VK_RIGHT, L"Right"},
    {L"LeftBracket", VK_OEM_4, L"["},            {L"RightBracket", VK_OEM_6, L"]"},
    {L"Comma", VK_OEM_COMMA, L","},              {L"Period", VK_OEM_PERIOD, L"."},
    {L"Backslash", VK_OEM_5, L"\\"},             {L"Semicolon", VK_OEM_1, L";"},
    {L"Quote", VK_OEM_7, L"'"},                  {L"Slash", VK_OEM_2, L"/"},
    {L"Tilde", VK_OEM_3, L"`"},                  {L"MouseMiddle", VK_MBUTTON, L"Middle mouse"},
    {L"Mouse4", VK_XBUTTON1, L"Mouse 4"},        {L"Mouse5", VK_XBUTTON2, L"Mouse 5"},
};

int ParseKeyName(const std::wstring& raw) {
    std::wstring n;
    for (wchar_t c : raw)
        if (!iswspace(c)) n.push_back(c);
    if (n.empty() || _wcsicmp(n.c_str(), L"none") == 0 || _wcsicmp(n.c_str(), L"off") == 0 || n == L"0") return 0;
    if (n.size() > 2 && n[0] == L'0' && (n[1] == L'x' || n[1] == L'X')) {
        int v = (int)wcstol(n.c_str() + 2, nullptr, 16);
        return (v > 0 && v < 256) ? v : 0;
    }
    if (n.size() == 1) {
        wchar_t c = towupper(n[0]);
        if ((c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9')) return (int)c;
        if (c == L'+' || c == L'=') return VK_OEM_PLUS;
        if (c == L'-') return VK_OEM_MINUS;
    }
    if ((n[0] == L'F' || n[0] == L'f') && n.size() <= 3 && iswdigit(n[1])) {
        int f = _wtoi(n.c_str() + 1);
        if (f >= 1 && f <= 24) return VK_F1 + f - 1;
    }
    if (_wcsnicmp(n.c_str(), L"Numpad", 6) == 0 && n.size() == 7 && iswdigit(n[6])) return VK_NUMPAD0 + (n[6] - L'0');
    for (const NamedKey& e : kKeys)
        if (_wcsicmp(n.c_str(), e.name) == 0) return e.vk;
    return 0;
}

std::wstring KeyDisplayName(int vk) {
    if (!vk) return L"";
    for (const NamedKey& e : kKeys)
        if (e.vk == vk) return e.display;
    if ((vk >= 'A' && vk <= 'Z') || (vk >= '0' && vk <= '9')) return std::wstring(1, (wchar_t)vk);
    if (vk >= VK_F1 && vk <= VK_F24) return L"F" + std::to_wstring(vk - VK_F1 + 1);
    if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD9) return L"Numpad " + std::to_wstring(vk - VK_NUMPAD0);
    wchar_t name[64] = {};
    UINT sc = MapVirtualKeyW((UINT)vk, MAPVK_VK_TO_VSC);
    if (sc && GetKeyNameTextW((LONG)(sc << 16), name, 64) > 0) return name;
    wchar_t hex[16];
    swprintf_s(hex, L"key 0x%02X", vk);
    return hex;
}

static void ReadKey(Config::Key& k, const wchar_t* iniKey, const wchar_t* def) {
    k.name = ReadString(iniKey, def);
    k.vk = ParseKeyName(k.name);
    k.display = KeyDisplayName(k.vk);
}

void LoadConfig() {
    Config c;
    c.enabled = ReadBool(L"Enabled", true);
    c.liveMap = ReadBool(L"LiveMap", true);
    c.diagnostics = ReadBool(L"Diagnostics", false);
    c.dumpUI = ReadBool(L"DumpUI", false);
    ReadKey(c.keys[kZoomIn], L"ZoomInKey", L"PageUp");
    ReadKey(c.keys[kZoomOut], L"ZoomOutKey", L"PageDown");
    ReadKey(c.keys[kSizeUp], L"SizeUpKey", L"Plus");
    ReadKey(c.keys[kSizeDown], L"SizeDownKey", L"Minus");
    std::wstring menuIni = MenuIniPath();
    for (const char* key : kMenuKeys) {
        std::wstring wkey = Wide(key);
        std::wstring s = ReadIni(menuIni, L"Settings", wkey.c_str(), L"");
        double v = -1;
        if (!s.empty()) {
            wchar_t* end = nullptr;
            double d = wcstod(s.c_str(), &end);
            if (end != s.c_str() && d == d) v = d;
            else if (_wcsicmp(s.c_str(), L"true") == 0) v = 1;
            else if (_wcsicmp(s.c_str(), L"false") == 0) v = 0;
        }
        c.menu.push_back({key, v});
    }
    g_cfg = c;
}

double MenuSetting(const char* key, double fallback) {
    for (const Config::MenuValue& m : g_cfg.menu)
        if (strcmp(m.key, key) == 0 && m.value >= 0) return m.value;  // -1: not saved yet
    return fallback;
}

}  // namespace rp
