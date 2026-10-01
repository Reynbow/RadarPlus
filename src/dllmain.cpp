// Entry point. crloader (version.dll) loads every DLL in crmods\ at start-up; we do our setup on
// a worker thread so the loader lock is never held while we read and scan the game image.
#include "common.h"

namespace rp {

HMODULE g_self = nullptr;
std::wstring g_modDir;
uintptr_t g_gameBase = 0;

static const char* kKnownBuild = "6aba5bb8-063da000-05fbdb88";  // 25600401: PE time stamp, image size, checksum
static bool g_mapFusion = false;  // the old MapFusion minimap is still installed
static bool g_position = false, g_rings = false, g_world = false;

std::string BuildConfigJs() {
    std::string js = "window.__RadarPlusConfig={version:\"" RADARPLUS_VERSION "\"";
    js += ",diagnostics:";
    js += g_cfg.diagnostics ? "1" : "0";
    js += ",liveMap:";
    js += g_cfg.liveMap ? "1" : "0";
    // Which native endpoints serve position and zoom. With MapFusion still installed its DLL owns the
    // game hooks, so we read its (compatible) endpoints instead.
    js += ",native:{source:\"";
    js += g_mapFusion ? "mapfusion" : "radarplus";
    js += "\",position:";
    js += (g_position || g_mapFusion) ? "1" : "0";
    js += ",zoom:";
    js += (g_rings || g_mapFusion) ? "1" : "0";
    js += ",world:";  // always our own hook: MapFusion has no world markers
    js += g_world ? "1" : "0";
    js += "}";
    const char* keyIds[kKeyCount] = {"zoomIn", "zoomOut", "sizeUp", "sizeDown"};
    js += ",keys:{";
    for (int i = 0; i < kKeyCount; ++i) {
        if (i) js += ',';
        js += keyIds[i];
        js += ":\"" + JsonEscape(Utf8(g_cfg.keys[i].vk ? g_cfg.keys[i].display : L"")) + "\"";
    }
    js += "}";
    js += ",menu:{";
    bool first = true;
    for (const Config::MenuValue& m : g_cfg.menu) {
        if (m.value < 0) continue;
        char num[64];
        sprintf_s(num, "%.4f", m.value);
        if (!first) js += ',';
        first = false;
        js += m.key;
        js += ':';
        js += num;
    }
    js += "},atlas:";
    js += AtlasCacheJs();
    js += ",filters:";
    js += FiltersJs();
    js += "};";
    return js;
}

static std::string KeyText(int action) { return g_cfg.keys[action].vk ? Utf8(g_cfg.keys[action].display) : ""; }

static void ReplaceAll(std::string& s, const std::string& from, const std::string& to) {
    for (size_t p = s.find(from); p != std::string::npos; p = s.find(from, p + to.size())) s.replace(p, from.size(), to);
}

// radarplus.menu.json is generated from radarplus.menu.template so the option descriptions name
// the hotkeys actually set in RadarPlus.ini.
void WriteMenuDescriptor() {
    std::string tpl;
    if (!ReadWholeFile(g_modDir + L"radarplus.menu.template", tpl, 1u << 20) || tpl.empty()) return;
    std::string zin = KeyText(kZoomIn), zout = KeyText(kZoomOut), sup = KeyText(kSizeUp), sdown = KeyText(kSizeDown);
    // A paragraph of its own that starts with the key names, like the choices do (RadarPlus.js shows
    // them in bold).
    std::string zoom, size;
    if (!zin.empty() || !zout.empty()) {
        zoom = "\n\n";
        if (!zin.empty()) zoom += zin + " zooms in";
        if (!zin.empty() && !zout.empty()) zoom += " and ";
        if (!zout.empty()) zoom += zout + " zooms out";
        zoom += " while playing.";
    }
    if (!sup.empty() || !sdown.empty()) {
        size = "\n\n";
        if (!sup.empty()) size += sup + " makes it bigger";
        if (!sup.empty() && !sdown.empty()) size += " and " + sdown + " smaller";
        else if (!sdown.empty()) size += sdown + " makes it smaller";
        size += " while playing; hold a key to keep resizing.";
    }
    const char* tail = " Keys can be changed in RadarPlus.ini.";
    if (!zoom.empty()) zoom += tail;
    if (!size.empty()) size += tail;
    std::string out = tpl;
    ReplaceAll(out, "{ZOOM_KEYS}", JsonEscape(zoom));
    ReplaceAll(out, "{SIZE_KEYS}", JsonEscape(size));
    std::string current;
    std::wstring path = g_modDir + L"radarplus.menu.json";
    if (ReadWholeFile(path, current, 1u << 20) && current == out) return;
    Log("Menu descriptor %s", WriteWholeFile(path, out.data(), out.size()) ? "updated with hotkey names"
                                                                            : "could not be written");
}

static void Setup() {
    LoadConfig();
    LogInit();
    Log("RadarPlus " RADARPLUS_VERSION " folder=%s", Utf8(g_modDir).c_str());
    WriteMenuDescriptor();
    if (!g_cfg.enabled) {
        Log("Disabled by INI (Enabled=0)");
        return;
    }
    wchar_t name[64];
    swprintf_s(name, L"Local\\RadarPlus.Instance.%lu", GetCurrentProcessId());
    HANDLE instance = CreateMutexW(nullptr, TRUE, name);
    if (!instance || GetLastError() == ERROR_ALREADY_EXISTS) {
        Log("Another RadarPlus copy is already active in this process; this copy stays idle");
        return;
    }
    // Intentionally never closed: marks this process as served for its lifetime.

    g_gameBase = (uintptr_t)GetModuleHandleW(nullptr);
    g_mapFusion = GetModuleHandleW(L"minimap.dll") != nullptr;
    if (g_mapFusion)
        Log("WARNING: MapFusion (crmods\\MapFusion\\minimap.dll) is also installed. RadarPlus replaces it; "
            "remove the MapFusion folder. Until then RadarPlus uses MapFusion's position/zoom service and turns "
            "MapFusion's own overlay off.");

    wchar_t exe[MAX_PATH * 2];
    DWORD n = GetModuleFileNameW(nullptr, exe, (DWORD)(sizeof(exe) / sizeof(exe[0])));
    if (!n || n >= sizeof(exe) / sizeof(exe[0])) {
        Log("Cannot resolve the game executable path; not installing");
        return;
    }
    Image img;
    std::string build;
    if (!LoadPristineImage(exe, img, build)) {
        Log("Cannot read the game image; not installing");
        return;
    }
    Log("Game EXE build %s (%s)", build.c_str(),
        build == kKnownBuild ? "known build 25600401" : "other build; running on signatures");

    LoadAtlasCache();
    LoadFilters();
    std::string err;
    if (!InstallResourceHook(img, err)) {
        Log("Resource interception failed (%s); RadarPlus stays off for this game version", err.c_str());
        return;
    }
    if (!g_mapFusion) {
        if (FindSonarRings(img, err)) g_rings = true;
        else Log("Sonar range control off: %s", err.c_str());
        if (!g_cfg.liveMap) Log("Map overlay position hook off (LiveMap=0)");
        else if (InstallPositionObserver(img, err)) g_position = true;
        else Log("Map overlay off: %s", err.c_str());
    }
    if (InstallWorldObserver(img, err)) g_world = true;
    else Log("World markers off: %s", err.c_str());
    StartHotkeys();
    Log("Setup done: position=%d rings=%d world=%d mapfusion=%d dumpUI=%d", g_position, g_rings, g_world, g_mapFusion,
        g_cfg.dumpUI);
}

static DWORD WINAPI SetupThread(void*) {
    try {
        Setup();
    } catch (...) {
        Log("Initialization exception; no further setup attempted");
    }
    return 0;
}

}  // namespace rp

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(module);
        rp::g_self = module;
        wchar_t path[MAX_PATH * 2];
        DWORD n = GetModuleFileNameW(module, path, (DWORD)(sizeof(path) / sizeof(path[0])));
        std::wstring p(path, n);
        size_t slash = p.find_last_of(L"\\/");
        rp::g_modDir = slash == std::wstring::npos ? L".\\" : p.substr(0, slash + 1);
        HANDLE h = CreateThread(nullptr, 0, rp::SetupThread, nullptr, 0, nullptr);
        if (h) CloseHandle(h);
    }
    return TRUE;
}
