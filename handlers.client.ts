import { type Channel, makeChan, makeChanStream, makeReadableStream, makeWebSocket } from "./channel.ts";
import type { ClientMessage, ClientState, ErrorMessage, RegisteredMessage, RequestDataEndMessage, RequestDataMessage, RequestStartMessage, ServerMessage, ServerMessageHandler, WSMessage } from "./messages.ts";
import { ensureChunked } from "./server.ts";

const registered: ServerMessageHandler<RegisteredMessage> = (state) => {
    state.live = true;
}

const error: ServerMessageHandler<ErrorMessage> = (state) => {
    state.live = false;
}

const onRequestStart: ServerMessageHandler<RequestStartMessage> = async (state, message) => {
    if (message.headers["upgrade"] === "websocket") {
        await handleWebSocket(message, state);
        return;
    }
    if (!message.hasBody) {
        doFetch(message, state, state.ch.out);
    } else {
        const bodyData = makeChan<Uint8Array>();
        state.requestBody[message.id] = bodyData;
        doFetch({ ...message, body: makeReadableStream(bodyData) }, state, state.ch.out).finally(() => {
            delete state.requestBody[message.id];
        });
    }
}

const onRequestData: ServerMessageHandler<RequestDataMessage> = async (state, message) => {
    const reqBody = state.requestBody[message.id];
    if (!reqBody) {
        console.info("[req-data] req not found", message.id);
        return;
    }
    await reqBody.send?.(ensureChunked(message.chunk));
}

const onRequestDataEnd: ServerMessageHandler<RequestDataEndMessage> = (state, message) => {
    const reqBody = state.requestBody[message.id];
    if (!reqBody) {
        return;
    }
    reqBody.close();
}


const onWsMessage: ServerMessageHandler<WSMessage> = async (state, message) => {
    await state.wsMessages?.[message.id]?.send?.(message.data);
}

const onWsClosed: ServerMessageHandler<RegisteredMessage> = (state, message) => {
    const messageChan = state.wsMessages[message.id];
    delete state.wsMessages[message.id];
    messageChan?.close();
}

// deno-lint-ignore no-explicit-any
const handlersByType: Record<ServerMessage["type"], ServerMessageHandler<any>> = {
    registered,
    error,
    "request-start": onRequestStart,
    "request-data": onRequestData,
    "request-end": onRequestDataEnd,
    "ws-closed": onWsClosed,
    "ws-message": onWsMessage,


}

async function handleWebSocket(message: RequestStartMessage, state: ClientState) {
    const ws = new WebSocket(new URL(message.url, state.localAddr));
    try {
        const wsCh = await makeWebSocket<ArrayBuffer, ArrayBuffer>(ws, false);
        await state.ch.out.send({
            type: "ws-opened",
            id: message.id,
        });
        state.wsMessages[message.id] = wsCh.out;
        (async () => {
            for await (const data of wsCh.in.recv()) {
                await state.ch.out.send({
                    type: "ws-message",
                    data,
                    id: message.id,
                });
            }
            await state.ch.out.send({
                type: "ws-closed",
                id: message.id,
            });
            delete state.wsMessages[message.id];
        })();
    } catch (err) {
        await state.ch.out.send({
            type: "data-end",
            error: err,
            id: message.id
        }).catch(console.error);
    }
}

// utilities

async function doFetch(request: RequestStartMessage & { body?: ReadableStream; }, state: ClientState, clientCh: Channel<ClientMessage>) {
    // Read from the stream
    const response = await fetch(new URL(request.url, state.localAddr), {
        ...state.client ? { client: state.client } : {},
        method: request.method,
        headers: request.headers,
        body: request.body,
    });
    await clientCh.send({
        type: "response-start",
        id: request.id,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
    })
    const body = response?.body;
    const stream = body ? makeChanStream(body) : undefined;
    for await (const chunk of stream?.recv() ?? []) {
        await clientCh.send({
            type: "data",
            id: request.id,
            chunk,
        });
    }
    await clientCh.send({
        type: "data-end",
        id: request.id,
    });

    return response;
}

export const handleServerMessage: ServerMessageHandler = async (state, message) => {
    //console.info(new Date(), `[client-live:${state.live}]`, message.type, "id" in message ? message.id : "");
    await handlersByType?.[message.type]?.(state, message);
}