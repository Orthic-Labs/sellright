# Changelog — SellRight Admin iOS

Notable changes to the native iOS admin app only. The SellRight API, storefront,
and browser admin use the repository-root changelog.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every iOS feature, fix, or security change must update this file in the same
push.

## [Unreleased]

### Changed

- The app icon catalog now ships the complete RGB iOS icon set generated from
  the selected SellRight mark.

## 2026-07-17

### Added

- The first native SellRight Admin app: mobile order operations backed by the
  production admin API (`2a7f53c`).
- Push notifications and Dynamic Island Live Activities for order events, plus
  the four-theme system (`bfac16a`).

### Fixed

- Per-line refund construction now receives the order-line identifiers exposed
  by the API (`7be6ad6`).
