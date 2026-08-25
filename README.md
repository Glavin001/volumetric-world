# Volumetric World

An interactive Three.js vertical slice for persistent, world-space dust and smoke. The demo models cold aerosol as anisotropic volume packets with fixed-rate transport, density loading, wind entrainment, ground interaction, and off-screen rigid-body wakes. A custom volumetric shader supplies turbulent extinction and directional forward scattering.

## Run

```bash
npm install
npm run dev
```

Drag to orbit, scroll to dolly, and use **Trigger collapse** to inject another mass-conserving dust event.

## Architecture

- `VolumePacketSimulation` is the low-frequency persistent far-field representation.
- `MediumEmissionEvent` and `DynamicBodySample` are timestamp-friendly public contracts.
- The Three.js renderer converts packets to world-space ellipsoids, rendered as turbulent participating media.
- The fixed-rate simulation is intentionally decoupled from the 60 Hz visual loop.

This vertical slice establishes the packet tier and interaction contract. Dense WebGPU MAC-grid islands and the grid/packet handoff can be added behind the same simulation interface.
