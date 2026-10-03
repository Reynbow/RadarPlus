// RadarPlus - radar (sonar) size, shape, zoom and map overlay for CONTROL Resonant.
#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <stdint.h>
#include <string>
#include <vector>

#include "version.h"

namespace rp {

// ---- globals (dllmain.cpp) ----
extern HMODULE g_self;
extern std::wstring g_modDir;   // folder holding radarplus.dll, trailing backslash
extern uintptr_t g_gameBase;    // live base of CONTROLResonant.exe

// ---- logging (util.cpp) ----
void LogInit();
void Log(const char* fmt, ...);

// ---- small helpers (util.cpp) ----
std::string Utf8(const std::wstring& w);
std::wstring Wide(const std::string& s);
bool ReadWholeFile(const std::wstring& path, std::string& out, size_t maxBytes);
bool WriteWholeFile(const std::wstring& path, const void* data, size_t size);  // temp file + replace
bool EnsureDirectoryFor(const std::wstring& filePath);
std::string UrlDecode(const char* s, size_t n);
// Value of key in a query string ("a=1&b=2"), URL-decoded. Returns false when absent.
bool QueryParam(const char* query, const char* key, std::string& out);
std::string JsonEscape(const std::string& s);
bool IsSafeJsonBlob(const std::string& s);  // conservative charset check for data we embed in JS

// ---- configuration (config.cpp) ----
enum KeyAction { kZoomIn = 0, kZoomOut, kSizeUp, kSizeDown, kKeyCount };
struct Config {
    bool enabled = true;
    bool liveMap = true;       // hook the player position (required for the map overlay)
    bool diagnostics = false;  // extra log lines + JS diagnostics
    bool dumpUI = false;       // write HUD html/css/js into uidump\ (development aid)
    struct Key {
        std::wstring name;     // as written in the INI
        std::wstring display;  // for the menu text, e.g. "Page Up"
        int vk = 0;            // virtual-key code, 0 = off
    } keys[kKeyCount];
    // Saved menu values from ModMenuConfig\radarplus.ini (written by CRModMenu). -1 = not saved yet.
    struct MenuValue { const char* key; double value; };
    std::vector<MenuValue> menu;
};
extern Config g_cfg;
void LoadConfig();
int ParseKeyName(const std::wstring& name);
std::wstring KeyDisplayName(int vk);

// ---- pristine game image (image.cpp) ----
struct Section {
    char name[9];
    uint32_t rva, size;
    bool exec, write;
};
struct Image {
    std::vector<uint8_t> mem;  // sections copied to their RVAs
    uint64_t prefBase = 0;
    uint32_t sizeOfImage = 0;
    std::vector<Section> secs;
    const Section* SectionOf(uint32_t rva) const;
    bool Contains(uint32_t rva, uint32_t n) const { return (uint64_t)rva + n <= mem.size(); }
    uint32_t U32(uint32_t rva) const { uint32_t v; memcpy(&v, &mem[rva], 4); return v; }
    int32_t I32(uint32_t rva) const { int32_t v; memcpy(&v, &mem[rva], 4); return v; }
    uint64_t U64(uint32_t rva) const { uint64_t v; memcpy(&v, &mem[rva], 8); return v; }
    float F32(uint32_t rva) const { float v; memcpy(&v, &mem[rva], 4); return v; }
};
bool LoadPristineImage(const std::wstring& exePath, Image& img, std::string& buildId);
struct Pattern {
    std::vector<int> bytes;  // -1 = wildcard
    bool Parse(const char* text);
};
// All matches of pattern in executable sections (up to max).
std::vector<uint32_t> FindPattern(const Image& img, const Pattern& p, size_t max = 16);
bool MatchAt(const Image& img, uint32_t rva, const Pattern& p);
// Unique match or 0 with an error message.
uint32_t FindUnique(const Image& img, const char* what, const char* pattern, std::string& err);

// ---- inline hooks (hook.cpp) ----
bool PatchCode(uint8_t* target, const uint8_t* patch, size_t n);
// Replaces the first 15 (position independent) bytes of target with a jump to hook; *original gets a
// trampoline that runs them and continues at target+15.
bool InstallJmpHook(uint8_t* target, const uint8_t prologue[15], void* hook, void* volatile* original, const char* what,
                    std::string& err);

// ---- UI resource interception (resources.cpp) ----
bool FindResourceSlot(const Image& img, uint32_t& slotRva, std::string& err);
bool InstallResourceHook(const Image& img, std::string& err);
bool BuildInjectedScript(const std::vector<uint8_t>& original, std::string& out);
std::string BuildConfigJs();
void WriteMenuDescriptor();  // dllmain.cpp: radarplus.menu.json from the template + hotkey names

// ---- player position observer (position.cpp) ----
struct PositionTargets { uint32_t update, district, viewport, owner; };
bool FindPositionTargets(const Image& img, PositionTargets& out, std::string& err);
bool InstallPositionObserver(const Image& img, std::string& err);
bool PositionObserverInstalled();
std::string PositionJson();
bool PlayerWorldPosition(float out[3]);  // latest sample, if fresh

// ---- world markers: sonar entries and the HUD camera (world.cpp) ----
struct WorldTargets { uint32_t facts, slotMap, camera, matrix, lens[3]; };
bool FindWorldTargets(const Image& img, WorldTargets& out, std::string& err);
bool InstallWorldObserver(const Image& img, std::string& err);
bool WorldObserverInstalled();
std::string WorldJson();

// ---- sonar range / zoom (sonar.cpp) ----
bool FindSonarRings(const Image& img, std::string& err);
bool SonarRingsAvailable();
bool ApplyZoom(int percent);  // 25..1000 % of the game's rings, applies to all four
int CurrentZoom();
uint32_t ZoomSerial();        // bumps on every applied change
void RingValues(float out[4]);  // explore1, explore2, combat1, combat2
std::string ZoomJson(bool ok);

// ---- hotkeys (hotkeys.cpp) ----
// The DLL only counts presses; the script turns them into menu changes so CRModMenu saves them.
void StartHotkeys();
void KeyCounts(uint32_t out[kKeyCount]);

// ---- controller (pad.cpp) and Show on press ----
// The script names a controller button (Mod Settings Menu key code 256-271) and a keyboard key (virtual-key code),
// 0 for none; the DLL counts presses of either while the game has focus. Both are read-only, so they keep their game
// actions. The script decides what a press shows.
void StartPad();
bool SetRevealKeys(int padCode, int vk);  // false for codes Mod Settings Menu wouldn't store
int RevealPadCode();
int RevealVk();
void CountRevealPress();
uint32_t RevealPresses();
double MenuSetting(const char* key, double fallback);  // a saved Mod Settings Menu value, as read at start
bool ParseSonyReport(uint16_t pid, size_t reportLength, const uint8_t* d, size_t n, uint32_t& buttons);  // tests

// ---- atlas cache (atlas.cpp) ----
void LoadAtlasCache();
bool StoreAtlas(uint32_t district, const std::string& json);
std::string AtlasCacheJs();  // {"12":{...},...}

// filters.cpp: the icons each "Custom" setting hides, kept in filters.ini
bool IsFilterList(const std::string& s);
void LoadFilters();
bool StoreFilters(const std::string& radar, const std::string& world, const std::string& map, const std::string& seen);
std::string FiltersJs();  // {r:"...",w:"...",m:"...",s:"..."}

}  // namespace rp
