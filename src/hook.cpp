// Inline hooks. Each hooked function starts with 15 position-independent bytes; they are replaced by
//     jmp [rip+0] ; dq hook ; nop
// and a trampoline runs the original 15 bytes, then jumps back to target+15.
#include "common.h"
#include <intrin.h>

namespace rp {

// The hooks go in during start-up, well before the game first calls these functions (they serve the
// HUD in play), so no thread is running the bytes being replaced. Functions start 16-byte aligned, and
// then the whole patch lands in one atomic 16-byte write all the same.
bool PatchCode(uint8_t* target, const uint8_t* patch, size_t n) {
    if (n > 16) return false;
    DWORD old = 0;
    if (!VirtualProtect(target, 16, PAGE_EXECUTE_READWRITE, &old)) return false;
    bool done;
    if (((uintptr_t)target & 15) == 0) {
        alignas(16) long long now[2], want[2];
        memcpy(now, target, 16);
        memcpy(want, now, 16);
        memcpy(want, patch, n);
        done = _InterlockedCompareExchange128((volatile long long*)target, want[1], want[0], now) != 0;
    } else {
        memcpy(target, patch, n);
        done = true;
    }
    FlushInstructionCache(GetCurrentProcess(), target, 16);
    DWORD tmp = 0;
    VirtualProtect(target, 16, old, &tmp);
    return done;
}

// *original is set before the jump is written: the hook can run the moment the patch lands.
bool InstallJmpHook(uint8_t* target, const uint8_t prologue[15], void* hook, void* volatile* original, const char* what,
                    std::string& err) {
    if (memcmp(target, prologue, 15) != 0) {
        err = std::string(what) + " is already patched in memory (another mod hooks it)";
        return false;
    }
    uint8_t* tramp = (uint8_t*)VirtualAlloc(nullptr, 64, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!tramp) {
        err = "trampoline allocation failed";
        return false;
    }
    // Trampoline: the 15 original bytes, then jmp [rip] -> target+15.
    memcpy(tramp, prologue, 15);
    const uint8_t jmp[6] = {0xFF, 0x25, 0, 0, 0, 0};
    memcpy(tramp + 15, jmp, 6);
    uint64_t back = (uint64_t)(target + 15);
    memcpy(tramp + 21, &back, 8);
    DWORD old = 0;
    VirtualProtect(tramp, 64, PAGE_EXECUTE_READ, &old);
    FlushInstructionCache(GetCurrentProcess(), tramp, 64);
    *original = tramp;
    MemoryBarrier();

    uint8_t patch[15];
    memcpy(patch, jmp, 6);
    uint64_t dest = (uint64_t)hook;
    memcpy(patch + 6, &dest, 8);
    patch[14] = 0x90;
    if (!PatchCode(target, patch, sizeof(patch))) {
        err = std::string("could not patch ") + what;
        return false;  // the hook never ran; the trampoline is simply left unused
    }
    return true;
}

}  // namespace rp
