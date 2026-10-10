`consumer.pnpm-lock.yaml` pins the packed-artifact consumer install used by `packed.test.ts`
(transitive dependencies and the two `file:` tarballs). Regenerate after changing the consumer
dependency list or after an engine/plugin change that alters the tarball integrity:

    SDK_REGEN_CONSUMER_LOCK=1 DATABASE_URL=postgres://sellright@127.0.0.1:5433/defork_sdk_test pnpm test:sdk-packed
