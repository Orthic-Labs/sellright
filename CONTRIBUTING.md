# Contributing to SellRight

SellRight welcomes focused bug fixes, tests, documentation improvements, and generally useful commerce features.

## Before opening a change

- Keep generic commerce behavior in SellRight; do not add brand/customer-specific migration behavior to the core.
- Preserve the server-authoritative money model, store isolation, and fail-closed payment behavior.
- Prefer a small change with focused tests over a broad rewrite.
- Run the relevant package tests first, then `pnpm verify` for product changes.
- For dependency changes, also run `pnpm deps:audit` and `pnpm deps:check`.

## License

SellRight is **source-available under the Business Source License 1.1**, not OSI Open Source before a version's Change Date.

The repository license permits production use by organizations with no more than **25 Covered Persons**, using the exact definition and affiliate aggregation rules in [LICENSE](LICENSE). Organizations above that threshold need a separate commercial license. Each SellRight version converts to Apache-2.0 on its stated Change Date.

Unless a separate written agreement says otherwise, contributions submitted to this repository are provided under the same license terms that apply to SellRight and may be incorporated into future SellRight releases under those terms.

By submitting a contribution, you represent that you have the right to submit it and license it on that basis.

## Security reports

Please do not publish exploitable security issues in a public issue. Use GitHub's private vulnerability reporting flow when it is enabled for the repository, or contact the project maintainers privately.