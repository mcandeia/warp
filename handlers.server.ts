import { makeReadableStream, makeWebSocket } from "./channel.ts";
import type { ClientMessage, ClientMessageHandler, DataEndMessage, DataMessage, RegisterMessage, ResponseStartMessage, WSConnectionClosed, WSMessage } from "./messages.ts";
import { ensureChunked } from "./server.ts";

const NULL_BODIES = [101, 204, 205, 304]

const onResponseStart: ClientMessageHandler<ResponseStartMessage> = (state, message) => {
    const request = state.ongoingRequests[message.id];
    if (!request) {
        console.error(
            new Date(),
            "Didn't find response object, probably dead?",
        );
        return;
    }
    const headers = new Headers();
    Object.entries(message.headers).forEach(([key, value]: [string, string]) => {
        headers.set(key, value);
    });
    const shouldBeNullBody = NULL_BODIES.includes(message.statusCode);
    const stream = !shouldBeNullBody && request.dataChan ? makeReadableStream(request.dataChan) : undefined;
    const resp = new Response(stream, {
        status: message.statusCode,
        statusText: message.statusMessage,
        headers,
    });

    request.requestObject?.signal?.addEventListener?.("abort", () => {
        if (message.id in state.ongoingRequests) {
            delete state.ongoingRequests[message.id];
            request.responseObject.reject(new DOMException("Connection closed", "AbortError"));
        }
    });
    request.responseObject.resolve(resp);
}

const data: ClientMessageHandler<DataMessage> = async (state, message) => {
    const request = state.ongoingRequests[message.id];
    if (!request) {
        console.error(
            new Date(),
            "Didn't find response object, unable to send data",
            message.id,
        );
        return;
    }
    try {
        await request.dataChan?.send(ensureChunked(message.chunk));
    } catch (_err) {
        console.log("Request was aborted", _err);
    }
}

const onDataEnd: ClientMessageHandler<DataEndMessage> = (state, message) => {
    const request = state.ongoingRequests[message.id];
    if (!request) {
        console.error(
            new Date(),
            "Didn't find response object, unable to send data",
        );
        return;
    }
    if (message.error) {
        request.responseObject.reject(new DOMException("Connection closed", JSON.stringify(message.error)));
        return;
    }
    try {
        // Call ready again to ensure that all chunks are written
        // before closing the writer.
        request.dataChan?.close?.();
    } catch (_err) {
        console.log(_err);
    }
}

const onWsClosed: ClientMessageHandler<WSConnectionClosed> = (state, message) => {
    delete state.ongoingRequests[message.id];
}

const onWsMessage: ClientMessageHandler<WSMessage> = async (state, message) => {
    await state.ongoingRequests?.[message.id]?.socketChan?.send(message.data)
}

const onWsOpened: ClientMessageHandler<DataEndMessage> = async (state, message) => {
    const request = state.ongoingRequests[message.id];
    if (!request) {
        return;
    }
    try {
        const { socket, response } = Deno.upgradeWebSocket(request.requestObject);
        request.responseObject.resolve(response);
        const socketChan = await makeWebSocket<ArrayBuffer, ArrayBuffer>(socket, false);
        request.socketChan = socketChan.out;
        (async () => {
            for await (const msg of socketChan.in.recv()) {
                await state.ch.out.send({ type: "ws-message", id: message.id, data: msg });
            }
            await state.ch.out.send({ type: "ws-closed", id: message.id })
            socket.close();
        })()
    }
    catch (err) {
        console.error(new Date(), "Error upgrading websocket", err);
        delete state.ongoingRequests[message.id];
    }
}
const register: ClientMessageHandler<RegisterMessage> = async (state, message) => {
    if (state.apiKeys.includes(message.apiKey)) {
        state.domainsToConnections[message.domain] = state.ch;
        await state.ch.out.send({ type: "registered", domain: message.domain, id: message.id })
    } else {
        console.error(
            new Date(),
            "Given API key is wrong/not recognised, stopping connection",
            message,
        );
        await state.ch.out.send({ type: "error", message: "Invalid API key" })
        state.socket.close();
    }
}


// deno-lint-ignore no-explicit-any
const handlersByType: Record<ClientMessage["type"], ClientMessageHandler<any>> = {
    "response-start": onResponseStart,
    data,
    "data-end": onDataEnd,
    "ws-closed": onWsClosed,
    "ws-message": onWsMessage,
    "ws-opened": onWsOpened,
    register,
}
export const handleClientMessage: ClientMessageHandler = async (state, message) => {
    console.info(new Date(), `[server]`, message.type, "id" in message ? message.id : "");
    await handlersByType?.[message.type]?.(state, message)?.catch?.(err => {
        console.error("unexpected error happening when handling message", message, err);
        delete state.ongoingRequests[message.id];
    });
}