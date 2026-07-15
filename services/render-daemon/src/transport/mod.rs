//! Transport layer: the daemon runs a local WebSocket **server** and
//! GrapiX (Electron/Fastify) connects as a client.
//!
//! Server-side was chosen over client-side because the daemon is the
//! long-running service: controllers (the editor today, a sequencer later)
//! come and go and reconnect, while the render output must survive their
//! disconnects. The existing GrapiX architecture has no message broker to
//! invert that relationship.

pub mod websocket;
