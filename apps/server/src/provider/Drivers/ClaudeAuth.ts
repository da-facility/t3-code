import { type ProviderInstanceId, ProviderSetupError } from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

/**
 * Fork: "Sign in with Claude" in Settings -> Providers. Runs `claude auth login`
 * on the host in a PTY and streams it to the panel's terminal. The browser
 * link it prints opens anywhere; the code pasted back is typed into the PTY.
 */

const LOGIN_METHOD_ID = "claude-login";

export const makeClaudeAuth = Effect.fn("makeClaudeAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly configDir: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Drops cached account probes and re-reads the provider after a credential change. */
  readonly refresh: Effect.Effect<void>;
}) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });

  const runClaude = Effect.fnUntraced(function* (
    args: ReadonlyArray<string>,
    context: ProviderAuthFlow.ProviderAuthFlowContext | null,
  ) {
    if (Option.isNone(pty)) {
      return yield* failure("start", "Interactive sign-in is unavailable on this environment.");
    }
    const exited = yield* Deferred.make<number>();
    const output = yield* Queue.sliding<string>(64);
    const process = yield* pty.value
      .spawn({
        shell: options.binaryPath,
        args: [...args],
        cwd: options.cwd,
        cols: 100,
        rows: 30,
        env: { ...options.env, BROWSER: "none" },
      })
      .pipe(Effect.mapError((cause) => failure("start", "Could not start the Claude CLI.", cause)));
    const detachData = process.onData((data) => {
      Queue.offerUnsafe(output, data.slice(-16_384));
    });
    const detachExit = process.onExit(({ exitCode }) => {
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
        try {
          process.kill();
        } catch {}
      }),
    );
    if (context !== null) {
      let transcript = "";
      let outputOffset = 0;
      const update = () =>
        context.setInteraction(
          { type: "terminal", id: "terminal", output: transcript, outputOffset },
          (response) =>
            response.type === "terminal"
              ? Effect.try({
                  try: () => {
                    if (response.size) process.resize(response.size.cols, response.size.rows);
                    if (response.data) process.write(response.data);
                  },
                  catch: () => failure("respond", "The Claude sign-in terminal has closed."),
                })
              : Effect.void,
        );
      yield* update();
      yield* Queue.take(output).pipe(
        Effect.flatMap((data) => {
          outputOffset += data.length;
          transcript = (transcript + data).slice(-16_384);
          return update();
        }),
        Effect.forever,
        Effect.forkScoped,
      );
    }
    return yield* Deferred.await(exited);
  });

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: `claude:home:${options.configDir}` },
    methods: Effect.succeed([
      {
        id: LOGIN_METHOD_ID,
        name: "Sign in with Claude",
        description:
          "Opens a sign-in link. Finish in any browser, then paste the code back into the terminal.",
        type: "terminal" as const,
      },
    ]),
    defaultMethodId: LOGIN_METHOD_ID,
    timeoutMs: 15 * 60_000,
    authenticate: Effect.fn("ClaudeAuth.authenticate")(function* (
      methodId: string,
      context: ProviderAuthFlow.ProviderAuthFlowContext,
    ) {
      if (methodId !== LOGIN_METHOD_ID) {
        return yield* failure("start", "Unknown Claude sign-in method.");
      }
      const code = yield* runClaude(["auth", "login"], context);
      if (code !== 0) {
        return yield* failure("start", "Claude sign-in did not finish. Start again.");
      }
      yield* context.verifying;
      yield* options.refresh;
    }),
    logout: Effect.scoped(runClaude(["auth", "logout"], null)).pipe(
      Effect.flatMap((code) =>
        code === 0 ? options.refresh : Effect.fail(failure("logout", "Claude sign-out failed.")),
      ),
    ),
  });
});
