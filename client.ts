import { type Channel, makeWebSocket } from "./channel.ts";
import { handleServerMessage } from "./handlers.client.ts";
import type { ClientMessage, ClientState, ServerMessage } from "./messages.ts";

export interface ConnectOptions {
    token: string;
    domain: string;
    server: string;
    localAddr: string;
}

export interface Connected {
    closed: Promise<void>;
    registered: Promise<void>;
}
export const connect = async (opts: ConnectOptions): Promise<Connected> => {
    const closed = Promise.withResolvers<void>();
    const registered = Promise.withResolvers<void>();
    const client = typeof Deno.createHttpClient === "function" ? Deno.createHttpClient({
        allowHost: true,
        proxy: {
            url: opts.localAddr,
        }
    }) : undefined;

    const socket = new WebSocket(`${opts.server}/_connect`);
    const ch = await makeWebSocket<ClientMessage, ServerMessage>(socket);
    await ch.out.send({
        id: crypto.randomUUID(),
        type: "register",
        apiKey: opts.token,
        domain: opts.domain,
    });
    const requestBody: Record<string, Channel<Uint8Array>> = {};
    const wsMessages: Record<string, Channel<ArrayBuffer>> = {};

    (async () => {
        const state: ClientState = {
            client,
            localAddr: opts.localAddr,
            live: false,
            requestBody,
            wsMessages,
            ch,
        }
        for await (const message of ch.in.recv()) {
            try {
                await handleServerMessage(state, message);
                if (state.live) {
                    registered.resolve();
                }
            } catch (err) {
                console.error(new Date(), "error handling message", err);
                break;
            }
        }
        closed.resolve();
    })()
    return { closed: closed.promise, registered: registered.promise };
}

