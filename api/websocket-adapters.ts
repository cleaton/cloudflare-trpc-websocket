import { Socket } from "dog";
import { Environment } from "./types";

export class WebSocketWrapper {
	private socket: Socket
    public readonly env: Environment
	private eventHandlers: Map<string, (string) => {}>
	private onceHandlers: Map<string, (...args) => {}>
	constructor(socket: Socket, env: Environment) {
		this.socket = socket;
        this.env = env;
	}

	public on(event: string, callback: (string) => {}) {
		this.eventHandlers.set(event, callback)
	}
	public once(event: string, callback: (...args) => {}) {
		this.onceHandlers.set(event, callback)
	}
	public handle_message(data: string) {
		console.log(`handle message ${data} for connection ${this.socket.uid}`)
		this.eventHandlers.get('message')?.apply(undefined, [data])
	}

	public handle_close() {
		this.eventHandlers.get('close')?.apply(undefined);
		const once = this.onceHandlers.get('close');
		if (once) {
			once()
			this.onceHandlers.delete('close')
		}
	}

	public close(code?: any, reason?: any) {
		this.socket.close(code, reason)
	}

	public get readyState(): number {
		return 1
	}
	public send(message: any) {
		this.socket.send(message)
	}

}

export class WsServer {
	private sockets: Map<Socket, WebSocketWrapper> = new Map();
	private connectionCallback?: (ws: WebSocketWrapper, req: Request) => void
	constructor() {}
	public on(event: string, handler: (ws: WebSocketWrapper, req: Request) => void) {
		if (event === 'connection') {
			this.connectionCallback = handler
		}
	}
	public addSocket(socket: Socket, req: Request, env: Environment) {
		const wrap = new WebSocketWrapper(socket, env)
		this.sockets.set(socket, wrap);
		this.connectionCallback(wrap, req)
	}

	public removeSocket(socket: Socket) {
		this.sockets.delete(socket);
	}

	public handle_close(socket: Socket) {
		this.sockets.get(socket)?.handle_close();
		this.removeSocket(socket);
	}

	public handle_message(socket: Socket, message: string) {
		this.sockets.get(socket)?.handle_message(message)
	}

	public get clients(): IterableIterator<WebSocketWrapper> {
		return this.sockets.values()
	}

}