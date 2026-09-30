# RadarPlus - Minimap and World Markers

A mod for CONTROL Resonant: a bigger, squarer, farther-seeing sonar with the area map drawn underneath, and its icons shown in the world.

Download and install instructions are on Nexus Mods (search for RadarPlus in the CONTROL Resonant section). This repository is the full source.

## Features

- Radar size, shape (Circle, Square, Rounded) and range, in the game's own style.
- Lock rotation: north stays at the top.
- Map overlay: the area map under the radar, following your position and camera.
- World markers: the radar's icons over their objects in the world, with distances.
- Choose which icons the radar, the world markers and the main map show.
- Hotkeys to zoom and resize; all settings in game under Options > MODS > RadarPlus.

## Requirements (to play)

- [f2g DLL Mod Loader (crloader)](https://www.nexusmods.com/controlresonant/mods/9)
- [Mod Settings Menu](https://www.nexusmods.com/controlresonant/mods/35)

## Building

Requires Windows and the Visual Studio 2022 Build Tools (C++ workload). Run `build.bat`; it builds `build\radarplus.dll`. To install your build, put it in `crmods\RadarPlus` in the game folder together with the files in `mod\`.

## How it works

`radarplus.dll` is loaded by [f2g DLL Mod Loader (crloader)](https://www.nexusmods.com/controlresonant/mods/9) from `crmods\RadarPlus`. At start-up it reads the game executable from disk, finds the game functions it needs by byte signatures, and installs a few inline hooks inside the game process only. `RadarPlus.js` is appended to the game's UI bundle when the game loads it, and talks to the DLL through a `coui://` endpoint. There is no network code; the mod writes only its own log and settings files in its own folder.

## Antivirus false positives

Some antivirus tools, including Windows Defender (`Trojan:Win32/Wacatac.B!ml` or `C!ml`), may flag the DLL because it is unsigned and hooks into the game. This is a false positive and has been reported to Microsoft. The full source is here, so you can check it or build the DLL yourself with `build.bat`.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

## Credits

- **fame2gin** for f2g DLL Mod Loader.
- **kkyleeb21** for Mod Settings Menu, and for MapFusion, which showed how to add scripts to the game's UI. RadarPlus's map overlay builds on the game-code research MapFusion did (signatures and map-scale constants); it contains none of MapFusion's files or code.
- **hhkbble** for the world marker latency fix ([#1](https://github.com/Reynbow/RadarPlus/pull/1)).

## License

MIT, see [LICENSE](LICENSE). CONTROL Resonant is a game by Remedy Entertainment; this project isn't affiliated with or endorsed by Remedy.
