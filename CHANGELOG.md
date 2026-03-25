# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.0.0] – 2026-03-24

### Added
- WebRTC streaming support for Google Nest cameras via the Device Access API
- OAuth 2.0 authentication flow with automatic token refresh
- Audio visualizer (frequency spectrum bar equalizer) synced to camera audio
- Auto-reconnection logic with configurable `reconnectDelay`
- Stream session extension via `extendInterval` to keep streams alive beyond the 5-minute Nest timeout
- User presence integration (`USER_PRESENCE` notification) to suspend/resume the stream
- `exchange-nest-code.js` CLI tool for initial OAuth authorization code exchange
- Support for `hiddenOnStartup` to defer WebRTC connection until the module is shown
