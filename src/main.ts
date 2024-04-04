import {
	type DurableObjectNamespace,
	type DurableObjectState,
} from "@cloudflare/workers-types";
import HTML from "./home.html";

export interface Env {
	Rooms: DurableObjectNamespace;
}

// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
// try/catch and return errors to the client. You probably wouldn't want to use this in production
// code but it is convenient when debugging and iterating.

async function handleErrors(request: Request, func: () => Promise<Response>) {
	try {
		return await func();
	} catch (err) {
		if (
			request.headers.get("Upgrade") == "websocket" &&
			err instanceof Error
		) {
			let pair: WebSocketPair = new WebSocketPair();
			const [client, server] = Object.values(pair);
			pair[1].accept();
			pair[1].send(JSON.stringify({ error: err.stack }));
			pair[1].close(1011, "Uncaught exception during session setup");

			const response: ResponseInit = {
				status: 101,
				webSocket: client as CloudflareWebsocket,
			};

			return new Response(null, response);
		} else {
			if (err instanceof Error) {
				return new Response(err.stack, { status: 500 });
			}
		}
	}
}

// In modules-syntax workers, we use `export default` to export our script's main event handlers.
// Here, we export one handler, `fetch`, for receiving HTTP requests. In pre-modules workers, the
// fetch handler was registered using `addEventHandler("fetch", event => { ... })`; this is just
// new syntax for essentially the same thing.
//
// `fetch` isn't the only handler. If your worker runs on a Cron schedule, it will receive calls
// to a handler named `scheduled`, which should be exported here in a similar way. We will be
// adding other handlers for other types of events over time.
export default {
	async fetch(request: Request, env: Env) {
		return await handleErrors(request, async () => {
			// We have received an HTTP request! Parse the URL and route the request.

			let url = new URL(request.url);
			let path = url.pathname.slice(1).split("/");

			if (!path[0]) {
				// Serve our HTML at the root path.
				return new Response(HTML, {
					headers: { "Content-Type": "text/html;charset=UTF-8" },
				});
			}

			switch (path[0]) {
				case "api":
					// This is a request for `/api/...`, call the API handler.
					return handleApiRequest(path.slice(1), request, env);

				default:
					return new Response("Not found", { status: 404 });
			}
		});
	},
};

async function handleApiRequest(path: string[], request: Request, env: Env) {
	// We've received at API request. Route the request based on the path.

	switch (path[0]) {
		case "room": {
			if (!path[1]) {
				// The request is for just "/api/room", with no ID.
				if (request.method == "POST") {
					let id = env.Rooms.newUniqueId();
					return new Response(id.toString(), {
						headers: { "Access-Control-Allow-Origin": "*" },
					});
				} else {
					// If we wanted to support returning a list of public rooms, this might be a place to do
					// it.

					return new Response("Method not allowed", { status: 405 });
				}
			}

			// OK, the request is for `/api/room/<name>/...`. It's time to route to the Durable Object
			// for the specific room.
			let name = path[1];

			let id;
			if (name.match(/^[0-9a-f]{64}$/)) {
				id = env.Rooms.idFromString(name);
			} else if (name.length <= 32) {
				id = env.Rooms.idFromName(name);
			} else {
				return new Response("Name too long", { status: 404 });
			}

			let roomObject = env.Rooms.get(id);

			let newUrl = new URL(request.url);
			newUrl.pathname = "/" + path.slice(2).join("/");

			//@ts-expect-error
			return roomObject.fetch(newUrl, request) as Response;
		}

		default:
			return new Response("Not found", { status: 404 });
	}
}

// Durable Object
export class Rooms {
	state: DurableObjectState;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
	}

	// Handle HTTP requests from clients.
	async fetch(request: Request): Promise<Response> {
		if (request.url.endsWith("/websocket")) {
			const upgradeHeader = request.headers.get("Upgrade");
			if (!upgradeHeader || upgradeHeader !== "websocket") {
				return new Response(
					"Durable Object expected Upgrade: websocket",
					{ status: 426 }
				);
			}

			// Creates two ends of a WebSocket connection.
			const webSocketPair = new WebSocketPair();
			const [client, server] = Object.values(webSocketPair);

			this.state.acceptWebSocket(server);

			const response: ResponseInit = {
				status: 101,
				webSocket: client as CloudflareWebsocket,
			};
			return new Response(null, response);
		} else if (request.url.endsWith("/getCurrentConnections")) {
			// Retrieves all currently connected websockets accepted via `acceptWebSocket()`.
			let numConnections: number = this.state.getWebSockets().length;
			if (numConnections == 1) {
				return new Response(
					`There is ${numConnections} WebSocket client connected to this Durable Object instance.`
				);
			}
			return new Response(
				`There are ${numConnections} WebSocket clients connected to this Durable Object instance.`
			);
		}

		// Unknown path, reply with usage info.
		return new Response(`
This Durable Object supports the following endpoints:
  /websocket
    - Creates a WebSocket connection. Any messages sent to it are echoed with a prefix.
  /getCurrentConnections
    - A regular HTTP GET endpoint that returns the number of currently connected WebSocket clients.
`);
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		// Upon receiving a message from the client, reply with the same message,
		// but will prefix the message with "[Durable Object]: ".
		this.state.getWebSockets().forEach((ws) => {
			ws.send(message);
		});
	}

	async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		wasClean: boolean
	) {
		// If the client closes the connection, the runtime will invoke the webSocketClose() handler.
		ws.close(code, "Durable Object is closing WebSocket");
	}
}
