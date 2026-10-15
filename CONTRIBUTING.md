# Contributing to SellRight

SellRight welcomes focused bug fixes, tests, documentation improvements, and generally useful commerce features.

## Before opening a change

- Keep generic commerce behavior in SellRight; do not add brand/customer-specific migration behavior to the core.
- Preserve the server-authoritative money model, store isolation, and fail-closed payment behavior.
- Prefer a small change with focused tests over a broad rewrite.
- Run the relevant package tests first, then `pnpm verify` for product changes.
- For dependency changes, also run `pnpm deps:audit` and `pnpm deps:check`.

## License

SellRight is licensed under the **Apache License 2.0** (see [LICENSE](LICENSE)).

Unless you state otherwise, any contribution intentionally submitted for inclusion in SellRight is licensed under the Apache License 2.0, as described in section 5 of the license, without additional terms or conditions.

By submitting a contribution, you represent that you have the right to submit it under that license.

## Security reports

Please do not publish exploitable security issues in a public issue. Use GitHub's private vulnerability reporting flow when it is enabled for the repository, or contact the project maintainers privately.