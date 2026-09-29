#include "common.h"

namespace rp {

const Section* Image::SectionOf(uint32_t rva) const {
    for (const Section& s : secs)
        if (rva >= s.rva && rva < s.rva + s.size) return &s;
    return nullptr;
}

// Reads CONTROLResonant.exe from disk and lays the sections out by RVA. Working from the file
// (not live memory) means other mods' patches never hide the code we look for. The build is named by its
// PE header (link time stamp, image size and checksum), which differs for every build.
bool LoadPristineImage(const std::wstring& exePath, Image& img, std::string& buildId) {
    std::string file;
    if (!ReadWholeFile(exePath, file, 1u << 30)) return false;
    const uint8_t* d = (const uint8_t*)file.data();
    size_t n = file.size();
    if (n < 0x400 || d[0] != 'M' || d[1] != 'Z') return false;
    uint32_t pe = *(const uint32_t*)(d + 0x3c);
    if (pe + 0x108 > n || memcmp(d + pe, "PE\0\0", 4) != 0) return false;
    const IMAGE_FILE_HEADER* fh = (const IMAGE_FILE_HEADER*)(d + pe + 4);
    const IMAGE_OPTIONAL_HEADER64* oh = (const IMAGE_OPTIONAL_HEADER64*)(fh + 1);
    if (oh->Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) return false;
    img.prefBase = oh->ImageBase;
    img.sizeOfImage = oh->SizeOfImage;
    if (img.sizeOfImage < 0x1000 || img.sizeOfImage > (1u << 30)) return false;
    img.mem.assign(img.sizeOfImage, 0);
    const IMAGE_SECTION_HEADER* sh = (const IMAGE_SECTION_HEADER*)((const uint8_t*)oh + fh->SizeOfOptionalHeader);
    if ((const uint8_t*)(sh + fh->NumberOfSections) > d + n) return false;
    for (int i = 0; i < fh->NumberOfSections; ++i) {
        Section s{};
        memcpy(s.name, sh[i].Name, 8);
        s.rva = sh[i].VirtualAddress;
        s.size = std::max<uint32_t>(sh[i].Misc.VirtualSize, sh[i].SizeOfRawData);
        s.exec = (sh[i].Characteristics & IMAGE_SCN_MEM_EXECUTE) != 0;
        s.write = (sh[i].Characteristics & IMAGE_SCN_MEM_WRITE) != 0;
        if ((uint64_t)s.rva + s.size > img.sizeOfImage) s.size = img.sizeOfImage - std::min(s.rva, img.sizeOfImage);
        uint32_t raw = std::min<uint32_t>(sh[i].SizeOfRawData, s.size);
        if (sh[i].PointerToRawData + (uint64_t)raw <= n && raw) memcpy(&img.mem[s.rva], d + sh[i].PointerToRawData, raw);
        img.secs.push_back(s);
    }
    char id[40];
    sprintf_s(id, "%08x-%08x-%08x", (unsigned)fh->TimeDateStamp, (unsigned)oh->SizeOfImage, (unsigned)oh->CheckSum);
    buildId = id;
    return true;
}

bool Pattern::Parse(const char* text) {
    bytes.clear();
    const char* p = text;
    while (*p) {
        while (*p == ' ') ++p;
        if (!*p) break;
        if (p[0] == '?') {
            bytes.push_back(-1);
            p += (p[1] == '?') ? 2 : 1;
            continue;
        }
        auto hex = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        int hi = hex(p[0]), lo = hex(p[1]);
        if (hi < 0 || lo < 0) return false;
        bytes.push_back(hi * 16 + lo);
        p += 2;
    }
    return !bytes.empty() && bytes[0] >= 0;
}

bool MatchAt(const Image& img, uint32_t rva, const Pattern& p) {
    if (!img.Contains(rva, (uint32_t)p.bytes.size())) return false;
    const uint8_t* m = &img.mem[rva];
    for (size_t i = 0; i < p.bytes.size(); ++i)
        if (p.bytes[i] >= 0 && m[i] != (uint8_t)p.bytes[i]) return false;
    return true;
}

std::vector<uint32_t> FindPattern(const Image& img, const Pattern& p, size_t max) {
    std::vector<uint32_t> out;
    if (p.bytes.empty()) return out;
    const uint8_t first = (uint8_t)p.bytes[0];
    for (const Section& s : img.secs) {
        if (!s.exec || s.size < p.bytes.size()) continue;
        const uint8_t* base = &img.mem[s.rva];
        size_t len = s.size - p.bytes.size() + 1;
        size_t i = 0;
        while (i < len) {
            const void* hit = memchr(base + i, first, len - i);
            if (!hit) break;
            i = (const uint8_t*)hit - base;
            if (MatchAt(img, s.rva + (uint32_t)i, p)) {
                out.push_back(s.rva + (uint32_t)i);
                if (out.size() >= max) return out;
            }
            ++i;
        }
    }
    return out;
}

uint32_t FindUnique(const Image& img, const char* what, const char* pattern, std::string& err) {
    Pattern p;
    if (!p.Parse(pattern)) {
        err = std::string(what) + ": bad pattern";
        return 0;
    }
    std::vector<uint32_t> hits = FindPattern(img, p, 2);
    if (hits.size() == 1) return hits[0];
    err = std::string(what) + (hits.empty() ? ": signature not found" : ": signature matched more than once");
    return 0;
}

}  // namespace rp
