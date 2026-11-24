# CS2 Radar Desktop — Windows packaging starter

This is a packaging/launcher layer for https://github.com/clauadv/cs2_webradar.
It does NOT contain the upstream source code, a compiled memory reader, or a ready installer.

## Windows build
1. Download upstream source into `upstream/` next to this README.
2. Install Visual Studio 2022 with C++ desktop workload, Node.js LTS, and Inno Setup 6. Configure vcpkg per upstream README.
3. Compile `upstream/usermode/cs2_webradar.sln` in Release x64, resolving upstream dependencies and any compatibility issues.
4. Run `npm ci` (or `npm install` if upstream has no lockfile) in `upstream/webapp`; then `npm run build`.
5. Place the compiled memory reader at `payload/usermode.exe`. Copy the complete required runtime/dependency files there as appropriate.
6. Copy the upstream `webapp` folder to `payload/webapp` (including installed node_modules). Adjust the WebSocket address and local frontend settings according to upstream configuration. Add Node.js runtime `node.exe` to `payload/runtime/node.exe` if you want to avoid a separate Node.js installation.
7. Build the installer by opening `installer.iss` in Inno Setup and clicking Compile.

## Operation
The installed launcher starts the bundled WebSocket server, starts the bundled usermode reader, and opens the local radar URL. Stop closes processes started by this launcher.

## Limitations
- The upstream memory offsets, patterns and schemas may break after CS2 updates.
- No anti-cheat compatibility or undetectability guarantee.
- The upstream server may have no authentication; bind it to loopback and do not expose the port publicly.
- Verify upstream license and bundled dependencies before redistribution.
- The launcher is a basic integration layer, not a verified working 1:1 port.
