import { Duplex } from "stream";
import { EventEmitter } from "events";

// 加载原生模块
const native = require("../index.node");

interface NativeUSocketWrap {
	// 构造函数，接收回调函数
	(callback: (event: string, data?: any) => void): NativeUSocketWrap;
	connect(path: string): number;
	get_pid(): number;
	adopt(fd: number): void;
	write(data?: Buffer, fds?: number[]): number | Error;
	read(size: number): { data: Buffer | null; fds: number[] };
	resume(): void;
	pause(): void;
	startPolling(): void;
	shutdown(): void;
	close(): void;
}

interface NativeUServerWrap {
	// 构造函数，接收回调函数
	(callback: (event: string, fd?: number) => void): NativeUServerWrap;
	listen(path: string, backlog: number): number;
	resume(): void;
	pause(): void;
	startAccepting(): void;
	close(): void;
}

export interface USocketOptions {
	fd?: number;
	path?: string;
	allowHalfOpen?: boolean;
}

export interface USocketWriteChunk {
	data?: Buffer;
	fds?: number[];
}

// USocket 事件类型
export interface USocketEvents {
	data: (data: Buffer, fds: number[]) => void;
	connect: () => void;
	end: () => void;
	close: () => void;
	error: (err: Error) => void;
	drain: () => void;
	finish: () => void;
}

// UServer 事件类型
export interface UServerEvents {
	connection: (socket: USocket) => void;
	listening: () => void;
	close: () => void;
	error: (err: Error) => void;
}

// USocket - 继承 Duplex 流
export class USocket extends Duplex {
	fd?: number;
	pid?: number;
	private _wrap: any = null;
	private _shutdownCalled: boolean = false;
	private _endReceived: boolean = false;
	private _drain: (() => void) | null = null;
	private _fds: number[] = [];

	constructor(opts?: USocketOptions | string) {
		super({ writableObjectMode: true });

		if (typeof opts === "string") {
			opts = { path: opts };
		}

		if (opts?.fd || opts?.path) {
			this.connect(opts);
		}
	}

	// 事件类型定义
	on<K extends keyof USocketEvents>(event: K, listener: USocketEvents[K]): this;
	on(event: string, listener: (...args: any[]) => void): this;
	on(event: string | symbol, listener: (...args: any[]) => void): this {
		return super.on(event, listener);
	}

	once<K extends keyof USocketEvents>(
		event: K,
		listener: USocketEvents[K],
	): this;
	once(event: string, listener: (...args: any[]) => void): this;
	once(event: string | symbol, listener: (...args: any[]) => void): this {
		return super.once(event, listener);
	}

	emit<K extends keyof USocketEvents>(
		event: K,
		...args: Parameters<USocketEvents[K]>
	): boolean;
	emit(event: string | symbol, ...args: any[]): boolean {
		return super.emit(event, ...args);
	}

	write(
		chunk: Buffer | Uint8Array | string | USocketWriteChunk,
		cb?: (error: Error | null | undefined) => void,
	): boolean;
	write(
		chunk: Buffer | Uint8Array | string | USocketWriteChunk,
		encoding: BufferEncoding,
		cb?: (error: Error | null | undefined) => void,
	): boolean;
	write(chunk: any, encoding?: any, cb?: any): boolean {
		return super.write(chunk, encoding, cb);
	}

	connect(opts: USocketOptions | string, cb?: () => void): void {
		if (this._wrap) {
			throw new Error("connect on already connected USocket");
		}

		if (typeof opts === "string") {
			opts = { path: opts };
		}

		if (typeof cb === "function") {
			this.once("connect", cb);
		}

		// 创建 wrap - 注意：native.USocketWrap 是一个函数，不是构造函数
		this._wrap = native.USocketWrap() as NativeUSocketWrap;
		this._shutdownCalled = false;
		this._endReceived = false;
		this._drain = null;
		this._fds = [];

		// 设置回调 - 使用包装函数以便重新设置
		this._setupCallback();

		if (typeof opts.fd === "number") {
			native.USocketWrap_adopt(this._wrap, opts.fd);
			this.fd = opts.fd;
			native.USocketWrap_start_polling(this._wrap);
			this._tryGetPid();
			// 立即触发 connect 事件
			process.nextTick(() => this.emit("connect"));
			return;
		}

		if (typeof opts.path !== "string") {
			throw new Error("USocket#connect expects string path");
		}

		const result = native.USocketWrap_connect(this._wrap, opts.path);
		this.fd = result;
		native.USocketWrap_start_polling(this._wrap);
		this._tryGetPid();
		// 立即触发 connect 事件
		process.nextTick(() => this.emit("connect"));
	}

	private _tryGetPid(): void {
		if (this._wrap) {
			try {
				this.pid = native.USocketWrap_get_pid(this._wrap);
			} catch (e) {
				// ignore error
			}
		}
	}

	private _setupCallback(): void {
		if (!this._wrap) return;
		native.USocketWrap_set_callback(this._wrap, this._wrapEvent.bind(this));
	}

	private _wrapEvent(event: string, data?: any, fds?: number[]): void {
		// 立即重新设置回调以支持多次触发
		if (this._wrap && event !== "end" && event !== "error") {
			try {
				native.USocketWrap_set_callback(this._wrap, this._wrapEvent.bind(this));
			} catch (e) {
				// wrap 可能已经被销毁，忽略错误
			}
		}

		if (event === "data") {
			// 有数据可读
			if (fds && fds.length > 0) {
				this._fds = this._fds.concat(fds);
			}

			if (data && Buffer.isBuffer(data) && data.length > 0) {
				// 触发 data 事件
				this.emit("data", data, fds || []);
			} else if (!data || (Buffer.isBuffer(data) && data.length === 0)) {
				if (!this._endReceived) {
					// 连接关闭
					this._endReceived = true;
					if (this._wrap) {
						native.USocketWrap_pause(this._wrap);
					}
					this.push(null);
					this._maybeClose();
				}
			}
		}

		if (event === "drain") {
			const d = this._drain;
			this._drain = null;
			if (d) d();
		}

		if (event === "end") {
			// 连接关闭
			if (!this._endReceived) {
				this._endReceived = true;
				if (this._wrap) {
					native.USocketWrap_pause(this._wrap);
				}
				this.push(null);
				this._maybeClose();
			}
		}

		if (event === "error") {
			this.emit("error", data);
		}
	}

	_read(size: number): void {
		if (this._wrap) {
			native.USocketWrap_resume(this._wrap);
		}
		// Duplex 要求返回 void，但我们不需要做任何事
	}

	_write(
		chunk: Buffer | { callback?: () => void; data: Buffer; fds?: number[] },
		encoding: string | null,
		callback: (err?: Error) => void,
	): void {
		if (!this._wrap) {
			callback(new Error("USocket not connected"));
			return;
		}

		let data: Buffer | undefined;
		let fds: number[] | undefined;
		let cb: (() => void) | undefined;

		if (Buffer.isBuffer(chunk)) {
			data = chunk;
		} else {
			cb = chunk.callback;
			data = chunk.data;
			fds = chunk.fds;
		}

		if (data && !Buffer.isBuffer(data)) {
			callback(new Error("USocket data needs to be a buffer"));
			return;
		}
		if (fds && !Array.isArray(fds)) {
			callback(new Error("USocket fds needs to be an array"));
			return;
		}
		if (cb && typeof cb !== "function") {
			callback(new Error("USocket write callback needs to be a function"));
			return;
		}
		if (!data && !fds) {
			callback(new Error("USocket write needs a data or fds"));
			return;
		}

		const r = native.USocketWrap_write(this._wrap, data, fds);
		if (r instanceof Error) {
			callback(r);
			return;
		}

		if (!data || r === data.length) {
			if (cb) cb();
			callback();
			return;
		}

		// 部分写入，等待 drain
		this._drain = this._write.bind(
			this,
			{ data: data.subarray(r), callback: cb ?? (() => {}), fds: fds },
			encoding,
			callback,
		);
	}

	read(size?: number, fdSize?: number | null): any {
		if (!this._wrap) return null;

		if (typeof fdSize === "undefined") {
			return super.read(size);
		}

		if (fdSize === null) {
			fdSize = this._fds.length;
		} else if (this._fds.length < fdSize) {
			return null;
		}

		const data = super.read(size);
		if (size && !data) return data;

		const fds = this._fds.splice(0, fdSize);
		return { data, fds };
	}

	end(
		data?: string | Buffer | (() => void),
		encoding?: BufferEncoding | (() => void),
		callback?: () => void,
	): this {
		// 处理不同的参数重载
		if (typeof data === "function") {
			callback = data;
			data = undefined;
			encoding = undefined;
		} else if (typeof encoding === "function") {
			callback = encoding;
			encoding = undefined;
		}

		super.end(data as any, encoding as any, callback as any);
		if (this._wrap) {
			this._shutdownCalled = true;
			native.USocketWrap_shutdown(this._wrap);
			this.read(0);
			this._maybeClose();
		}
		return this;
	}

	destroy(): this {
		if (!this._wrap) return this;
		native.USocketWrap_close(this._wrap);
		this._wrap = null;
		return this;
	}

	private _maybeClose(): void {
		if (!this._wrap || !this._shutdownCalled || !this._endReceived) {
			return;
		}
		this.destroy();
		this.emit("close");
	}
}

// UServer - 继承 EventEmitter
export class UServer extends EventEmitter {
	fd?: number;
	listening: boolean = false;
	paused: boolean = false;
	private _wrap: any = null;

	constructor() {
		super();
	}

	// 事件类型定义
	on<K extends keyof UServerEvents>(event: K, listener: UServerEvents[K]): this;
	on(event: string, listener: (...args: any[]) => void): this;
	on(event: string | symbol, listener: (...args: any[]) => void): this {
		return super.on(event, listener);
	}

	once<K extends keyof UServerEvents>(
		event: K,
		listener: UServerEvents[K],
	): this;
	once(event: string, listener: (...args: any[]) => void): this;
	once(event: string | symbol, listener: (...args: any[]) => void): this {
		return super.once(event, listener);
	}

	emit<K extends keyof UServerEvents>(
		event: K,
		...args: Parameters<UServerEvents[K]>
	): boolean;
	emit(event: string | symbol, ...args: any[]): boolean {
		return super.emit(event, ...args);
	}

	listen(path: string, backlog?: number, cb?: () => void): void;
	listen(path: { path: string; backlog?: number }, cb?: () => void): void;
	listen(path: string, cb?: () => void): void;
	listen(path: any, backlog?: any, cb?: any): void {
		if (this._wrap || this.listening) {
			throw new Error("listen on already listened UServer");
		}

		if (typeof path === "object") {
			backlog = path.backlog;
			path = path.path;
			cb = backlog;
		} else if (typeof backlog === "function") {
			cb = backlog;
			backlog = 0;
		}

		backlog = backlog || 16;

		if (typeof path !== "string") {
			throw new Error("UServer expects valid path");
		}

		if (typeof cb === "function") {
			this.once("listening", cb);
		}

		// 创建 wrap - 注意：native.UServerWrap 是一个函数，不是构造函数
		this._wrap = native.UServerWrap() as NativeUServerWrap;

		// 设置回调
		this._setupCallback();

		const result = native.UServerWrap_listen(this._wrap, path, backlog);
		this.fd = result;
		this.listening = true;
		this.emit("listening");

		native.UServerWrap_start_accepting(this._wrap);

		if (!this.paused) {
			this.resume();
		}
	}

	private _setupCallback(): void {
		if (!this._wrap) return;
		native.UServerWrap_set_callback(this._wrap, this._wrapEvent.bind(this));
	}

	private _wrapEvent(event: string, fd?: number): void {
		// 立即重新设置回调以支持多次触发
		// 只在 wrap 仍然有效时重新设置
		if (this._wrap) {
			try {
				native.UServerWrap_set_callback(this._wrap, this._wrapEvent.bind(this));
			} catch (e) {
				// wrap 可能已经被销毁，忽略错误
			}
		}

		if (event === "accept") {
			const socket = new USocket({ fd: fd! });
			this.emit("connection", socket);
		}

		if (event === "error") {
			this.emit("error", new Error(`Server error: ${fd}`));
		}
	}

	pause(): void {
		this.paused = true;
		if (this.listening && this._wrap) {
			native.UServerWrap_pause(this._wrap);
		}
	}

	resume(): void {
		this.paused = false;
		if (this.listening && this._wrap) {
			native.UServerWrap_resume(this._wrap);
		}
	}

	close(): void {
		if (!this._wrap) return;
		native.UServerWrap_close(this._wrap);
		this._wrap = null;
		this.listening = false;
		this.emit("close");
	}
}

export default {
	USocket,
	UServer,
};
