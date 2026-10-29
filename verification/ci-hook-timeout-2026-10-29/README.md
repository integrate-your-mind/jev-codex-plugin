# Hook timeout CI regression

The timeout/cooldown test fails because its 25 ms whole-hook deadline includes local filesystem work. The provider wait reserves only part of the remaining deadline for revision validation, outage persistence and receipts. The real-clock test sometimes exhausts that reserve before the cooldown is persisted, then the second invocation consults the deliberately nonresponsive fake provider again.

The failure reproduced in Linux local Actions and the first focused local run. An instrumented fake-provider run showed one provider call and abort before the first hook returned at 25 ms, no cooldown marker, then a second provider call and a 4,049 ms timeout. This does not establish a production failure at the normal five-second deadline.

Likelihood is 9/10 under the triggering tiny-budget and filesystem scheduling conditions, supported by both reproduced runs. Impact is 6/10 because the nondeterministic test blocks required local CI and source preservation. Product is 54.

The smallest repair is test-only. Represent provider entry with an explicit promise barrier and the timer with the existing Node test mock clock. Advance only until the provider's public AbortSignal is aborted, then let asynchronous cleanup finish without consuming more virtual deadline. Assert timeout advice, actual abort, a quiet next event and one provider call. Retain the separate real wall-clock boundary tests. No runtime or release package changes are required.

Owned disposable outputs are `source/jev-workflows/node_modules`, the ignored pinned declaration if downloaded, `source/jev-workflows/work` test state, and `.agent-work/ci-hook-timeout/repro-state`. Retain small verification receipts and the failing output here. Remove disposable outputs after verification.
