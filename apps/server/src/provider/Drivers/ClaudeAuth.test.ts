import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { makeClaudeAuth } from "./ClaudeAuth.ts";

const instanceId = ProviderInstanceId.make("claude");

const makeHarness = Effect.fn("test.makeHarness")(function* () {
  const spawns: PtyAdapter.PtySpawnInput[] = [];
  const written: string[] = [];
  let refreshes = 0;
  let data: ((data: string) => void) | undefined;
  let exit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
  const controller = yield* makeClaudeAuth({
    instanceId,
    binaryPath: "/home/user/.local/bin/claude",
    configDir: "/home/user/.claude",
    cwd: "/home/user/.t3/userdata",
    env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/home/user/.claude" },
    refresh: Effect.sync(() => {
      refreshes++;
    }),
  }).pipe(
    Effect.provideService(PtyAdapter.PtyAdapter, {
      spawn: (input) =>
        Effect.sync(() => {
          spawns.push(input);
          // `claude auth logout` exits on its own.
          if (input.args?.[1] === "logout")
            queueMicrotask(() => exit?.({ exitCode: 0, signal: null }));
          return {
            pid: 1,
            write: (value) => {
              written.push(value);
            },
            resize: () => {},
            kill: () => {},
            onData: (callback) => {
              data = callback;
              return () => (data = undefined);
            },
            onExit: (callback) => {
              exit = callback;
              return () => (exit = undefined);
            },
          };
        }),
    }),
  );
  const state = (predicate: (value: ProviderAuthState) => boolean) =>
    controller
      .subscribe("owner")
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
  yield* state((value) => (value.methods?.length ?? 0) > 0);
  return {
    controller,
    state,
    spawns,
    written,
    refreshes: () => refreshes,
    data: (value: string) => data?.(value),
    exit: (exitCode: number) => exit?.({ exitCode, signal: null }),
  };
});

it.effect("runs claude auth login in a terminal and accepts the pasted code", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const flow = yield* h.controller.start("owner");
    yield* h.state((value) => value.interaction?.type === "terminal");
    assert.deepEqual(h.spawns[0]?.args, ["auth", "login"]);
    assert.strictEqual(h.spawns[0]?.shell, "/home/user/.local/bin/claude");
    assert.strictEqual(h.spawns[0]?.env.CLAUDE_CONFIG_DIR, "/home/user/.claude");

    h.data("Open https://claude.ai/oauth/authorize?code=true and paste the code: ");
    const shown = yield* h.state(
      (value) =>
        value.interaction?.type === "terminal" &&
        value.interaction.output.includes("https://claude.ai/oauth/authorize"),
    );
    assert.strictEqual(shown.phase, "waiting");

    yield* h.controller.respond!("owner", {
      instanceId,
      flowId: flow.flowId!,
      interactionId: "terminal",
      response: { type: "terminal", data: "CODE123\r" },
    });
    assert.deepEqual(h.written, ["CODE123\r"]);

    h.exit(0);
    yield* h.state((value) => value.phase === "succeeded");
    assert.strictEqual(h.refreshes(), 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails the flow when the login command exits with an error", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.controller.start("owner");
    yield* h.state((value) => value.interaction?.type === "terminal");
    h.exit(1);
    const failed = yield* h.state((value) => value.phase === "failed");
    assert.include(failed.message ?? "", "did not finish");
    assert.strictEqual(h.refreshes(), 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("signs out with claude auth logout", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.controller.logout(Effect.void);
    assert.deepEqual(h.spawns.at(-1)?.args, ["auth", "logout"]);
    assert.strictEqual(h.refreshes(), 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
